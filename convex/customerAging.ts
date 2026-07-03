/**
 * Per-customer A/R aging materialization.
 *
 * Paginates all outstanding (BILLED + PENDING_PAYMENT) invoices, accumulates
 * each customer's unpaid balance + count per invoice-month, and writes ONE
 * `customerAgingSnapshots` row per org (a compact JSON map). The read path
 * (accountingReports.getAgingByCustomer) buckets those per-period balances into
 * aging tiers live, so the per-customer table is uncapped and never scans
 * invoices at query time.
 *
 * Maintained by the daily recalc (recalculateOrgAccountingStats), like the
 * org-level accountingPeriodStats — aging is inherently a daily snapshot, so a
 * per-invoice live path isn't needed here.
 */

import { internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { v } from 'convex/values';
import { getPeriodKey } from './accountingStatsHelpers';

const OUTSTANDING_STATUSES = ['BILLED', 'PENDING_PAYMENT'] as const;
const BATCH_SIZE = 500;

// Accumulator carried across continuations: customerId -> periodKey -> [balance, count].
type Acc = Record<string, Record<string, [number, number]>>;

/** Kick off a fresh recompute for one org. */
export const startCustomerAging = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.customerAging.recalcCustomerAging, {
      workosOrgId: args.workosOrgId,
      statusIndex: 0,
      cursor: null,
      acc: JSON.stringify({}),
    });
    return null;
  },
});

export const recalcCustomerAging = internalMutation({
  args: {
    workosOrgId: v.string(),
    statusIndex: v.number(),
    cursor: v.union(v.string(), v.null()),
    acc: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const acc: Acc = JSON.parse(args.acc);
    const status = OUTSTANDING_STATUSES[args.statusIndex];

    const res = await ctx.db
      .query('loadInvoices')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', status))
      .paginate({ numItems: BATCH_SIZE, cursor: args.cursor });

    for (const inv of res.page) {
      const balance = Math.max(0, (inv.totalAmount ?? 0) - (inv.paidAmount ?? 0));
      if (balance <= 0.005) continue;
      const period = getPeriodKey(inv.invoiceDateNumeric ?? inv.createdAt);
      const cust = inv.customerId as string;
      const byPeriod = acc[cust] ?? (acc[cust] = {});
      const cell = byPeriod[period] ?? [0, 0];
      cell[0] += balance;
      cell[1] += 1;
      byPeriod[period] = cell;
    }

    if (!res.isDone) {
      await ctx.scheduler.runAfter(0, internal.customerAging.recalcCustomerAging, {
        ...args,
        cursor: res.continueCursor,
        acc: JSON.stringify(acc),
      });
      return null;
    }
    const nextStatus = args.statusIndex + 1;
    if (nextStatus < OUTSTANDING_STATUSES.length) {
      await ctx.scheduler.runAfter(0, internal.customerAging.recalcCustomerAging, {
        ...args,
        statusIndex: nextStatus,
        cursor: null,
        acc: JSON.stringify(acc),
      });
      return null;
    }

    // Done — overwrite the single snapshot row for this org.
    const now = Date.now();
    const data = JSON.stringify(acc);
    const existing = await ctx.db
      .query('customerAgingSnapshots')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { data, lastRecalculated: now, updatedAt: now });
    } else {
      await ctx.db.insert('customerAgingSnapshots', {
        workosOrgId: args.workosOrgId,
        data,
        lastRecalculated: now,
        updatedAt: now,
      });
    }
    console.log(
      `[customer-aging] org=${args.workosOrgId} customers=${Object.keys(acc).length} bytes=${data.length}`,
    );
    return null;
  },
});
