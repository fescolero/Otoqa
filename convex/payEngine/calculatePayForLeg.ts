// Convex wrapper for the pure calculatePay function.
//
// Thin layer that:
//   1. Reads the leg + load
//   2. For each payee, calls assembleCalculatePayInput() to build the
//      CalculatePayInput shape (shared with shadowValidate)
//   3. Calls the pure calculatePay() function
//   4. Voids prior unlocked payItems for (leg, payee) — append-only contract
//   5. Inserts the new PayItemSpecs as actual payItems rows
//
// Driver legs with leg.drivers[] (team) fan out one calc invocation per
// driver — each driver may be on a different profile, so we resolve and
// emit independently. Carrier legs (leg.carrierPartnershipId set) run a
// single calc invocation with payeeType='CARRIER'.
//
// Append-only contract: this mutation NEVER deletes payItems. Re-running
// marks prior unlocked rows isVoided=true with voidedByRunId pointing at
// this invocation, then inserts replacement rows. Locked rows survive
// untouched (manual edits aren't clobbered by recalc).

import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Id } from '../_generated/dataModel';
import { calculatePay } from './calculatePay';
import type { PayItemSpec, PayeeType } from './calculatePay';
import { assembleCalculatePayInput } from './assembleInput';
import { rawCents, rawMicroCents } from '../lib/money';

export const calculatePayForLeg = internalMutation({
  args: {
    legId: v.id('dispatchLegs'),
    userId: v.string(),
    // Latest-wins coalesce key. Upstream callers patch
    // leg.latestRecalcRequestedAt to this same value before scheduling;
    // if this job's timestamp is older than what's stored on the leg, a
    // newer recalc has been queued and our work would be immediately
    // stale — so exit early. Optional for backward compatibility with
    // any direct (non-cascade) callers that don't yet pass it.
    requestedAt: v.optional(v.number()),
  },
  handler: async (ctx, { legId, userId, requestedAt }) => {
    const runId = `recalc:${legId}:${Date.now()}`;
    const now = Date.now();

    // ---- 1. Load core context ----
    const leg = await ctx.db.get(legId);
    if (!leg) throw new Error(`calculatePayForLeg: leg ${legId} not found`);

    // ---- Latest-wins coalesce check ----
    // If a newer recalc has been queued for this leg, exit. This is the
    // primary defense against OCC collisions on payItems when assignment
    // flows cascade driver + carrier pay together.
    if (
      requestedAt !== undefined &&
      leg.latestRecalcRequestedAt !== undefined &&
      requestedAt < leg.latestRecalcRequestedAt
    ) {
      console.log(
        `[calculatePayForLeg] coalesce_skip legId=${legId} requestedAt=${requestedAt} latest=${leg.latestRecalcRequestedAt}`,
      );
      return {
        legId,
        emitted: 0,
        voided: 0,
        warnings: ['COALESCED_NEWER_PENDING'],
        runId,
      };
    }

    const load = await ctx.db.get(leg.loadId);
    if (!load) throw new Error(`calculatePayForLeg: load ${leg.loadId} not found`);

    const workosOrgId = load.workosOrgId;

    // ---- 2. Determine payees on this leg ----
    type PayeeWork = {
      payeeType: PayeeType;
      payeeId: string;
      splitBps: number;
    };
    const payees: PayeeWork[] = [];

    if (leg.carrierPartnershipId) {
      payees.push({ payeeType: 'CARRIER', payeeId: leg.carrierPartnershipId, splitBps: 10000 });
    } else if (leg.drivers && leg.drivers.length > 0) {
      for (const d of leg.drivers) {
        payees.push({ payeeType: 'DRIVER', payeeId: d.driverId, splitBps: d.splitBps });
      }
    } else if (leg.driverId) {
      payees.push({ payeeType: 'DRIVER', payeeId: leg.driverId, splitBps: 10000 });
    } else {
      return { legId, emitted: 0, voided: 0, warnings: ['LEG_UNASSIGNED'], runId };
    }

    // ---- 3. Per-payee loop ----
    const allWarnings: string[] = [];
    let totalEmitted = 0;
    let totalVoided = 0;

    for (const payee of payees) {
      const input = await assembleCalculatePayInput(
        ctx, leg, load, payee.payeeType, payee.payeeId, payee.splitBps,
      );

      const result = calculatePay(input);

      for (const w of result.warnings) {
        allWarnings.push(`${w.code}: ${w.message}`);
      }

      // Void prior unlocked payItems for this (leg, payee). by_load_payee
      // returns all payItems for the load; we filter in-code by legId.
      const priorItems = await ctx.db
        .query('payItems')
        .withIndex('by_load_payee', q =>
          q.eq('sourceRef.loadId', leg.loadId)
            .eq('payeeType', payee.payeeType)
            .eq('payeeId', payee.payeeId))
        .collect();
      for (const old of priorItems) {
        if (old.isVoided) continue;
        if (old.isLocked) continue;
        if (old.sourceRef.legId !== leg._id) continue;
        await ctx.db.patch(old._id, {
          isVoided: true,
          voidedAt: now,
          voidedByRunId: runId,
          voidReason: 'Recalculation',
          updatedAt: now,
          lastEditedBy: userId,
        });
        totalVoided++;
      }

      // Insert the freshly calculated payItems.
      for (const spec of result.payItems) {
        await ctx.db.insert('payItems', specToPayItemRow(spec, workosOrgId, userId, now));
        totalEmitted++;
      }
    }

    return { legId, emitted: totalEmitted, voided: totalVoided, warnings: allWarnings, runId };
  },
});

// ============================================================================
// SPEC → SCHEMA ROW
// ============================================================================
//
// PayItemSpec uses branded bigints (Cents/MicroCents) and plain strings for
// ids. The schema uses raw int64 (bigint) and Convex Id<> branded strings.
// This helper does the type-narrowing at the persistence boundary.

function specToPayItemRow(
  spec: PayItemSpec,
  workosOrgId: string,
  userId: string,
  now: number,
) {
  // Schema's sourceData is a discriminated union; produce the matching variant
  // shape based on spec.sourceData._variant.
  const sourceData = spec.sourceData._variant === 'EARNING'
    ? {
        _variant: 'EARNING' as const,
        ruleId: spec.sourceData.ruleId as Id<'payRules'>,
        profileIdSnapshot: spec.sourceData.profileIdSnapshot as Id<'payProfiles'>,
        triggerSnapshot: spec.sourceData.triggerSnapshot,
      }
    : {
        _variant: 'POST_CALC_ADJUSTMENT' as const,
        postCalcRuleName: spec.sourceData.postCalcRuleName,
        profileIdSnapshot: spec.sourceData.profileIdSnapshot as Id<'payProfiles'>,
      };

  return {
    workosOrgId,

    payeeType: spec.payeeType,
    payeeId: spec.payeeId,

    kind: spec.kind,
    componentId: spec.componentId as Id<'chargeComponents'>,

    lifecycleStatus: spec.lifecycleStatus,

    description: spec.description,
    quantity: spec.quantity,
    rateMicroCents: rawMicroCents(spec.rateMicroCents),
    amountCents: rawCents(spec.amountCents),
    currency: spec.currency,

    periodAnchorAt: spec.periodAnchorAt,
    settlementId: undefined,

    workJurisdiction: spec.workJurisdiction,

    sourceRef: {
      kind: spec.sourceRef.kind,
      id: spec.sourceRef.id,
      loadId: spec.sourceRef.loadId as Id<'loadInformation'> | undefined,
      legId: spec.sourceRef.legId as Id<'dispatchLegs'> | undefined,
    },

    sourceData,

    isLocked: false,
    isVoided: false,

    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  };
}
