// Pay-engine coverage backfill (migration tooling). Populates/refreshes payItems
// so the new ledger is complete and work-start anchored, in two paginated,
// self-rescheduling, staggered sweeps:
//
//   backfillLegPay     — re-runs calculatePayForLeg over completed legs. For
//                        carriers this fills/re-anchors mileage payItems; for
//                        drivers it VOIDS the now-stale per-leg hourly items
//                        (their rules are session-sourced, so the leg calc emits
//                        nothing). Idempotent (append-only / void-prior).
//   backfillSessionPay — runs calculatePayForSession over completed driver
//                        sessions, creating one shift payItem set each.
//
// Both are internal; run via `npx convex run` or schedule. Safe to re-run.
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';

const STAGGER_MS = 40;
const RECHUNK_GAP_MS = 2_000;

export const backfillLegPay = internalMutation({
  args: {
    workosOrgId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
    totalScheduled: v.optional(v.number()),
  },
  returns: v.object({ scheduledThisPage: v.number(), totalScheduled: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const numItems = args.batch ?? 100;
    const page = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .paginate({ cursor: args.cursor ?? null, numItems });

    let i = 0;
    for (const leg of page.page) {
      if (leg.status !== 'COMPLETED') continue;
      await ctx.scheduler.runAfter(i * STAGGER_MS, internal.payEngine.calculatePayForLeg.calculatePayForLeg, {
        legId: leg._id, userId: 'backfill',
      });
      i++;
    }
    const totalScheduled = (args.totalScheduled ?? 0) + i;
    if (!page.isDone) {
      await ctx.scheduler.runAfter(i * STAGGER_MS + RECHUNK_GAP_MS, internal.payEngine.backfill.backfillLegPay, {
        workosOrgId: args.workosOrgId, cursor: page.continueCursor, batch: numItems, totalScheduled,
      });
    }
    return { scheduledThisPage: i, totalScheduled, done: page.isDone };
  },
});

// When a rule's trigger source is moved from leg.* to session.*, every existing
// PER-LEG payItem emitted by that rule is stale (the rule now pays per shift via
// calculatePayForSession). The leg sweep only voids items on currently-COMPLETED
// legs, so items on legs that later changed status survive. This voids them
// directly by ruleId — surgical and status-independent. Idempotent.
export const voidStaleSessionRuleLegItems = internalMutation({
  args: {
    workosOrgId: v.string(),
    // Explicit allowlist. Omit to self-discover: every active rule whose
    // trigger source is session-scoped — a PER-LEG item referencing one is
    // stale by definition (the rule can only pay per shift now). Covers the
    // common migration of editing a rule's type from per-leg to per-shift
    // in place, which keeps the same ruleId.
    ruleIds: v.optional(v.array(v.string())),
    // Defaults to DRY-RUN — reports what it would void; pass dryRun:false to apply.
    dryRun: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    sessionRuleCount: v.number(),
    scanned: v.number(),
    stale: v.number(),
    voided: v.number(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;

    let ruleSet: Set<string>;
    if (args.ruleIds && args.ruleIds.length > 0) {
      ruleSet = new Set(args.ruleIds);
    } else {
      ruleSet = new Set();
      const profiles = await ctx.db
        .query('payProfiles')
        .withIndex('by_org_active', (q) => q.eq('workosOrgId', args.workosOrgId).eq('isActive', true))
        .collect();
      for (const p of profiles) {
        const rules = await ctx.db
          .query('payRules')
          .withIndex('by_profile_active', (q) => q.eq('profileId', p._id).eq('isActive', true))
          .collect();
        for (const r of rules) {
          if (r.trigger.source.startsWith('session.')) ruleSet.add(r._id);
        }
      }
    }

    const items = await ctx.db
      .query('payItems')
      .withIndex('by_org_lifecycle', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('lifecycleStatus', 'APPLIED').eq('isVoided', false),
      )
      .collect();
    const now = Date.now();
    let stale = 0;
    let voided = 0;
    for (const it of items) {
      if (it.isLocked) continue;
      if (!it.sourceRef.legId) continue; // only per-leg items
      const sd = it.sourceData;
      const ruleId = sd && sd._variant === 'EARNING' ? sd.ruleId : null;
      if (ruleId && ruleSet.has(ruleId)) {
        stale++;
        if (!dryRun) {
          await ctx.db.patch(it._id, { isVoided: true, voidedAt: now, voidReason: 'rule moved to session source', updatedAt: now });
          voided++;
        }
      }
    }
    return { dryRun, sessionRuleCount: ruleSet.size, scanned: items.length, stale, voided };
  },
});

/**
 * Void STALE leg-scoped earning payItems — orphans left by a superseded pay
 * profile config (e.g. a driver's per-mile rule that was removed when they moved
 * to session/hourly pay). Unlike voidStaleSessionRuleLegItems (which took an
 * explicit ruleId allowlist), this self-determines staleness: a live, unlocked,
 * leg-scoped EARNING item is KEPT only if a currently-active rule that is
 * assigned to that exact payee would still produce it — otherwise it's voided.
 * Never touches locked (reviewer-edited), session, or non-earning items, and
 * never touches items backed by a live rule (rate drift is a recalc concern,
 * not staleness). Defaults to DRY-RUN — pass dryRun:false to actually void.
 */
export const voidStaleLegItems = internalMutation({
  args: { workosOrgId: v.string(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;

    // 1. Active profiles per payee (key `${payeeType}:${payeeId}`).
    const assignments = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_org_payee', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    const payeeProfiles = new Map<string, Set<string>>();
    for (const a of assignments) {
      if (!a.isActive) continue;
      const k = `${a.payeeType}:${a.payeeId}`;
      let set = payeeProfiles.get(k);
      if (!set) { set = new Set(); payeeProfiles.set(k, set); }
      set.add(a.profileId);
    }

    // 2. Active rule -> its profile.
    const profiles = await ctx.db
      .query('payProfiles')
      .withIndex('by_org_active', (q) => q.eq('workosOrgId', args.workosOrgId).eq('isActive', true))
      .collect();
    const ruleProfile = new Map<string, string>();
    for (const p of profiles) {
      const rules = await ctx.db
        .query('payRules')
        .withIndex('by_profile_active', (q) => q.eq('profileId', p._id).eq('isActive', true))
        .collect();
      for (const r of rules) ruleProfile.set(r._id, p._id);
    }

    // 3. Scan live, unlocked, leg-scoped EARNING items.
    const items = await ctx.db
      .query('payItems')
      .withIndex('by_org_lifecycle', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('lifecycleStatus', 'APPLIED').eq('isVoided', false),
      )
      .collect();
    const now = Date.now();
    let scanned = 0;
    let voided = 0;
    const byDesc = new Map<string, { count: number; sumCents: bigint }>();
    const scannedByPayeeType: Record<string, number> = {};
    const keptByPayeeType: Record<string, number> = {};
    for (const it of items) {
      if (it.isLocked) continue;
      if (!it.sourceRef.legId) continue;
      const sd = it.sourceData;
      if (!sd || sd._variant !== 'EARNING') continue;
      scanned++;
      scannedByPayeeType[it.payeeType] = (scannedByPayeeType[it.payeeType] ?? 0) + 1;

      const profId = ruleProfile.get(sd.ruleId);
      const payeeKey = `${it.payeeType}:${it.payeeId}`;
      const stillProduced = profId != null && (payeeProfiles.get(payeeKey)?.has(profId) ?? false);
      if (stillProduced) { keptByPayeeType[it.payeeType] = (keptByPayeeType[it.payeeType] ?? 0) + 1; continue; } // backed by a live rule assigned to this payee — keep

      const label = it.description.split(/[-—–]/)[0].trim().replace(/[^\x20-\x7E]/g, '') || 'other';
      const agg = byDesc.get(label) ?? { count: 0, sumCents: BigInt(0) };
      agg.count++; agg.sumCents += it.amountCents; byDesc.set(label, agg);
      if (!dryRun) {
        await ctx.db.patch(it._id, {
          isVoided: true, voidedAt: now,
          voidReason: 'stale: no active rule/assignment produces this leg item', updatedAt: now,
        });
        voided++;
      }
    }

    return {
      dryRun,
      scannedLegEarnings: scanned,
      scannedByPayeeType,
      keptByPayeeType,
      staleCount: [...byDesc.values()].reduce((a, b) => a + b.count, 0),
      voided,
      byDescription: [...byDesc.entries()].map(([label, v2]) => ({
        label, count: v2.count, sumUsd: Math.round((Number(v2.sumCents) / 100) * 100) / 100,
      })),
    };
  },
});

export const backfillSessionPay = internalMutation({
  args: {
    workosOrgId: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batch: v.optional(v.number()),
    totalScheduled: v.optional(v.number()),
  },
  returns: v.object({ scheduledThisPage: v.number(), totalScheduled: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const numItems = args.batch ?? 100;
    const page = await ctx.db
      .query('driverSessions')
      .withIndex('by_org_active', (q) => q.eq('organizationId', args.workosOrgId).eq('status', 'completed'))
      .paginate({ cursor: args.cursor ?? null, numItems });

    let i = 0;
    for (const s of page.page) {
      await ctx.scheduler.runAfter(i * STAGGER_MS, internal.payEngine.calculatePayForSession.calculatePayForSession, {
        sessionId: s._id, userId: 'backfill',
      });
      i++;
    }
    const totalScheduled = (args.totalScheduled ?? 0) + i;
    if (!page.isDone) {
      await ctx.scheduler.runAfter(i * STAGGER_MS + RECHUNK_GAP_MS, internal.payEngine.backfill.backfillSessionPay, {
        workosOrgId: args.workosOrgId, cursor: page.continueCursor, batch: numItems, totalScheduled,
      });
    }
    return { scheduledThisPage: i, totalScheduled, done: page.isDone };
  },
});
