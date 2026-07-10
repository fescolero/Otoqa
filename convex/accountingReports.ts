/**
 * Accounting Reports Queries
 *
 * Read-only queries for the accounting reports dashboard.
 * Summary queries use pre-computed accountingPeriodStats (O(1) per month).
 * Detail queries use indexed pagination with in-memory enrichment.
 *
 * IMPORTANT: All queries must stay within the 4096 document read limit.
 * Strategy: use date-range index filtering, batch customer/load lookups via Maps,
 * cap results with .take(), and avoid unbounded .collect() where possible.
 */

import { action, internalQuery, query } from './_generated/server';
import { assertCallerOwnsOrg } from './lib/auth';
import { internal } from './_generated/api';
import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { Id, Doc } from './_generated/dataModel';
import {
  getEffectiveDueDate,
  getDaysOutstanding,
  getDaysToPayment,
  extractLaneLabel,
  estimateFuelCostForLoad,
} from './accountingHelpers';
import { getPeriodKey } from './accountingStatsHelpers';
import { getLoadFacets } from './lib/loadFacets';

// ============================================
// SHARED HELPERS
// ============================================

/** Batch-fetch customers by IDs, deduplicating reads via a Map */
async function batchFetchCustomers(
  ctx: { db: { get: (id: Id<'customers'>) => Promise<Doc<'customers'> | null> } },
  customerIds: Id<'customers'>[],
): Promise<Map<string, Doc<'customers'> | null>> {
  const unique = [...new Set(customerIds.map((id) => id.toString()))];
  const map = new Map<string, Doc<'customers'> | null>();
  for (const idStr of unique) {
    const doc = await ctx.db.get(idStr as Id<'customers'>);
    map.set(idStr, doc);
  }
  return map;
}

/** Batch-fetch loads by IDs, deduplicating reads via a Map */
async function batchFetchLoads(
  ctx: { db: { get: (id: Id<'loadInformation'>) => Promise<Doc<'loadInformation'> | null> } },
  loadIds: Id<'loadInformation'>[],
): Promise<Map<string, Doc<'loadInformation'> | null>> {
  const unique = [...new Set(loadIds.map((id) => id.toString()))];
  const map = new Map<string, Doc<'loadInformation'> | null>();
  for (const idStr of unique) {
    const doc = await ctx.db.get(idStr as Id<'loadInformation'>);
    map.set(idStr, doc);
  }
  return map;
}

// Max invoices to scan per status query to stay within read limits
const MAX_INVOICES_PER_STATUS = 1500;

// ============================================
// RECEIVABLES (A/R) QUERIES
// ============================================

/**
 * Get receivables summary: total invoiced, collected, outstanding, overdue, avg days to pay.
 * Also returns aging buckets (0-30, 31-60, 61-90, 90+ days).
 */
const AR_DAY_MS = 86_400_000;

/** UTC bounds + midpoint (ms) for a "YYYY-MM" period key. */
function periodKeyBounds(periodKey: string): { start: number; mid: number; end: number } | null {
  const [y, m] = periodKey.split('-').map(Number);
  if (!y || !m) return null;
  const start = Date.UTC(y, m - 1, 1);
  const end = Date.UTC(y, m, 1) - 1;
  const mid = Date.UTC(y, m - 1, 15);
  return { start, mid, end };
}

export const getReceivablesSummary = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const round = (n: number) => Math.round(n * 100) / 100;

    // ── Org-wide A/R: derive from the materialized accountingPeriodStats so we
    // never cap at MAX_INVOICES_PER_STATUS (the org has 20k+ finalized invoices,
    // which a .take() sample badly misrepresents). Everything is scoped to the
    // invoice months INSIDE the selected range (same period-key window as
    // getRevenueSummary) so the whole Overview responds consistently to the
    // filter. Aging is month-granular: each period's outstanding balance is aged
    // by the month's midpoint (capped at now so the current partial month lands
    // in "current"). The per-customer case falls through to the bounded
    // per-invoice scan below.
    if (!args.customerId) {
      const periods = await ctx.db
        .query('accountingPeriodStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
        .collect();

      const startKey = args.dateRangeStart !== undefined ? getPeriodKey(args.dateRangeStart) : undefined;
      const endKey = args.dateRangeEnd !== undefined ? getPeriodKey(args.dateRangeEnd) : undefined;

      let totalInvoiced = 0;
      let totalCollected = 0;
      let totalOutstanding = 0;
      let totalOverdue = 0;
      let overdueCount = 0;
      let outstandingCount = 0;
      let invoiceCount = 0;
      const agingBuckets = { current: 0, days31to60: 0, days61to90: 0, days90plus: 0 };

      for (const s of periods) {
        const bounds = periodKeyBounds(s.periodKey);
        if (!bounds) continue;

        // Only the invoice months within the selected range.
        if (startKey !== undefined && s.periodKey < startKey) continue;
        if (endKey !== undefined && s.periodKey > endKey) continue;

        totalInvoiced += s.totalInvoiced;
        totalCollected += s.totalCollected;
        invoiceCount += s.invoiceCount;

        const outstanding = s.totalOutstanding ?? 0;
        const count = s.outstandingCount ?? 0;
        totalOutstanding += outstanding;
        outstandingCount += count;

        const rep = Math.min(bounds.mid, now);
        const daysOut = Math.max(0, Math.floor((now - rep) / AR_DAY_MS));
        if (daysOut <= 30) {
          agingBuckets.current += outstanding;
        } else {
          totalOverdue += outstanding;
          overdueCount += count;
          if (daysOut <= 60) agingBuckets.days31to60 += outstanding;
          else if (daysOut <= 90) agingBuckets.days61to90 += outstanding;
          else agingBuckets.days90plus += outstanding;
        }
      }

      // Avg days-to-pay from a bounded PAID sample — an average is robust to
      // sampling, so the cap here doesn't distort the metric the way it does A/R.
      const paidSample = await ctx.db
        .query('loadInvoices')
        .withIndex('by_org_status_created', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID'))
        .order('desc')
        .take(MAX_INVOICES_PER_STATUS);
      let totalDays = 0;
      let paymentCount = 0;
      for (const inv of paidSample) {
        const days = getDaysToPayment(inv.invoiceDateNumeric ?? inv.createdAt, inv.paymentDate, inv.updatedAt);
        if (days !== null) {
          totalDays += days;
          paymentCount++;
        }
      }

      return {
        totalInvoiced: round(totalInvoiced),
        totalCollected: round(totalCollected),
        totalOutstanding: round(totalOutstanding),
        totalOverdue: round(totalOverdue),
        avgDaysToPay: paymentCount > 0 ? Math.round(totalDays / paymentCount) : null,
        avgDaysToPaySampleSize: paymentCount,
        overdueCount,
        invoiceCount,
        outstandingCount,
        agingBuckets: {
          current: round(agingBuckets.current),
          days31to60: round(agingBuckets.days31to60),
          days61to90: round(agingBuckets.days61to90),
          days90plus: round(agingBuckets.days90plus),
        },
      };
    }

    // Fetch outstanding invoices by SERVICE month (invoiceDateNumeric) — same
    // basis as the org-wide period stats above, so a customer-scoped A/R agrees
    // with the org-wide figure.
    const billedQuery = ctx.db.query('loadInvoices').withIndex('by_org_status_invoice_date', (q) => {
      const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'BILLED');
      if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
        return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
      if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
      if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
      return base;
    });
    const billedInvoices = await billedQuery.take(MAX_INVOICES_PER_STATUS);

    const pendingQuery = ctx.db.query('loadInvoices').withIndex('by_org_status_invoice_date', (q) => {
      const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING_PAYMENT');
      if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
        return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
      if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
      if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
      return base;
    });
    const pendingInvoices = await pendingQuery.take(MAX_INVOICES_PER_STATUS);

    let outstanding = [...billedInvoices, ...pendingInvoices];
    if (args.customerId) {
      outstanding = outstanding.filter((inv) => inv.customerId === args.customerId);
    }

    // Fetch PAID invoices for avg days calculation
    const paidQuery = ctx.db.query('loadInvoices').withIndex('by_org_status_invoice_date', (q) => {
      const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID');
      if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
        return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
      if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
      if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
      return base;
    });
    let paidInvoices = await paidQuery.take(MAX_INVOICES_PER_STATUS);
    if (args.customerId) {
      paidInvoices = paidInvoices.filter((inv) => inv.customerId === args.customerId);
    }

    // Batch-fetch customers for due date calculation
    const customerIds = [...new Set(outstanding.map((inv) => inv.customerId))];
    const customerMap = await batchFetchCustomers(ctx, customerIds);

    // Calculate totals and aging buckets
    let totalOutstanding = 0;
    let totalOverdue = 0;
    let overdueCount = 0;
    const agingBuckets = { current: 0, days31to60: 0, days61to90: 0, days90plus: 0 };

    for (const inv of outstanding) {
      const amount = inv.totalAmount ?? 0;
      totalOutstanding += amount;

      const customer = customerMap.get(inv.customerId.toString());
      const dueDate = getEffectiveDueDate(inv, customer ? { paymentTerms: (customer as any).paymentTerms } : null);
      const invoiceDate = inv.invoiceDateNumeric ?? inv.createdAt;
      const daysOut = getDaysOutstanding(invoiceDate);

      if (now > dueDate) {
        totalOverdue += amount;
        overdueCount++;
      }

      if (daysOut <= 30) agingBuckets.current += amount;
      else if (daysOut <= 60) agingBuckets.days31to60 += amount;
      else if (daysOut <= 90) agingBuckets.days61to90 += amount;
      else agingBuckets.days90plus += amount;
    }

    const totalPaid = paidInvoices.reduce((sum, inv) => sum + (inv.paidAmount ?? 0), 0);
    const totalInvoiced = totalOutstanding + totalPaid;

    // Average days to payment
    let totalDays = 0;
    let paymentCount = 0;
    for (const inv of paidInvoices) {
      const invoiceDate = inv.invoiceDateNumeric ?? inv.createdAt;
      const days = getDaysToPayment(invoiceDate, inv.paymentDate, inv.updatedAt);
      if (days !== null) {
        totalDays += days;
        paymentCount++;
      }
    }
    const avgDaysToPay = paymentCount > 0 ? Math.round(totalDays / paymentCount) : null;

    return {
      totalInvoiced: Math.round(totalInvoiced * 100) / 100,
      totalCollected: Math.round(totalPaid * 100) / 100,
      totalOutstanding: Math.round(totalOutstanding * 100) / 100,
      totalOverdue: Math.round(totalOverdue * 100) / 100,
      avgDaysToPay,
      avgDaysToPaySampleSize: paymentCount,
      overdueCount,
      invoiceCount: outstanding.length + paidInvoices.length,
      outstandingCount: outstanding.length,
      agingBuckets: {
        current: Math.round(agingBuckets.current * 100) / 100,
        days31to60: Math.round(agingBuckets.days31to60 * 100) / 100,
        days61to90: Math.round(agingBuckets.days61to90 * 100) / 100,
        days90plus: Math.round(agingBuckets.days90plus * 100) / 100,
      },
    };
  },
});

/**
 * Per-customer A/R aging roll-up. Powers the A/R aging view table so the client
 * never has to fetch every invoice row just to bucket by customer. Buckets are
 * measured from days outstanding; totals reconcile with getReceivablesSummary.
 */
export const getAgingByCustomer = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const round = (n: number) => Math.round(n * 100) / 100;

    // Org-wide (no single-customer filter): read the materialized snapshot so we
    // never cap at MAX_INVOICES_PER_STATUS. Buckets are computed live from each
    // customer's per-month balances; A/R is a balance "as of" the range end
    // (older unpaid periods still count), mirroring getReceivablesSummary.
    if (!args.customerId) {
      const snapshot = await ctx.db
        .query('customerAgingSnapshots')
        .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
        .first();
      const map: Record<string, Record<string, [number, number]>> = snapshot ? JSON.parse(snapshot.data) : {};

      // Scope to the invoice months within the selected range (same window as
      // getReceivablesSummary / getRevenueSummary) so the tab tracks the filter.
      const startKey = args.dateRangeStart !== undefined ? getPeriodKey(args.dateRangeStart) : undefined;
      const endKey = args.dateRangeEnd !== undefined ? getPeriodKey(args.dateRangeEnd) : undefined;

      const rows: Array<{
        customerId: string;
        current: number;
        days31to60: number;
        days61to90: number;
        days90plus: number;
        total: number;
        invoiceCount: number;
      }> = [];
      for (const [customerId, byPeriod] of Object.entries(map)) {
        const b = { current: 0, days31to60: 0, days61to90: 0, days90plus: 0, total: 0, invoiceCount: 0 };
        for (const [periodKey, cell] of Object.entries(byPeriod)) {
          const bounds = periodKeyBounds(periodKey);
          if (!bounds) continue;
          if (startKey !== undefined && periodKey < startKey) continue;
          if (endKey !== undefined && periodKey > endKey) continue;
          const [outstanding, count] = cell;
          const daysOut = Math.max(0, Math.floor((now - Math.min(bounds.mid, now)) / AR_DAY_MS));
          if (daysOut <= 30) b.current += outstanding;
          else if (daysOut <= 60) b.days31to60 += outstanding;
          else if (daysOut <= 90) b.days61to90 += outstanding;
          else b.days90plus += outstanding;
          b.total += outstanding;
          b.invoiceCount += count;
        }
        if (b.total > 0) rows.push({ customerId, ...b });
      }

      const customerMap = await batchFetchCustomers(
        ctx,
        rows.map((r) => r.customerId as Id<'customers'>),
      );
      return rows
        .map((r) => ({
          customerId: r.customerId,
          name: customerMap.get(r.customerId)?.name ?? 'Unknown',
          current: round(r.current),
          days31to60: round(r.days31to60),
          days61to90: round(r.days61to90),
          days90plus: round(r.days90plus),
          total: round(r.total),
          invoiceCount: r.invoiceCount,
        }))
        .sort((a, b) => b.total - a.total);
    }

    const statuses = ['BILLED', 'PENDING_PAYMENT'] as const;
    const all = [];
    for (const status of statuses) {
      const rows = await ctx.db
        .query('loadInvoices')
        .withIndex('by_org_status_invoice_date', (q) => {
          const base = q.eq('workosOrgId', args.workosOrgId).eq('status', status);
          if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
            return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
          if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
          if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
          return base;
        })
        .take(MAX_INVOICES_PER_STATUS);
      all.push(...rows);
    }
    const outstanding = args.customerId ? all.filter((inv) => inv.customerId === args.customerId) : all;

    // Group by customer with a per-bucket accumulator.
    type Bucket = { current: number; days31to60: number; days61to90: number; days90plus: number; total: number; invoiceCount: number };
    const byCustomer = new Map<string, Bucket>();
    for (const inv of outstanding) {
      const key = inv.customerId.toString();
      const amount = inv.totalAmount ?? 0;
      const invoiceDate = inv.invoiceDateNumeric ?? inv.createdAt;
      const daysOut = getDaysOutstanding(invoiceDate);
      const b =
        byCustomer.get(key) ??
        { current: 0, days31to60: 0, days61to90: 0, days90plus: 0, total: 0, invoiceCount: 0 };
      if (daysOut <= 30) b.current += amount;
      else if (daysOut <= 60) b.days31to60 += amount;
      else if (daysOut <= 90) b.days61to90 += amount;
      else b.days90plus += amount;
      b.total += amount;
      b.invoiceCount++;
      byCustomer.set(key, b);
    }

    const customerMap = await batchFetchCustomers(
      ctx,
      [...byCustomer.keys()].map((k) => k as Id<'customers'>),
    );

    return [...byCustomer.entries()]
      .map(([customerId, b]) => ({
        customerId,
        name: customerMap.get(customerId)?.name ?? 'Unknown',
        current: round(b.current),
        days31to60: round(b.days31to60),
        days61to90: round(b.days61to90),
        days90plus: round(b.days90plus),
        total: round(b.total),
        invoiceCount: b.invoiceCount,
      }))
      .filter((c) => c.total > 0)
      .sort((a, b) => b.total - a.total);
  },
});

/**
 * Get detail list of unpaid invoices with customer info, days outstanding, due date.
 * Capped at 200 results to stay within read limits.
 */
export const getReceivablesDetail = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
    overdueOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const MAX_DETAIL = 200;

    // Use the SERVICE-date range on index (consistent with the A/R summary).
    const billedInvoices = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_invoice_date', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'BILLED');
        if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
          return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
        if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
        return base;
      })
      .take(MAX_INVOICES_PER_STATUS);

    const pendingInvoices = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_invoice_date', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING_PAYMENT');
        if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
          return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
        if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
        return base;
      })
      .take(MAX_INVOICES_PER_STATUS);

    let invoices = [...billedInvoices, ...pendingInvoices];
    if (args.customerId) {
      invoices = invoices.filter((inv) => inv.customerId === args.customerId);
    }

    // Cap to max detail rows before enrichment to limit reads
    invoices = invoices.slice(0, MAX_DETAIL);

    // Batch-fetch all customers and loads needed
    const customerMap = await batchFetchCustomers(
      ctx,
      invoices.map((inv) => inv.customerId),
    );
    const loadMap = await batchFetchLoads(
      ctx,
      invoices.map((inv) => inv.loadId),
    );

    const enriched = [];
    for (const inv of invoices) {
      const customer = customerMap.get(inv.customerId.toString());
      const load = loadMap.get(inv.loadId.toString());

      const invoiceDate = inv.invoiceDateNumeric ?? inv.createdAt;
      const dueDate = getEffectiveDueDate(inv, customer ? { paymentTerms: (customer as any).paymentTerms } : null);
      const daysOutstanding = getDaysOutstanding(invoiceDate);
      const isOverdue = now > dueDate;

      if (args.overdueOnly && !isOverdue) continue;

      enriched.push({
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        customerName: customer?.name ?? 'Unknown Customer',
        customerId: inv.customerId,
        loadOrderNumber: load?.orderNumber ?? 'N/A',
        loadType: load?.loadType ?? 'UNMAPPED',
        amount: inv.totalAmount ?? 0,
        dueDate,
        daysOutstanding,
        isOverdue,
        status: inv.status,
        isFactored: (customer as any)?.factoringStatus === true,
        invoiceDate,
      });
    }

    enriched.sort((a, b) => b.daysOutstanding - a.daysOutstanding);
    return enriched;
  },
});

// ============================================
// PAYMENT DISCREPANCY QUERIES
// ============================================

// Minimum dollar gap between invoiced and paid for an invoice to count as a
// payment discrepancy. Sub-dollar gaps are per-mile rounding artifacts (paid
// vs effective miles differ by fractions), not real over/underpayments — and
// they render as a misleading "$0" difference in the whole-dollar table. A $1
// floor keeps the over/underpaid views to genuine, recoverable discrepancies.
const DISCREPANCY_MIN_USD = 1;

/**
 * Internal paginated discrepancy scan for accurate sidebar intelligence.
 * Returns raw invoice docs for one cursor page after applying discrepancy filters.
 */
export const getDiscrepancySummaryPage = internalQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
    direction: v.optional(v.union(v.literal('underpaid'), v.literal('overpaid'), v.literal('all'))),
  },
  handler: async (ctx, args) => {
    const results = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_invoice_date', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID');
        if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
          return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
        if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
        if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
        return base;
      })
      .order('desc')
      .paginate(args.paginationOpts);

    const discrepantBase = results.page.filter(
      (inv) => inv.paymentDifference !== undefined && Math.abs(inv.paymentDifference) >= DISCREPANCY_MIN_USD,
    );

    let filtered = args.customerId
      ? discrepantBase.filter((inv) => inv.customerId === args.customerId)
      : discrepantBase;

    if (args.direction === 'underpaid') {
      filtered = filtered.filter((inv) => (inv.paymentDifference ?? 0) < 0);
    } else if (args.direction === 'overpaid') {
      filtered = filtered.filter((inv) => (inv.paymentDifference ?? 0) > 0);
    }

    return {
      ...results,
      page: filtered,
    };
  },
});

/**
 * Accurate discrepancy intelligence for the full filtered date range.
 * Uses an action to iterate all pages so sidebar metrics are not limited by table loads.
 */
export const getDiscrepancyIntelligence = action({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
    direction: v.optional(v.union(v.literal('underpaid'), v.literal('overpaid'), v.literal('all'))),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    let cursor: string | null = null;
    let isDone = false;

    let totalDiscrepancy = 0;
    let underpaidCount = 0;
    let overpaidCount = 0;
    let largestUnderpayment = 0;
    let underpaidTotal = 0; // signed sum of underpaid diffs (negative); recover amount = |underpaidTotal|
    let totalDiscrepantInvoices = 0;
    const byHcr: Record<
      string,
      { netDiscrepancy: number; count: number; underpaidSum: number; underpaidCount: number }
    > = {};

    while (!isDone) {
      const pageResult: {
        page: Array<Doc<'loadInvoices'>>;
        continueCursor: string;
        isDone: boolean;
      } = await ctx.runQuery(internal.accountingReports.getDiscrepancySummaryPage, {
        ...args,
        paginationOpts: {
          cursor,
          numItems: 500,
          maximumRowsRead: 1000,
          maximumBytesRead: 1024 * 1024 * 2,
        },
      });

      const loadHcrMap = await ctx.runQuery(internal.accountingReports.getLoadHcrMap, {
        loadIds: pageResult.page.map((inv) => inv.loadId),
      });

      for (const inv of pageResult.page) {
        const diff = inv.paymentDifference ?? 0;
        totalDiscrepancy += diff;
        totalDiscrepantInvoices += 1;

        if (diff < 0) {
          underpaidCount += 1;
          underpaidTotal += diff;
          if (diff < largestUnderpayment) largestUnderpayment = diff;
        } else {
          overpaidCount += 1;
        }

        const key = loadHcrMap[inv.loadId.toString()] ?? 'Unknown HCR';
        if (!byHcr[key]) byHcr[key] = { netDiscrepancy: 0, count: 0, underpaidSum: 0, underpaidCount: 0 };
        byHcr[key].netDiscrepancy += diff;
        byHcr[key].count += 1;
        // Track the underpaid shortfall per route SEPARATELY from the net so
        // routes with real recoverable underpayments still surface even when
        // overpayments on the same route (or book-wide) net them out.
        if (diff < 0) {
          byHcr[key].underpaidSum += -diff;
          byHcr[key].underpaidCount += 1;
        }
      }

      cursor = pageResult.continueCursor;
      isDone = pageResult.isDone;
    }

    const byHcrRows = [] as Array<{
      name: string;
      netDiscrepancy: number;
      count: number;
      underpaidSum: number;
      underpaidCount: number;
    }>;
    for (const [hcr, data] of Object.entries(byHcr)) {
      byHcrRows.push({
        name: hcr,
        netDiscrepancy: Math.round(data.netDiscrepancy * 100) / 100,
        count: data.count,
        underpaidSum: Math.round(data.underpaidSum * 100) / 100,
        underpaidCount: data.underpaidCount,
      });
    }

    return {
      summary: {
        netDiscrepancy: Math.round(totalDiscrepancy * 100) / 100,
        underpaidCount,
        overpaidCount,
        largestUnderpayment: Math.round(largestUnderpayment * 100) / 100,
        underpaidSum: Math.round(Math.abs(underpaidTotal) * 100) / 100,
        totalDiscrepantInvoices,
      },
      byHcr: byHcrRows.sort((a, b) => b.underpaidSum - a.underpaidSum),
    };
  },
});

export const getLoadHcrMap = internalQuery({
  args: { loadIds: v.array(v.id('loadInformation')) },
  handler: async (ctx, args) => {
    const entries = await Promise.all(
      args.loadIds.map(async (loadId) => {
        // HCR now sourced from facet tags (Phase 5 drops the column).
        const facets = await getLoadFacets(ctx, loadId);
        return [loadId.toString(), facets.hcr ?? 'Unknown HCR'] as const;
      }),
    );
    return Object.fromEntries(entries);
  },
});

export const getCustomerNameMap = internalQuery({
  args: { customerIds: v.array(v.id('customers')) },
  handler: async (ctx, args) => {
    const entries = await Promise.all(
      args.customerIds.map(async (customerId) => {
        const customer = await ctx.db.get(customerId);
        return [customerId.toString(), customer?.name ?? 'Unknown'] as const;
      }),
    );
    return Object.fromEntries(entries);
  },
});

export const getLoadDetailsMap = internalQuery({
  args: { loadIds: v.array(v.id('loadInformation')) },
  handler: async (ctx, args) => {
    const entries = await Promise.all(
      args.loadIds.map(async (loadId) => {
        const load = await ctx.db.get(loadId);
        const facets = await getLoadFacets(ctx, loadId);
        return [
          loadId.toString(),
          {
            orderNumber: load?.orderNumber ?? 'N/A',
            hcr: facets.hcr ?? 'Unknown HCR',
            effectiveMiles: load?.effectiveMiles,
            firstStopDate: load?.firstStopDate,
          },
        ] as const;
      }),
    );
    return Object.fromEntries(entries);
  },
});

type DiscrepancyDetailRow = {
  _id: Id<'loadInvoices'>;
  invoiceNumber: string | null | undefined;
  customerName: string;
  hcr: string;
  loadOrderNumber: string;
  effectiveMiles: number | null;
  paymentMiles: number | null;
  milesDifference: number | null;
  invoicedAmount: number;
  paidAmount: number;
  difference: number;
  percentDiff: number;
  serviceDate: string | null; // load firstStopDate — when the load ran / was planned
  invoiceDate: number | null; // invoiceDateNumeric — the invoice's issued date
  paymentDate: string | undefined;
  paymentReference: string | undefined;
};

export const getDiscrepancyDetailSorted = action({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
    direction: v.optional(v.union(v.literal('underpaid'), v.literal('overpaid'), v.literal('all'))),
    limit: v.number(),
    sortBy: v.optional(
      v.union(
        v.literal('invoiceNumber'),
        v.literal('invoicedAmount'),
        v.literal('paidAmount'),
        v.literal('difference'),
        v.literal('percentDiff'),
        v.literal('paymentReference'),
      ),
    ),
    sortDir: v.optional(v.union(v.literal('asc'), v.literal('desc'))),
  },
  handler: async (ctx, args): Promise<{ rows: DiscrepancyDetailRow[]; total: number; hasMore: boolean }> => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    let cursor: string | null = null;
    let isDone = false;
    const invoices: Array<Doc<'loadInvoices'>> = [];

    while (!isDone) {
      const pageResult: {
        page: Array<Doc<'loadInvoices'>>;
        continueCursor: string;
        isDone: boolean;
      } = await ctx.runQuery(internal.accountingReports.getDiscrepancySummaryPage, {
        workosOrgId: args.workosOrgId,
        dateRangeStart: args.dateRangeStart,
        dateRangeEnd: args.dateRangeEnd,
        customerId: args.customerId,
        direction: args.direction,
        paginationOpts: {
          cursor,
          numItems: 500,
          maximumRowsRead: 1000,
          maximumBytesRead: 1024 * 1024 * 2,
        },
      });

      invoices.push(...pageResult.page);
      cursor = pageResult.continueCursor;
      isDone = pageResult.isDone;
    }

    const sortBy = args.sortBy ?? 'difference';
    const sortDir = args.sortDir ?? 'desc';
    const dir = sortDir === 'asc' ? 1 : -1;

    const sortedInvoices = [...invoices].sort((a, b) => {
      const aPercentDiff =
        (a.totalAmount ?? 0) > 0
          ? Math.round(((a.paymentDifference ?? 0) / (a.totalAmount ?? 1)) * 100 * 100) / 100
          : 0;
      const bPercentDiff =
        (b.totalAmount ?? 0) > 0
          ? Math.round(((b.paymentDifference ?? 0) / (b.totalAmount ?? 1)) * 100 * 100) / 100
          : 0;

      const av =
        sortBy === 'invoicedAmount'
          ? (a.totalAmount ?? 0)
          : sortBy === 'paidAmount'
            ? (a.paidAmount ?? 0)
            : sortBy === 'difference'
              ? (a.paymentDifference ?? 0)
              : sortBy === 'percentDiff'
                ? aPercentDiff
                : sortBy === 'paymentReference'
                  ? (a.paymentReference ?? '')
                  : (a.invoiceNumber ?? '');

      const bv =
        sortBy === 'invoicedAmount'
          ? (b.totalAmount ?? 0)
          : sortBy === 'paidAmount'
            ? (b.paidAmount ?? 0)
            : sortBy === 'difference'
              ? (b.paymentDifference ?? 0)
              : sortBy === 'percentDiff'
                ? bPercentDiff
                : sortBy === 'paymentReference'
                  ? (b.paymentReference ?? '')
                  : (b.invoiceNumber ?? '');

      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
      }

      const as = String(av ?? '');
      const bs = String(bv ?? '');
      return as.localeCompare(bs, undefined, { numeric: true, sensitivity: 'base' }) * dir;
    });

    const visibleInvoices = sortedInvoices.slice(0, args.limit);

    const customerNameMap: Record<string, string> = await ctx.runQuery(internal.accountingReports.getCustomerNameMap, {
      customerIds: [...new Set(visibleInvoices.map((inv) => inv.customerId))],
    });
    const loadDetailsMap: Record<
      string,
      { orderNumber: string; hcr: string; effectiveMiles?: number; firstStopDate?: string }
    > = await ctx.runQuery(internal.accountingReports.getLoadDetailsMap, {
      loadIds: [...new Set(visibleInvoices.map((inv) => inv.loadId))],
    });

    const rows: DiscrepancyDetailRow[] = visibleInvoices.map((inv) => {
      const loadDetails: { orderNumber: string; hcr: string; effectiveMiles?: number; firstStopDate?: string } =
        loadDetailsMap[inv.loadId.toString()] ?? {
          orderNumber: 'N/A',
          hcr: 'Unknown HCR',
        };
      const effectiveMiles = typeof loadDetails.effectiveMiles === 'number' ? loadDetails.effectiveMiles : null;
      const paymentMiles = typeof inv.paymentMiles === 'number' ? inv.paymentMiles : null;
      const milesDifference =
        effectiveMiles !== null && paymentMiles !== null
          ? Math.round((paymentMiles - effectiveMiles) * 100) / 100
          : null;
      return {
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        customerName: customerNameMap[inv.customerId.toString()] ?? 'Unknown',
        hcr: loadDetails.hcr,
        loadOrderNumber: loadDetails.orderNumber,
        effectiveMiles,
        paymentMiles,
        milesDifference,
        invoicedAmount: inv.totalAmount ?? 0,
        paidAmount: inv.paidAmount ?? 0,
        difference: inv.paymentDifference ?? 0,
        percentDiff:
          (inv.totalAmount ?? 0) > 0
            ? Math.round(((inv.paymentDifference ?? 0) / (inv.totalAmount ?? 1)) * 10000) / 100
            : 0,
        serviceDate: loadDetails.firstStopDate ?? null,
        invoiceDate: inv.invoiceDateNumeric ?? null,
        paymentDate: inv.paymentDate,
        paymentReference: inv.paymentReference,
      };
    });

    return {
      rows,
      total: sortedInvoices.length,
      hasMore: args.limit < sortedInvoices.length,
    };
  },
});

/**
 * Get paginated payment discrepancy detail rows.
 * Uses Convex cursor-based pagination with usePaginatedQuery on the client.
 * Filters to discrepancies and enriches each page with customer/load names.
 */
export const getDiscrepancyDetail = query({
  args: {
    paginationOpts: paginationOptsValidator,
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
    direction: v.optional(v.union(v.literal('underpaid'), v.literal('overpaid'), v.literal('all'))),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const results = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_invoice_date', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID');
        if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
          return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
        if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
        if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
        return base;
      })
      .order('desc')
      .paginate(args.paginationOpts);

    // Filter page to only discrepancies
    const discrepantPage = results.page.filter(
      (inv) => inv.paymentDifference !== undefined && Math.abs(inv.paymentDifference) >= DISCREPANCY_MIN_USD,
    );

    // Apply customer filter
    let filtered = args.customerId
      ? discrepantPage.filter((inv) => inv.customerId === args.customerId)
      : discrepantPage;

    if (args.direction === 'underpaid') {
      filtered = filtered.filter((inv) => (inv.paymentDifference ?? 0) < 0);
    } else if (args.direction === 'overpaid') {
      filtered = filtered.filter((inv) => (inv.paymentDifference ?? 0) > 0);
    }

    // Batch-fetch customers, loads, and load HCR values for this page.
    // HCR comes from facet tags (Phase 5 drops the parsedHcr column).
    const customerMap = await batchFetchCustomers(
      ctx,
      filtered.map((inv) => inv.customerId),
    );
    const loadMap = await batchFetchLoads(
      ctx,
      filtered.map((inv) => inv.loadId),
    );
    const hcrMap = new Map<string, string | undefined>();
    await Promise.all(
      [...new Set(filtered.map((inv) => inv.loadId.toString()))].map(
        async (idStr) => {
          const facets = await getLoadFacets(
            ctx,
            idStr as Id<'loadInformation'>,
          );
          hcrMap.set(idStr, facets.hcr);
        },
      ),
    );

    // Transform page with enriched data
    const enrichedPage = filtered.map((inv) => {
      const customer = customerMap.get(inv.customerId.toString());
      const load = loadMap.get(inv.loadId.toString());
      const hcr = hcrMap.get(inv.loadId.toString());
      return {
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        customerName: customer?.name ?? 'Unknown',
        hcr: hcr ?? 'Unknown HCR',
        loadOrderNumber: load?.orderNumber ?? 'N/A',
        invoicedAmount: inv.totalAmount ?? 0,
        paidAmount: inv.paidAmount ?? 0,
        difference: inv.paymentDifference ?? 0,
        percentDiff:
          (inv.totalAmount ?? 0) > 0
            ? Math.round(((inv.paymentDifference ?? 0) / (inv.totalAmount ?? 1)) * 10000) / 100
            : 0,
        paymentDate: inv.paymentDate,
        paymentReference: inv.paymentReference,
      };
    });

    return {
      ...results,
      page: enrichedPage,
    };
  },
});

// ============================================
// REVENUE QUERIES
// ============================================

/**
 * Get revenue summary using pre-computed accounting period stats.
 */
export const getRevenueSummary = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const allStats = await ctx.db
      .query('accountingPeriodStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    const startKey = getPeriodKey(args.dateRangeStart);
    const endKey = getPeriodKey(args.dateRangeEnd);
    const relevantStats = allStats.filter((s) => s.periodKey >= startKey && s.periodKey <= endKey);

    let totalRevenue = 0;
    let totalCollected = 0;
    let invoiceCount = 0;
    let paidInvoiceCount = 0;

    for (const stat of relevantStats) {
      totalRevenue += stat.totalInvoiced;
      totalCollected += stat.totalCollected;
      invoiceCount += stat.invoiceCount;
      paidInvoiceCount += stat.paidInvoiceCount;
    }

    const avgInvoice = invoiceCount > 0 ? totalRevenue / invoiceCount : 0;

    // Get total miles from completed loads in date range
    const startDate = new Date(args.dateRangeStart).toISOString().split('T')[0];
    const endDate = new Date(args.dateRangeEnd).toISOString().split('T')[0];
    const completedLoads = await ctx.db
      .query('loadInformation')
      .withIndex('by_org_status_first_stop', (q) =>
        q
          .eq('workosOrgId', args.workosOrgId)
          .eq('status', 'Completed')
          .gte('firstStopDate', startDate)
          .lte('firstStopDate', endDate),
      )
      .take(2000);

    const totalMiles = completedLoads.reduce((sum, l) => sum + (l.effectiveMiles ?? 0), 0);
    const revenuePerMile = totalMiles > 0 ? totalRevenue / totalMiles : 0;

    return {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalCollected: Math.round(totalCollected * 100) / 100,
      invoiceCount,
      paidInvoiceCount,
      avgInvoice: Math.round(avgInvoice * 100) / 100,
      revenuePerMile: Math.round(revenuePerMile * 100) / 100,
      totalMiles: Math.round(totalMiles),
    };
  },
});

/**
 * Get revenue broken down by customer.
 * Uses batch lookups to stay within read limits.
 */
export const getRevenueByCustomer = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // Fetch finalized invoices by SERVICE month (invoiceDateNumeric) so the
    // per-customer split agrees with the Revenue KPI / period stats (which are
    // service-date based). Take up to the cap with a running read budget.
    const statuses = ['BILLED', 'PENDING_PAYMENT', 'PAID'] as const;
    const allInvoices = [];

    for (const status of statuses) {
      const remaining = PROFIT_INVOICE_CAP - allInvoices.length;
      if (remaining <= 0) break;
      const invoices = await ctx.db
        .query('loadInvoices')
        .withIndex('by_org_status_invoice_date', (q) => {
          const base = q.eq('workosOrgId', args.workosOrgId).eq('status', status);
          if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
            return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
          if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
          if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
          return base;
        })
        .order('desc')
        .take(remaining);
      allInvoices.push(...invoices);
    }

    // Group by customer in-memory (no db.get needed for grouping)
    const byCustomer: Record<string, { customerId: string; invoiceCount: number; totalRevenue: number }> = {};

    const grandTotal = allInvoices.reduce((sum, inv) => sum + (inv.totalAmount ?? 0), 0);

    for (const inv of allInvoices) {
      const key = inv.customerId.toString();
      if (!byCustomer[key]) {
        byCustomer[key] = { customerId: key, invoiceCount: 0, totalRevenue: 0 };
      }
      byCustomer[key].invoiceCount++;
      byCustomer[key].totalRevenue += inv.totalAmount ?? 0;
    }

    // Batch-fetch only the unique customers we need for names
    const customerEntries = Object.values(byCustomer);
    const customerIds = customerEntries.map((c) => c.customerId as Id<'customers'>);
    const customerMap = await batchFetchCustomers(ctx, customerIds);

    return customerEntries
      .map((c) => {
        const customer = customerMap.get(c.customerId);
        return {
          customerId: c.customerId,
          name: customer?.name ?? 'Unknown',
          invoiceCount: c.invoiceCount,
          totalRevenue: Math.round(c.totalRevenue * 100) / 100,
          avgInvoice: c.invoiceCount > 0 ? Math.round((c.totalRevenue / c.invoiceCount) * 100) / 100 : 0,
          avgRevenuePerMile: 0, // Would need load lookup — omitted to save reads
          percentOfTotal: grandTotal > 0 ? Math.round((c.totalRevenue / grandTotal) * 10000) / 100 : 0,
        };
      })
      .sort((a, b) => b.totalRevenue - a.totalRevenue);
  },
});

/**
 * Get revenue over time (monthly).
 */
export const getRevenueOverTime = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const allStats = await ctx.db
      .query('accountingPeriodStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    const startKey = getPeriodKey(args.dateRangeStart);
    const endKey = getPeriodKey(args.dateRangeEnd);

    return allStats
      .filter((s) => s.periodKey >= startKey && s.periodKey <= endKey)
      .sort((a, b) => a.periodKey.localeCompare(b.periodKey))
      .map((s) => ({
        period: s.periodKey,
        totalInvoiced: Math.round(s.totalInvoiced * 100) / 100,
        totalCollected: Math.round(s.totalCollected * 100) / 100,
        invoiceCount: s.invoiceCount,
        paidInvoiceCount: s.paidInvoiceCount,
      }));
  },
});

// ============================================
// COST ANALYSIS QUERIES
// ============================================

/**
 * Get cost summary: total driver pay, carrier pay, fuel costs.
 */
export const getCostSummary = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const driverPayables = await ctx.db
      .query('loadPayables')
      .withIndex('by_org_created', (q) =>
        q.eq('workosOrgId', args.workosOrgId).gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd),
      )
      .take(3000);

    const totalDriverPay = driverPayables.reduce((sum, p) => sum + p.totalAmount, 0);

    const carrierPayables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_org_created', (q) =>
        q.eq('workosOrgId', args.workosOrgId).gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd),
      )
      .take(1000);

    const totalCarrierPay = carrierPayables.reduce((sum, p) => sum + p.totalAmount, 0);

    const fuelEntries = await ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q
          .eq('organizationId', args.workosOrgId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd),
      )
      .take(2000);

    const totalFuel = fuelEntries.reduce((sum, e) => sum + e.totalCost, 0);

    const defEntries = await ctx.db
      .query('defEntries')
      .withIndex('by_organization_and_date', (q) =>
        q
          .eq('organizationId', args.workosOrgId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd),
      )
      .take(500);

    const totalDef = defEntries.reduce((sum, e) => sum + e.totalCost, 0);
    const totalCosts = totalDriverPay + totalCarrierPay + totalFuel + totalDef;

    // Completed loads in date range for cost-per-mile
    const startDate = new Date(args.dateRangeStart).toISOString().split('T')[0];
    const endDate = new Date(args.dateRangeEnd).toISOString().split('T')[0];
    const completedLoads = await ctx.db
      .query('loadInformation')
      .withIndex('by_org_status_first_stop', (q) =>
        q
          .eq('workosOrgId', args.workosOrgId)
          .eq('status', 'Completed')
          .gte('firstStopDate', startDate)
          .lte('firstStopDate', endDate),
      )
      .take(2000);

    const totalMiles = completedLoads.reduce((sum, l) => sum + (l.effectiveMiles ?? 0), 0);

    return {
      totalDriverPay: Math.round(totalDriverPay * 100) / 100,
      totalCarrierPay: Math.round(totalCarrierPay * 100) / 100,
      totalFuel: Math.round(totalFuel * 100) / 100,
      totalDef: Math.round(totalDef * 100) / 100,
      totalCosts: Math.round(totalCosts * 100) / 100,
      avgCostPerMile: totalMiles > 0 ? Math.round((totalCosts / totalMiles) * 100) / 100 : 0,
      driverPayableCount: driverPayables.length,
      carrierPayableCount: carrierPayables.length,
    };
  },
});

/**
 * Get cost breakdown by driver.
 */
export const getCostByDriver = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_org_created', (q) =>
        q.eq('workosOrgId', args.workosOrgId).gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd),
      )
      .take(3000);

    // Group by driver in-memory first
    const byDriverId: Record<string, { totalPay: number; totalMiles: number; loadIds: Set<string> }> = {};

    for (const p of payables) {
      const key = p.driverId.toString();
      if (!byDriverId[key]) byDriverId[key] = { totalPay: 0, totalMiles: 0, loadIds: new Set() };
      byDriverId[key].totalPay += p.totalAmount;
      if (p.sourceType === 'SYSTEM') byDriverId[key].totalMiles += p.quantity;
      if (p.loadId) byDriverId[key].loadIds.add(p.loadId.toString());
    }

    // Batch-fetch unique drivers
    const driverIds = Object.keys(byDriverId);
    const results = [];
    for (const did of driverIds) {
      const driver = await ctx.db.get(did as Id<'drivers'>);
      const data = byDriverId[did];
      results.push({
        driverId: did,
        name: driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown',
        totalPay: Math.round(data.totalPay * 100) / 100,
        totalMiles: Math.round(data.totalMiles),
        loadCount: data.loadIds.size,
        avgPayPerLoad: data.loadIds.size > 0 ? Math.round((data.totalPay / data.loadIds.size) * 100) / 100 : 0,
        avgCostPerMile: data.totalMiles > 0 ? Math.round((data.totalPay / data.totalMiles) * 100) / 100 : 0,
      });
    }

    return results.sort((a, b) => b.totalPay - a.totalPay);
  },
});

/**
 * Get cost breakdown by carrier.
 */
export const getCostByCarrier = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const payables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_org_created', (q) =>
        q.eq('workosOrgId', args.workosOrgId).gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd),
      )
      .take(1000);

    // Group by carrier in-memory first
    const byCarrierId: Record<string, { totalPay: number; loadIds: Set<string> }> = {};

    for (const p of payables) {
      const key = p.carrierPartnershipId.toString();
      if (!byCarrierId[key]) byCarrierId[key] = { totalPay: 0, loadIds: new Set() };
      byCarrierId[key].totalPay += p.totalAmount;
      if (p.loadId) byCarrierId[key].loadIds.add(p.loadId.toString());
    }

    // Batch-fetch unique carriers
    const carrierIds = Object.keys(byCarrierId);
    const results = [];
    for (const cid of carrierIds) {
      const carrier = await ctx.db.get(cid as Id<'carrierPartnerships'>);
      const data = byCarrierId[cid];
      results.push({
        carrierId: cid,
        name: (carrier as any)?.carrierName ?? (carrier as any)?.companyName ?? 'Unknown',
        totalPay: Math.round(data.totalPay * 100) / 100,
        loadCount: data.loadIds.size,
        avgPayPerLoad: data.loadIds.size > 0 ? Math.round((data.totalPay / data.loadIds.size) * 100) / 100 : 0,
      });
    }

    return results.sort((a, b) => b.totalPay - a.totalPay);
  },
});

// ============================================
// PROFITABILITY QUERIES
// ============================================

/**
 * Get profitability summary: total revenue, costs, gross profit, margin.
 */
export const getProfitabilitySummary = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // Revenue from pre-computed stats
    const allStats = await ctx.db
      .query('accountingPeriodStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    const startKey = getPeriodKey(args.dateRangeStart);
    const endKey = getPeriodKey(args.dateRangeEnd);
    const relevantStats = allStats.filter((s) => s.periodKey >= startKey && s.periodKey <= endKey);
    const totalRevenue = relevantStats.reduce((sum, s) => sum + s.totalInvoiced, 0);

    // Costs computed on-demand
    const driverPayables = await ctx.db
      .query('loadPayables')
      .withIndex('by_org_created', (q) =>
        q.eq('workosOrgId', args.workosOrgId).gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd),
      )
      .take(3000);

    const carrierPayables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_org_created', (q) =>
        q.eq('workosOrgId', args.workosOrgId).gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd),
      )
      .take(1000);

    const fuelEntries = await ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q
          .eq('organizationId', args.workosOrgId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd),
      )
      .take(2000);

    const defEntries = await ctx.db
      .query('defEntries')
      .withIndex('by_organization_and_date', (q) =>
        q
          .eq('organizationId', args.workosOrgId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd),
      )
      .take(500);

    const totalDriverPay = driverPayables.reduce((sum, p) => sum + p.totalAmount, 0);
    const totalCarrierPay = carrierPayables.reduce((sum, p) => sum + p.totalAmount, 0);
    const totalFuel = fuelEntries.reduce((sum, e) => sum + e.totalCost, 0);
    const totalDef = defEntries.reduce((sum, e) => sum + e.totalCost, 0);

    const totalCosts = totalDriverPay + totalCarrierPay + totalFuel + totalDef;
    const grossProfit = totalRevenue - totalCosts;
    const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

    return {
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      totalDriverPay: Math.round(totalDriverPay * 100) / 100,
      totalCarrierPay: Math.round(totalCarrierPay * 100) / 100,
      totalFuel: Math.round(totalFuel * 100) / 100,
      totalDef: Math.round(totalDef * 100) / 100,
      totalCosts: Math.round(totalCosts * 100) / 100,
      grossProfit: Math.round(grossProfit * 100) / 100,
      profitMargin: Math.round(profitMargin * 10) / 10,
    };
  },
});

/**
 * Get per-load profitability detail.
 * Limited to 50 loads per call to stay within read limits (each load needs ~6 reads).
 */
export const getProfitabilityByLoad = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const maxResults = Math.min(args.limit ?? 50, 50); // Hard cap at 50 for read limit safety

    // Get completed loads using date range on index
    let loads;
    if (args.dateRangeStart && args.dateRangeEnd) {
      const startDate = new Date(args.dateRangeStart).toISOString().split('T')[0];
      const endDate = new Date(args.dateRangeEnd).toISOString().split('T')[0];
      loads = await ctx.db
        .query('loadInformation')
        .withIndex('by_org_status_first_stop', (q) =>
          q
            .eq('workosOrgId', args.workosOrgId)
            .eq('status', 'Completed')
            .gte('firstStopDate', startDate)
            .lte('firstStopDate', endDate),
        )
        .take(500); // Scan up to 500 loads, then pick top N
    } else {
      loads = await ctx.db
        .query('loadInformation')
        .withIndex('by_org_status_first_stop', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', 'Completed'))
        .take(500);
    }

    let filtered = loads;
    if (args.customerId) {
      filtered = filtered.filter((l) => l.customerId === args.customerId);
    }

    const totalLoads = filtered.length;
    const limited = filtered.slice(0, maxResults);

    // Batch-fetch customers
    const customerMap = await batchFetchCustomers(
      ctx,
      limited.map((l) => l.customerId),
    );

    // Truck cost-per-mile cache for fuel estimation
    const truckCostCache = new Map<string, number | null>();

    const results = [];
    for (const load of limited) {
      // Revenue from invoice
      const invoice = await ctx.db
        .query('loadInvoices')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .first();

      const revenue = invoice?.totalAmount ?? 0;

      // Driver pay
      const driverPayables = await ctx.db
        .query('loadPayables')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      const driverPay = driverPayables.reduce((sum, p) => sum + p.totalAmount, 0);

      // Carrier pay
      const carrierPayables = await ctx.db
        .query('loadCarrierPayables')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      const carrierPay = carrierPayables.reduce((sum, p) => sum + p.totalAmount, 0);

      const customer = customerMap.get(load.customerId.toString());

      // Lane label
      let laneLabel = 'N/A';
      if (invoice?.contractLaneId) {
        const lane = await ctx.db.get(invoice.contractLaneId);
        laneLabel = extractLaneLabel(lane);
      }

      // Fuel cost estimation
      const fuelEstimate = await estimateFuelCostForLoad(
        ctx,
        load._id,
        load.effectiveMiles,
        truckCostCache,
        args.dateRangeStart,
        args.dateRangeEnd,
      );
      const fuelCost = fuelEstimate.amount ?? 0;

      const totalCost = driverPay + carrierPay + fuelCost;
      const profit = revenue - totalCost;
      const margin = revenue > 0 ? (profit / revenue) * 100 : 0;

      results.push({
        loadId: load._id,
        orderNumber: load.orderNumber,
        customerName: customer?.name ?? 'Unknown',
        laneLabel,
        miles: load.effectiveMiles ?? 0,
        revenue: Math.round(revenue * 100) / 100,
        driverPay: Math.round(driverPay * 100) / 100,
        carrierPay: Math.round(carrierPay * 100) / 100,
        fuelCost: Math.round(fuelCost * 100) / 100,
        fuelSource: fuelEstimate.source,
        profit: Math.round(profit * 100) / 100,
        margin: Math.round(margin * 10) / 10,
        loadType: load.loadType ?? 'UNMAPPED',
        isHeld: load.isHeld === true,
        firstStopDate: load.firstStopDate,
        hasInvoice: invoice !== null,
      });
    }

    return {
      loads: results,
      totalLoads,
      showing: limited.length,
      hasMore: totalLoads > maxResults,
    };
  },
});

// ============================================
// PROFITABILITY BREAKDOWN (by customer / by lane)
// ============================================

const PROFIT_INVOICE_CAP = 2000; // finalized invoices scanned per breakdown
const PROFIT_BATCH = 100; // loadIds per internal cost batch

/**
 * Finalized invoices in range — the revenue source (matches Overview / A/R).
 * Profitability is invoice-driven: revenue lives on invoices whose loads have
 * moved past 'Completed', so scanning completed loads would miss nearly all of
 * it. Returns the fields needed to group by customer/lane + join cost per load.
 */
export const getFinalizedInvoicesForProfit = internalQuery({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
  },
  handler: async (ctx, args) => {
    const statuses = ['BILLED', 'PENDING_PAYMENT', 'PAID'] as const;
    const all: Array<Doc<'loadInvoices'>> = [];
    // Filter by the invoice's SERVICE month (invoiceDateNumeric) — the same
    // basis as getRevenueSummary / the period stats that power Overview & P&L —
    // so all tabs report the same invoices for a given range. (The old query
    // filtered by createdAt, which diverged from the reporting basis once
    // invoices were anchored to their service date.) Take up to the cap across
    // statuses with a running budget so total reads stay well under the limit.
    for (const status of statuses) {
      const remaining = PROFIT_INVOICE_CAP - all.length;
      if (remaining <= 0) break;
      const rows = await ctx.db
        .query('loadInvoices')
        .withIndex('by_org_status_invoice_date', (q) => {
          const base = q.eq('workosOrgId', args.workosOrgId).eq('status', status);
          if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined)
            return base.gte('invoiceDateNumeric', args.dateRangeStart).lte('invoiceDateNumeric', args.dateRangeEnd);
          if (args.dateRangeStart !== undefined) return base.gte('invoiceDateNumeric', args.dateRangeStart);
          if (args.dateRangeEnd !== undefined) return base.lte('invoiceDateNumeric', args.dateRangeEnd);
          return base;
        })
        .order('desc')
        .take(remaining);
      all.push(...rows);
    }
    const scoped = args.customerId ? all.filter((inv) => inv.customerId === args.customerId) : all;
    return {
      invoices: scoped.map((inv) => ({
        loadId: inv.loadId,
        customerId: inv.customerId,
        contractLaneId: inv.contractLaneId ?? null,
        revenue: inv.totalAmount ?? 0,
      })),
      truncated: all.length >= PROFIT_INVOICE_CAP,
      total: scoped.length,
    };
  },
});

/** Directly-attributable pay (driver + carrier) per load. */
export const getLoadCostBatch = internalQuery({
  args: { loadIds: v.array(v.id('loadInformation')) },
  handler: async (ctx, args) => {
    const out: Record<string, number> = {};
    for (const loadId of args.loadIds) {
      const driverPay = (
        await ctx.db
          .query('loadPayables')
          .withIndex('by_load', (q) => q.eq('loadId', loadId))
          .collect()
      ).reduce((s, p) => s + p.totalAmount, 0);
      const carrierPay = (
        await ctx.db
          .query('loadCarrierPayables')
          .withIndex('by_load', (q) => q.eq('loadId', loadId))
          .collect()
      ).reduce((s, p) => s + p.totalAmount, 0);
      out[loadId.toString()] = driverPay + carrierPay;
    }
    return out;
  },
});

/** Resolve contract-lane labels for a set of lane ids. */
export const getLaneLabelBatch = internalQuery({
  args: { laneIds: v.array(v.id('contractLanes')) },
  handler: async (ctx, args) => {
    const out: Record<string, string> = {};
    for (const laneId of args.laneIds) {
      const lane = await ctx.db.get(laneId);
      out[laneId.toString()] = extractLaneLabel(lane);
    }
    return out;
  },
});

type ProfitGroup = { key: string; name: string; loads: number; revenue: number; cost: number };
type ProfitRow = ProfitGroup & { profit: number; margin: number };

/**
 * Profitability by customer AND by lane, invoice-driven. Revenue is summed from
 * finalized invoices (same source as Overview / A/R); cost is the
 * directly-attributable pay (driver + carrier) joined per unique load — so
 * margin is a contribution margin (fuel/DEF are fleet-level — see P&L).
 * Read-safe: one invoice scan, then per-load cost fanned across batch queries.
 */
export const getProfitabilityBreakdown = action({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    byCustomer: ProfitRow[];
    byLane: ProfitRow[];
    fleet: ProfitRow;
    processed: number;
    total: number;
    truncated: boolean;
  }> => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const { invoices, truncated, total }: {
      invoices: { loadId: Id<'loadInformation'>; customerId: Id<'customers'>; contractLaneId: Id<'contractLanes'> | null; revenue: number }[];
      truncated: boolean;
      total: number;
    } = await ctx.runQuery(internal.accountingReports.getFinalizedInvoicesForProfit, {
      workosOrgId: args.workosOrgId,
      dateRangeStart: args.dateRangeStart,
      dateRangeEnd: args.dateRangeEnd,
      customerId: args.customerId,
    });

    const byCustomer = new Map<string, ProfitGroup>();
    const byLane = new Map<string, ProfitGroup>();
    const customerIds = new Set<string>();
    const laneIds = new Set<string>();
    // One representative (customer, lane) per load so cost is attributed once.
    const loadMeta = new Map<string, { ck: string; lk: string }>();
    const loadIdByKey = new Map<string, Id<'loadInformation'>>();

    // Revenue pass (no extra reads).
    for (const inv of invoices) {
      const ck = inv.customerId.toString();
      const lk = inv.contractLaneId ? inv.contractLaneId.toString() : 'unmapped';
      customerIds.add(ck);
      if (inv.contractLaneId) laneIds.add(lk);

      const cg = byCustomer.get(ck) ?? { key: ck, name: '', loads: 0, revenue: 0, cost: 0 };
      cg.loads += 1;
      cg.revenue += inv.revenue;
      byCustomer.set(ck, cg);

      const lg = byLane.get(lk) ?? { key: lk, name: lk === 'unmapped' ? 'Unmapped lane' : '', loads: 0, revenue: 0, cost: 0 };
      lg.loads += 1;
      lg.revenue += inv.revenue;
      byLane.set(lk, lg);

      const loadKey = inv.loadId.toString();
      if (!loadMeta.has(loadKey)) {
        loadMeta.set(loadKey, { ck, lk });
        loadIdByKey.set(loadKey, inv.loadId);
      }
    }

    // Cost pass — batch per unique load, attributed once.
    const loadIds = [...loadIdByKey.values()];
    const costByLoad: Record<string, number> = {};
    for (let i = 0; i < loadIds.length; i += PROFIT_BATCH) {
      const batch: Record<string, number> = await ctx.runQuery(internal.accountingReports.getLoadCostBatch, {
        loadIds: loadIds.slice(i, i + PROFIT_BATCH),
      });
      Object.assign(costByLoad, batch);
    }
    for (const [loadKey, meta] of loadMeta) {
      const c = costByLoad[loadKey] ?? 0;
      const cg = byCustomer.get(meta.ck);
      if (cg) cg.cost += c;
      const lg = byLane.get(meta.lk);
      if (lg) lg.cost += c;
    }

    // Resolve display names.
    const nameMap: Record<string, string> = await ctx.runQuery(internal.accountingReports.getCustomerNameMap, {
      customerIds: [...customerIds].map((id) => id as Id<'customers'>),
    });
    const laneLabelMap: Record<string, string> = await ctx.runQuery(internal.accountingReports.getLaneLabelBatch, {
      laneIds: [...laneIds].map((id) => id as Id<'contractLanes'>),
    });

    const finalize = (g: ProfitGroup): ProfitRow => {
      const profit = g.revenue - g.cost;
      return {
        ...g,
        revenue: Math.round(g.revenue * 100) / 100,
        cost: Math.round(g.cost * 100) / 100,
        profit: Math.round(profit * 100) / 100,
        margin: g.revenue > 0 ? Math.round((profit / g.revenue) * 1000) / 10 : 0,
      };
    };

    const customerRows = [...byCustomer.values()]
      .map((g) => finalize({ ...g, name: nameMap[g.key] ?? 'Unknown' }))
      .sort((a, b) => b.profit - a.profit);
    const laneRows = [...byLane.values()]
      .map((g) => finalize({ ...g, name: g.key === 'unmapped' ? 'Unmapped lane' : laneLabelMap[g.key] ?? 'Lane' }))
      .sort((a, b) => b.profit - a.profit);

    const fleetAgg = [...byCustomer.values()].reduce(
      (a, g) => ({ key: 'fleet', name: 'Fleet', loads: a.loads + g.loads, revenue: a.revenue + g.revenue, cost: a.cost + g.cost }),
      { key: 'fleet', name: 'Fleet', loads: 0, revenue: 0, cost: 0 } as ProfitGroup,
    );

    return {
      byCustomer: customerRows,
      byLane: laneRows,
      fleet: finalize(fleetAgg),
      processed: invoices.length,
      total,
      truncated,
    };
  },
});

/**
 * Per-customer revenue trend (monthly), invoice-driven. Powers the Overview
 * trend chart when the page is scoped to one customer. Same row shape as
 * getRevenueOverTime so the chart component is reused unchanged.
 */
export const getCustomerRevenueTrend = query({
  args: {
    workosOrgId: v.string(),
    customerId: v.id('customers'),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const statuses = ['BILLED', 'PENDING_PAYMENT', 'PAID'] as const;
    const byPeriod = new Map<string, { totalInvoiced: number; totalCollected: number }>();
    for (const status of statuses) {
      const rows = await ctx.db
        .query('loadInvoices')
        .withIndex('by_org_status_invoice_date', (q) =>
          q
            .eq('workosOrgId', args.workosOrgId)
            .eq('status', status)
            .gte('invoiceDateNumeric', args.dateRangeStart)
            .lte('invoiceDateNumeric', args.dateRangeEnd),
        )
        .take(MAX_INVOICES_PER_STATUS);
      for (const inv of rows) {
        if (inv.customerId !== args.customerId) continue;
        const key = getPeriodKey(inv.invoiceDateNumeric ?? inv.createdAt);
        const e = byPeriod.get(key) ?? { totalInvoiced: 0, totalCollected: 0 };
        e.totalInvoiced += inv.totalAmount ?? 0;
        e.totalCollected += inv.paidAmount ?? 0;
        byPeriod.set(key, e);
      }
    }
    return [...byPeriod.entries()]
      .map(([period, v2]) => ({
        period,
        totalInvoiced: Math.round(v2.totalInvoiced * 100) / 100,
        totalCollected: Math.round(v2.totalCollected * 100) / 100,
      }))
      .sort((a, b) => a.period.localeCompare(b.period));
  },
});
