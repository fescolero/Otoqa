// New-ledger settlement generation (SHADOW).
//
// Keeps the new settlements + payItems ledger's period statements current, so
// the read adapter (settlementReads.ts) always has fresh data behind the
// feature flag. During the shadow phase it MIRRORS the legacy periods: for each
// non-finalized legacy settlement (which defines the org's current pay periods),
// it (re)aggregates the matching new-ledger settlement from payItems — picking
// up newly-landed leg/session earnings AND dual-written manual adjustments.
//
// Additive and shadow-only: it writes new-ledger settlements, never touches
// legacy tables or anything the dashboard reads until the flag is flipped.
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';

const GEN_USER = 'system:pay-engine-gen-cron';

export const tick = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Fan out per active org (mirrors settlementsCron's per-plan cadence).
    const orgs = new Set<string>();
    for (const p of await ctx.db.query('payPlans').collect()) {
      if (p.isActive) orgs.add(p.workosOrgId);
    }
    let i = 0;
    for (const orgId of orgs) {
      await ctx.scheduler.runAfter(i * 500, internal.payEngine.generationCron.processOrg, { workosOrgId: orgId });
      i++;
    }
    return null;
  },
});

export const processOrg = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    let i = 0;

    // Drivers — mirror non-finalized legacy driver periods.
    for (const status of ['DRAFT', 'PENDING'] as const) {
      const rows = await ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', status))
        .collect();
      for (const s of rows) {
        await ctx.scheduler.runAfter(i * 120, internal.payEngine.aggregateSettlement.aggregateDriverSettlement, {
          workosOrgId: args.workosOrgId,
          payeeId: s.driverId as string,
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          userId: GEN_USER,
        });
        i++;
      }
    }

    // Carriers — mirror non-finalized legacy carrier periods.
    for (const status of ['DRAFT', 'PENDING'] as const) {
      const rows = await ctx.db
        .query('carrierSettlements')
        .withIndex('by_org_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', status))
        .collect();
      for (const s of rows) {
        await ctx.scheduler.runAfter(i * 120, internal.payEngine.aggregateSettlement.aggregateCarrierSettlement, {
          workosOrgId: args.workosOrgId,
          payeeId: s.carrierPartnershipId as string,
          periodStart: s.periodStart,
          periodEnd: s.periodEnd,
          userId: GEN_USER,
        });
        i++;
      }
    }
    return null;
  },
});
