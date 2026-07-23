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
//
// Completed-work gate: items are only WRITTEN once the leg is COMPLETED —
// and driver items also wait for the leg's shift (leg.sessionId) to end,
// so settlements never show pay for work not yet done. Because of this,
// every code path that completes a leg or ends a session must schedule a
// recalc (see legRecalc.scheduleLegPayRecalc / endSessionInternal).

import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import { calculatePay } from './calculatePay';
import type { PayItemSpec, PayeeType } from './calculatePay';
import { assembleCalculatePayInput } from './assembleInput';
import { makeForwardAnchorResolver } from './periodAnchor';
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

    // ---- 3. Completed-work gate ----
    // The recalc cascade prices legs on assignment, which put money on
    // accruing settlements for loads that hadn't run yet. Items are only
    // written for work actually done:
    //   - leg not COMPLETED → no items (PENDING / ACTIVE / CANCELED);
    //   - DRIVER items additionally wait for the leg's shift to close
    //     (leg.sessionId still 'active'), so a shift's session layers and
    //     its loads' premium lines land on the settlement together —
    //     endSessionInternal re-schedules this calc for every leg of the
    //     shift when it ends. Legs with no session (non-clocking drivers,
    //     historical rows) pay out on completion.
    // A gated run still voids prior unlocked items: that cleans up rows
    // written before the gate existed and handles status rollbacks
    // (unassign, cancel). Locked reviewer edits survive, as everywhere.
    const legIncomplete = leg.status !== 'COMPLETED';
    let shiftOpen = false;
    if (!legIncomplete && leg.sessionId && payees.some((p) => p.payeeType === 'DRIVER')) {
      const session = await ctx.db.get(leg.sessionId);
      shiftOpen = session?.status === 'active';
    }

    // ---- 4. Per-payee loop ----
    const allWarnings: string[] = [];
    let totalEmitted = 0;
    let totalVoided = 0;

    for (const payee of payees) {
      const deferReason = legIncomplete
        ? 'leg not completed'
        : shiftOpen && payee.payeeType === 'DRIVER'
          ? 'shift still open'
          : null;

      let specs: PayItemSpec[] = [];
      if (!deferReason) {
        const input = await assembleCalculatePayInput(
          ctx, leg, load, payee.payeeType, payee.payeeId, payee.splitBps,
        );

        const result = calculatePay(input);

        for (const w of result.warnings) {
          allWarnings.push(`${w.code}: ${w.message}`);
        }
        specs = result.payItems;
      }

      // Void prior unlocked payItems for this (leg, payee). by_load_payee
      // returns all payItems for the load; we filter in-code by legId.
      // LOCKED rows survive (reviewer edits / approval freeze) — collect the
      // earning ones by ruleId so their fresh specs are suppressed below
      // (edit-wins, no double-pay — mirrors calculatePayForSession).
      const priorItems = await ctx.db
        .query('payItems')
        .withIndex('by_load_payee', q =>
          q.eq('sourceRef.loadId', leg.loadId)
            .eq('payeeType', payee.payeeType)
            .eq('payeeId', payee.payeeId))
        .collect();
      const lockedByRule = new Map<string, Doc<'payItems'>>();
      for (const old of priorItems) {
        if (old.isVoided) continue;
        if (old.sourceRef.legId !== leg._id) continue;
        if (old.isLocked) {
          if (old.sourceData?._variant === 'EARNING') lockedByRule.set(old.sourceData.ruleId, old);
          continue;
        }
        await ctx.db.patch(old._id, {
          isVoided: true,
          voidedAt: now,
          voidedByRunId: runId,
          voidReason: deferReason ? `Deferred: ${deferReason}` : 'Recalculation',
          updatedAt: now,
          lastEditedBy: userId,
        });
        totalVoided++;
      }

      // Insert the freshly calculated payItems. Anchors roll forward past a
      // FINALIZED period (periodAnchor.ts): a deferred item released after
      // its period's statement was approved lands on the payee's next open
      // statement instead of orphaning on none.
      const resolveAnchor = specs.length
        ? await makeForwardAnchorResolver(ctx, payee.payeeType, payee.payeeId)
        : null;
      for (const spec of specs) {
        const ruleId = spec.sourceData._variant === 'EARNING' ? spec.sourceData.ruleId : undefined;
        const locked = ruleId ? lockedByRule.get(ruleId) : undefined;
        if (locked) {
          // Edit wins — no duplicate row. Maintain the drift flag for edited
          // rows (reviewerEdit.engineAmountCents → the "rules changed" flag).
          if (locked.reviewerEdit) {
            const engineAmount = rawCents(spec.amountCents);
            if (locked.amountCents !== engineAmount) {
              await ctx.db.patch(locked._id, {
                reviewerEdit: { ...locked.reviewerEdit, engineAmountCents: engineAmount, engineDivergedAt: now },
                updatedAt: now,
              });
            } else if (locked.reviewerEdit.engineAmountCents != null) {
              await ctx.db.patch(locked._id, {
                reviewerEdit: { ...locked.reviewerEdit, engineAmountCents: undefined, engineDivergedAt: undefined },
                updatedAt: now,
              });
            }
          }
          continue;
        }
        const { anchor } = resolveAnchor!(spec.periodAnchorAt, now);
        await ctx.db.insert('payItems', {
          ...specToPayItemRow(spec, workosOrgId, userId, now),
          periodAnchorAt: anchor,
        });
        totalEmitted++;
      }
    }

    if (legIncomplete) allWarnings.push('DEFERRED_LEG_NOT_COMPLETED');
    else if (shiftOpen) allWarnings.push('DEFERRED_SHIFT_OPEN');

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

export function specToPayItemRow(
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
      sessionId: spec.sourceRef.sessionId as Id<'driverSessions'> | undefined,
    },

    sourceData,

    isLocked: false,
    isVoided: false,

    createdAt: now,
    updatedAt: now,
    createdBy: userId,
  };
}
