// Convex wrapper for session/shift pay (NEW engine). Mirrors calculatePayForLeg
// but scoped to a completed driver session: assembles the driver's profiles/
// rules/components, runs the pure calculateSessionPay (which evaluates only
// `session.*`-sourced rules), and writes ONE payItem per shift, idempotent via
// the by_session index (append-only / void-prior, locked rows survive).
//
// Shadow phase: fired from endSessionInternal ALONGSIDE legacy paySession; the
// new payItems are validated against the legacy session loadPayables, not yet
// the source of truth.
import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import {
  calculateSessionPay,
  type PayProfile,
  type PayRule,
  type ProfileAssignment,
  type ChargeComponentLite,
} from './calculatePay';
import { specToPayItemRow } from './calculatePayForLeg';
import { asMicroCents, asCents, rawCents } from '../lib/money';

export const calculatePayForSession = internalMutation({
  args: { sessionId: v.id('driverSessions'), userId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const session = await ctx.db.get(args.sessionId);
    if (!session) return { skipped: 'no-session' as const };
    if (session.status !== 'completed') return { skipped: 'not-completed' as const };
    if (!session.driverId) return { skipped: 'no-driver' as const };

    const driverId = session.driverId as string;
    const startedAt = session.startedAt;
    const activeMinutes =
      session.totalActiveMinutes ??
      (session.endedAt !== undefined ? Math.round((session.endedAt - session.startedAt) / 60_000) : 0);

    // 1. Assemble payee-scoped profiles / rules / components (mirror assembleInput).
    const assignments = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_payee_active', (q) =>
        q.eq('payeeType', 'DRIVER').eq('payeeId', driverId).eq('isActive', true),
      )
      .collect();

    const profiles = new Map<string, PayProfile>();
    // Candidate set: assigned profiles PLUS the shift override target (the
    // override may point at a profile the driver isn't assigned to — that's
    // its purpose). Rules/components below are collected per profiles-map key,
    // so adding it here is what makes the override's rules calculable.
    const candidateProfileIds = assignments.map((a) => a.profileId as Id<'payProfiles'>);
    if (session.payProfileOverrideId) candidateProfileIds.push(session.payProfileOverrideId);
    for (const pid of candidateProfileIds) {
      if (profiles.has(pid)) continue;
      const p = await ctx.db.get(pid);
      if (!p) continue;
      profiles.set(p._id, {
        _id: p._id, workosOrgId: p.workosOrgId, name: p.name, payeeType: p.payeeType as 'DRIVER' | 'CARRIER',
        currency: p.currency, country: p.country, state: p.state, contractTag: p.contractTag,
        postCalcRules: undefined, isDefault: p.isDefault, isActive: p.isActive,
      });
    }

    const rules: PayRule[] = [];
    for (const pid of profiles.keys()) {
      const prs = await ctx.db
        .query('payRules')
        .withIndex('by_profile_active', (q) => q.eq('profileId', pid as Id<'payProfiles'>).eq('isActive', true))
        .collect();
      for (const r of prs) {
        rules.push({
          _id: r._id, profileId: r.profileId, name: r.name, componentId: r.componentId, trigger: r.trigger,
          rateAmountMicroCents: r.rateAmountMicroCents !== undefined ? asMicroCents(r.rateAmountMicroCents) : undefined,
          tieredRate: r.tieredRate?.map((t) => ({ minQty: t.minQty, maxQty: t.maxQty, rateMicroCents: asMicroCents(t.rateMicroCents) })),
          minThreshold: r.minThreshold, maxCap: r.maxCap,
          minAmountCents: r.minAmountCents !== undefined ? asCents(r.minAmountCents) : undefined,
          maxAmountCents: r.maxAmountCents !== undefined ? asCents(r.maxAmountCents) : undefined,
          equipmentTypeCondition: r.equipmentTypeCondition, customerCondition: r.customerCondition,
          isActive: r.isActive, sortOrder: r.sortOrder,
        });
      }
    }

    const components = new Map<string, ChargeComponentLite>();
    for (const r of rules) {
      const key = r.componentId as string;
      if (components.has(key)) continue;
      const c = await ctx.db.get(r.componentId as Id<'chargeComponents'>);
      if (c) components.set(c._id, { _id: c._id, code: c.code, bucket: c.bucket, sign: c.sign });
    }

    const calcAssignments: ProfileAssignment[] = assignments.map((a) => ({
      payeeType: 'DRIVER', payeeId: a.payeeId, profileId: a.profileId, isDefault: a.isDefault,
      selectionStrategy: a.selectionStrategy, thresholdValue: a.thresholdValue, matchState: a.matchState,
      matchContractTag: a.matchContractTag, effectiveStart: a.effectiveStart, effectiveEnd: a.effectiveEnd, isActive: a.isActive,
    }));

    // 1b. Off-load bookends for `session.bookendMinutes` rules: shift start →
    // first leg check-in, plus last leg checkout → shift end. Between-load
    // gaps are excluded by design. A shift with no checked-in legs is
    // entirely off-load.
    const sessionLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
    let firstCheckinAt: number | null = null;
    let lastCheckoutAt: number | null = null;
    for (const leg of sessionLegs) {
      if (leg.status === 'CANCELED') continue;
      if (leg.startedAt != null && (firstCheckinAt === null || leg.startedAt < firstCheckinAt)) {
        firstCheckinAt = leg.startedAt;
      }
      if (leg.endedAt != null && (lastCheckoutAt === null || leg.endedAt > lastCheckoutAt)) {
        lastCheckoutAt = leg.endedAt;
      }
    }
    const sessionEndedAt = session.endedAt ?? session.startedAt + activeMinutes * 60_000;
    const bookendMinutes =
      firstCheckinAt === null || lastCheckoutAt === null
        ? activeMinutes
        : Math.min(
            activeMinutes,
            Math.max(0, Math.round((firstCheckinAt - startedAt) / 60_000))
              + Math.max(0, Math.round((sessionEndedAt - lastCheckoutAt) / 60_000)),
          );

    // 2. Pure session calc.
    const result = calculateSessionPay({
      driverId, sessionId: args.sessionId as string,
      session: { activeMinutes, startedAt, payProfileOverrideId: session.payProfileOverrideId, bookendMinutes },
      profileAssignments: calcAssignments, profiles, rules, components,
    });

    // 3. Idempotent, EDIT-AWARE write.
    //   • Unlocked prior rows are voided and replaced (normal recalc).
    //   • LOCKED rows WIN and survive: a reviewer's correction is never voided
    //     and never duplicated. Indexed by the earning ruleId so the fresh
    //     spec for that rule is suppressed (no double-pay). For reviewer-edited
    //     rows, if the engine now computes a different amount we stamp the drift
    //     (reviewerEdit.engineAmountCents → the "rules changed" flag); if it
    //     converged back we clear the stale drift. This mirrors the legacy
    //     rulesAmount/rulesChangedAt behavior — edit-wins-over-recalc.
    const prior = await ctx.db
      .query('payItems')
      .withIndex('by_session', (q) => q.eq('sourceRef.sessionId', args.sessionId).eq('isVoided', false))
      .collect();

    const lockedByRule = new Map<string, Doc<'payItems'>>();
    for (const old of prior) {
      if (!old.isLocked) {
        await ctx.db.patch(old._id, { isVoided: true, voidedAt: now, voidReason: `superseded by session recalc`, updatedAt: now });
        continue;
      }
      // Locked → survives. Index earning lines by rule so we don't duplicate.
      if (old.sourceData?._variant === 'EARNING') lockedByRule.set(old.sourceData.ruleId, old);
    }

    // Mirror legacy paySession: an auto-timed-out shift is flagged so a reviewer
    // verifies the hours before approval (the raw active-minutes likely overstate
    // real worked time). This is the new ledger's equivalent of the legacy
    // warningMessage → loadpay blocker.
    const warning = session.endReason === 'auto_timeout'
      ? 'Session auto-timed out — verify hours before approval'
      : undefined;
    let inserted = 0;
    let driftFlagged = 0;
    for (const spec of result.payItems) {
      const ruleId = spec.sourceData._variant === 'EARNING' ? spec.sourceData.ruleId : undefined;
      const locked = ruleId ? lockedByRule.get(ruleId) : undefined;
      if (locked) {
        // Edit wins — no duplicate row. Maintain the drift flag for edited rows.
        if (locked.reviewerEdit) {
          const engineAmount = rawCents(spec.amountCents);
          if (locked.amountCents !== engineAmount) {
            await ctx.db.patch(locked._id, {
              reviewerEdit: { ...locked.reviewerEdit, engineAmountCents: engineAmount, engineDivergedAt: now },
              updatedAt: now,
            });
            driftFlagged++;
          } else if (locked.reviewerEdit.engineAmountCents != null) {
            await ctx.db.patch(locked._id, {
              reviewerEdit: { ...locked.reviewerEdit, engineAmountCents: undefined, engineDivergedAt: undefined },
              updatedAt: now,
            });
          }
        }
        continue;
      }
      await ctx.db.insert('payItems', { ...specToPayItemRow(spec, session.organizationId, args.userId ?? 'system', now), warning });
      inserted++;
    }

    return {
      driverId, activeMinutes, inserted, driftFlagged,
      selectedProfileId: result.selectedProfileId,
      warnings: result.warnings.length,
    };
  },
});
