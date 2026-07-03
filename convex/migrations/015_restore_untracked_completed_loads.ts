import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { updateLoadCount } from '../stats_helpers';

/**
 * One-off: restore loads that a stale-load sweep wrongly pushed to `Expired`
 * even though they ran (they carry a finalized invoice).
 *
 * Background: `autoExpireStaleLoads` (starting 2026-03-17) expired essentially
 * the whole load book because operational tracking (dispatch / completion) was
 * never performed — yet the loads had been invoiced and paid. The revenue was
 * recovered separately by re-anchoring invoices (migration 014); this migration
 * corrects the *load* records so the operational view matches reality.
 *
 * A load is treated as "ran, restore it" when:
 *   - status === 'Expired'
 *   - it has at least one FINALIZED invoice (BILLED / PENDING_PAYMENT / PAID)
 * Expired loads with no finalized invoice are left alone (possibly genuinely
 * un-run) and counted under skippedNoInvoice.
 *
 * Per restored load (mirrors the Completed branch of the status-change helper
 * in convex/loads.ts, but stamps a historically-honest delivery date):
 *   - status        -> 'Completed'
 *   - trackingStatus-> 'Completed'
 *   - deliveredAt   -> Date.parse(firstStopDate)  (the run date, NOT now;
 *                      falls back to now only if firstStopDate is unparseable)
 *   - carrier assignments AWARDED/IN_PROGRESS -> COMPLETED
 *   - dispatch legs not already COMPLETED/CANCELED -> COMPLETED
 *     (data_hygiene-CANCELED legs from the expire cascade are LEFT canceled)
 *   - organizationStats.loadCounts adjusted via updateLoadCount
 *
 * Does NOT touch invoices (no side-effect regenerates them on Completed) and
 * does NOT regenerate driver/carrier payables — the cost side is a separate
 * pay-engine backfill.
 *
 * After the real run, refresh the second count cache + verify:
 *   npx convex run loadStatusCounts:rebuildOrg '{"workosOrgId":"org_..."}'
 *   npx convex run loadStatusCounts:compareToOrgStats '{"workosOrgId":"org_..."}'
 *
 * Paginated over the by_organization index — its keys (workosOrgId,
 * _creationTime) are immutable, so patching `status` mid-run cannot shift the
 * cursor or skip loads. Drive by feeding nextCursor back until isDone.
 *
 *   # dry run (no writes):
 *   npx convex run migrations/015_restore_untracked_completed_loads:run \
 *     '{"workosOrgId":"org_...","dryRun":true}'
 *   # ...then chain {cursor} until isDone with dryRun:false
 */

const FINALIZED = new Set(['BILLED', 'PENDING_PAYMENT', 'PAID']);

export const run = internalMutation({
  args: {
    workosOrgId: v.string(),
    dryRun: v.boolean(),
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const batchSize = args.batchSize ?? (args.dryRun ? 1500 : 100);

    const page = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let expiredScanned = 0;
    let restored = 0;
    let skippedNoInvoice = 0;
    let noFirstStopDate = 0;
    const byServiceMonth: Record<string, number> = {};

    for (const load of page.page) {
      if (load.status !== 'Expired') continue;
      expiredScanned++;

      const invs = await ctx.db
        .query('loadInvoices')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      if (!invs.some((i) => FINALIZED.has(i.status))) {
        skippedNoInvoice++;
        continue;
      }

      const fsd = load.firstStopDate;
      const parsed = fsd ? Date.parse(fsd) : NaN;
      const deliveredAt = Number.isNaN(parsed) ? now : parsed;
      if (Number.isNaN(parsed)) noFirstStopDate++;

      const mk = fsd ? fsd.slice(0, 7) : 'NO_DATE';
      byServiceMonth[mk] = (byServiceMonth[mk] ?? 0) + 1;

      if (!args.dryRun) {
        await ctx.db.patch(load._id, {
          status: 'Completed',
          trackingStatus: 'Completed',
          deliveredAt,
          updatedAt: now,
        });
        await updateLoadCount(ctx, load.workosOrgId, 'Expired', 'Completed');

        const cas = await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();
        for (const ca of cas) {
          if (ca.status === 'AWARDED' || ca.status === 'IN_PROGRESS') {
            await ctx.db.patch(ca._id, {
              status: 'COMPLETED' as const,
              completedAt: now,
              paymentStatus: ca.paymentStatus ?? ('PENDING' as const),
            });
          }
        }

        const legs = await ctx.db
          .query('dispatchLegs')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();
        for (const leg of legs) {
          if (leg.status !== 'COMPLETED' && leg.status !== 'CANCELED') {
            await ctx.db.patch(leg._id, { status: 'COMPLETED' as const, updatedAt: now });
          }
        }
      }
      restored++;
    }

    return {
      scanned: page.page.length,
      expiredScanned,
      restored,
      skippedNoInvoice,
      noFirstStopDate,
      byServiceMonth,
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});
