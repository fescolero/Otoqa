import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';

/**
 * One-off backfill: stamp `invoiceDateNumeric` (the service-date reporting
 * anchor) onto finalized invoices that are missing it.
 *
 * Background: `invoiceDateNumeric` is normally set at finalization
 * (see resolveServiceAnchor / freeze paths in convex/invoices.ts) and drives
 * every service-date report query via the by_org_status_invoice_date index.
 * A population of historical invoices (org onboarding — bulk-created already
 * marked PAID, bypassing the finalize step) never received an anchor. Because
 * the report tabs filter on that index, these invoices are invisible in every
 * month; the nightly recalc (accountingStats.ts) falls back to `createdAt`,
 * so they also get mis-dated into their creation month on the trend chart.
 *
 * Observed footprint (org_01KAEYJHZNV9KQCXF9FN9N3CCY, 2026-07): ~6,649
 * finalized invoices, concentrated in Jan + Feb 2026 service months
 * (~$1.33M invoiced / ~$1.53M collected), plus ~184 zero-value Nov/Dec
 * stragglers. March onward is already correctly anchored.
 *
 * Fix per invoice: invoiceDateNumeric = Date.parse(load.firstStopDate)
 * — byte-for-byte the same computation resolveServiceAnchor uses. No money
 * fields are touched; this is pure date-stamping.
 *
 * After the backfill completes, run the org recalc so the materialized
 * accountingPeriodStats + customer aging snapshots rebuild from the corrected
 * anchors:
 *   npx convex run accountingStats:recalculateOrgAccountingStats \
 *     '{"workosOrgId":"org_..."}'
 *
 * Paginated + status-indexed continuation so each call stays well under the
 * per-mutation read/write ceiling. Drive it to completion by feeding
 * nextStatusIndex / nextCursor back in until isDone.
 *
 *   # dry run (no writes) — review counts first:
 *   npx convex run migrations/014_backfill_missing_invoice_anchor:run \
 *     '{"workosOrgId":"org_...","dryRun":true}'
 *   # ...then the same, chaining {statusIndex,cursor} until isDone, dryRun:false
 */

const FINALIZED_STATUSES = ['BILLED', 'PENDING_PAYMENT', 'PAID'] as const;

export const run = internalMutation({
  args: {
    workosOrgId: v.string(),
    dryRun: v.boolean(),
    statusIndex: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
    /** Index rows scanned per page. Real run defaults smaller to bound writes. */
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const statusIndex = args.statusIndex ?? 0;
    const batchSize = args.batchSize ?? (args.dryRun ? 1000 : 250);

    // Past the last status → nothing left to do.
    if (statusIndex >= FINALIZED_STATUSES.length) {
      return {
        status: null,
        scanned: 0,
        alreadyAnchored: 0,
        updated: 0,
        skippedNoLoad: 0,
        skippedNoFirstStop: 0,
        skippedUnparseable: 0,
        byServiceMonth: {},
        unanchoredCreatedRange: null,
        nextStatusIndex: statusIndex,
        nextCursor: null,
        isDone: true,
      };
    }

    const status = FINALIZED_STATUSES[statusIndex];

    // Scan by createdAt order; check the anchor in JS (a missing optional field
    // is best filtered in-handler rather than relying on index/filter shape).
    const page = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_created', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', status),
      )
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let alreadyAnchored = 0;
    let updated = 0;
    let skippedNoLoad = 0;
    let skippedNoFirstStop = 0;
    let skippedUnparseable = 0;
    const byServiceMonth: Record<string, { count: number; total: number; paid: number }> = {};
    let minCreated = Infinity;
    let maxCreated = -Infinity;

    for (const inv of page.page) {
      if (inv.invoiceDateNumeric !== undefined && inv.invoiceDateNumeric !== null) {
        alreadyAnchored++;
        continue;
      }

      const load = await ctx.db.get(inv.loadId);
      if (!load) {
        skippedNoLoad++;
        continue;
      }
      const fsd = (load as { firstStopDate?: string }).firstStopDate;
      if (!fsd) {
        skippedNoFirstStop++;
        continue;
      }
      const parsed = Date.parse(fsd);
      if (Number.isNaN(parsed)) {
        skippedUnparseable++;
        continue;
      }

      const mk = fsd.slice(0, 7);
      const b = (byServiceMonth[mk] ??= { count: 0, total: 0, paid: 0 });
      b.count++;
      b.total += inv.totalAmount ?? 0;
      b.paid += inv.paidAmount ?? 0;
      if (inv.createdAt < minCreated) minCreated = inv.createdAt;
      if (inv.createdAt > maxCreated) maxCreated = inv.createdAt;

      if (!args.dryRun) {
        await ctx.db.patch(inv._id, { invoiceDateNumeric: parsed });
      }
      updated++;
    }

    // Round money for readability.
    const svc: Record<string, { count: number; total: number; paid: number }> = {};
    for (const [k, val] of Object.entries(byServiceMonth)) {
      svc[k] = { count: val.count, total: Math.round(val.total), paid: Math.round(val.paid) };
    }

    // Advance: finish this status's pages, then step to the next status.
    let nextStatusIndex = statusIndex;
    let nextCursor: string | null = page.continueCursor;
    let isDone = false;
    if (page.isDone) {
      nextStatusIndex = statusIndex + 1;
      nextCursor = null;
      if (nextStatusIndex >= FINALIZED_STATUSES.length) isDone = true;
    }

    return {
      status,
      scanned: page.page.length,
      alreadyAnchored,
      updated,
      skippedNoLoad,
      skippedNoFirstStop,
      skippedUnparseable,
      byServiceMonth: svc,
      unanchoredCreatedRange:
        minCreated === Infinity
          ? null
          : [new Date(minCreated).toISOString(), new Date(maxCreated).toISOString()],
      nextStatusIndex,
      nextCursor,
      isDone,
    };
  },
});
