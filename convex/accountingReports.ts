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
export const getReceivablesSummary = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Fetch outstanding invoices with date range on index
    const billedQuery = ctx.db.query('loadInvoices').withIndex('by_org_status_created', (q) => {
      const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'BILLED');
      if (args.dateRangeStart && args.dateRangeEnd)
        return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
      if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
      if (args.dateRangeEnd) return base.lte('createdAt', args.dateRangeEnd);
      return base;
    });
    const billedInvoices = await billedQuery.take(MAX_INVOICES_PER_STATUS);

    const pendingQuery = ctx.db.query('loadInvoices').withIndex('by_org_status_created', (q) => {
      const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING_PAYMENT');
      if (args.dateRangeStart && args.dateRangeEnd)
        return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
      if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
      if (args.dateRangeEnd) return base.lte('createdAt', args.dateRangeEnd);
      return base;
    });
    const pendingInvoices = await pendingQuery.take(MAX_INVOICES_PER_STATUS);

    let outstanding = [...billedInvoices, ...pendingInvoices];
    if (args.customerId) {
      outstanding = outstanding.filter((inv) => inv.customerId === args.customerId);
    }

    // Fetch PAID invoices for avg days calculation
    const paidQuery = ctx.db.query('loadInvoices').withIndex('by_org_status_created', (q) => {
      const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID');
      if (args.dateRangeStart && args.dateRangeEnd)
        return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
      if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
      if (args.dateRangeEnd) return base.lte('createdAt', args.dateRangeEnd);
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
    const agingBuckets = { current: 0, days31to60: 0, days61to90: 0, days90plus: 0 };

    for (const inv of outstanding) {
      const amount = inv.totalAmount ?? 0;
      totalOutstanding += amount;

      const customer = customerMap.get(inv.customerId.toString());
      const dueDate = getEffectiveDueDate(inv, customer ? { paymentTerms: (customer as any).paymentTerms } : null);
      const invoiceDate = inv.invoiceDateNumeric ?? inv.createdAt;
      const daysOut = getDaysOutstanding(invoiceDate);

      if (now > dueDate) totalOverdue += amount;

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
    const now = Date.now();
    const MAX_DETAIL = 200;

    // Use date range on index
    const billedInvoices = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_created', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'BILLED');
        if (args.dateRangeStart && args.dateRangeEnd)
          return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
        if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
        return base;
      })
      .take(MAX_INVOICES_PER_STATUS);

    const pendingInvoices = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_created', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING_PAYMENT');
        if (args.dateRangeStart && args.dateRangeEnd)
          return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
        if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
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

/**
 * Get payment discrepancy summary (lightweight — no enrichment).
 * Summary is computed from invoice fields alone.
 */
export const getDiscrepancySummary = query({
  args: {
    workosOrgId: v.string(),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    customerId: v.optional(v.id('customers')),
    direction: v.optional(v.union(v.literal('underpaid'), v.literal('overpaid'), v.literal('all'))),
  },
  handler: async (ctx, args) => {
    const paidInvoices = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_created', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID');
        if (args.dateRangeStart && args.dateRangeEnd)
          return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
        if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
        if (args.dateRangeEnd) return base.lte('createdAt', args.dateRangeEnd);
        return base;
      })
      .take(MAX_INVOICES_PER_STATUS);

    let filtered = paidInvoices;
    if (args.customerId) {
      filtered = filtered.filter((inv) => inv.customerId === args.customerId);
    }

    const discrepantBase = filtered.filter(
      (inv) => inv.paymentDifference !== undefined && Math.abs(inv.paymentDifference) > 0.005,
    );

    const discrepant =
      args.direction === 'underpaid'
        ? discrepantBase.filter((inv) => (inv.paymentDifference ?? 0) < 0)
        : args.direction === 'overpaid'
          ? discrepantBase.filter((inv) => (inv.paymentDifference ?? 0) > 0)
          : discrepantBase;

    // Pure in-memory aggregation — no db.get() calls
    let totalDiscrepancy = 0;
    let underpaidCount = 0;
    let overpaidCount = 0;
    let largestUnderpayment = 0;
    const byCustomerId: Record<string, { netDiscrepancy: number; count: number }> = {};

    for (const inv of discrepant) {
      const diff = inv.paymentDifference ?? 0;
      totalDiscrepancy += diff;
      if (diff < 0) {
        underpaidCount++;
        if (diff < largestUnderpayment) largestUnderpayment = diff;
      } else {
        overpaidCount++;
      }

      const key = inv.customerId.toString();
      if (!byCustomerId[key]) byCustomerId[key] = { netDiscrepancy: 0, count: 0 };
      byCustomerId[key].netDiscrepancy += diff;
      byCustomerId[key].count++;
    }

    return {
      summary: {
        netDiscrepancy: Math.round(totalDiscrepancy * 100) / 100,
        underpaidCount,
        overpaidCount,
        largestUnderpayment: Math.round(largestUnderpayment * 100) / 100,
        totalDiscrepantInvoices: discrepant.length,
      },
    };
  },
});

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
      .withIndex('by_org_status_created', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID');
        if (args.dateRangeStart && args.dateRangeEnd)
          return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
        if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
        if (args.dateRangeEnd) return base.lte('createdAt', args.dateRangeEnd);
        return base;
      })
      .order('desc')
      .paginate(args.paginationOpts);

    const discrepantBase = results.page.filter(
      (inv) => inv.paymentDifference !== undefined && Math.abs(inv.paymentDifference) > 0.005,
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
    let cursor: string | null = null;
    let isDone = false;

    let totalDiscrepancy = 0;
    let underpaidCount = 0;
    let overpaidCount = 0;
    let largestUnderpayment = 0;
    let totalDiscrepantInvoices = 0;
    const byHcr: Record<string, { netDiscrepancy: number; count: number }> = {};

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
          if (diff < largestUnderpayment) largestUnderpayment = diff;
        } else {
          overpaidCount += 1;
        }

        const key = loadHcrMap[inv.loadId.toString()] ?? 'Unknown HCR';
        if (!byHcr[key]) byHcr[key] = { netDiscrepancy: 0, count: 0 };
        byHcr[key].netDiscrepancy += diff;
        byHcr[key].count += 1;
      }

      cursor = pageResult.continueCursor;
      isDone = pageResult.isDone;
    }

    const byHcrRows = [] as Array<{ name: string; netDiscrepancy: number; count: number }>;
    for (const [hcr, data] of Object.entries(byHcr)) {
      byHcrRows.push({
        name: hcr,
        netDiscrepancy: Math.round(data.netDiscrepancy * 100) / 100,
        count: data.count,
      });
    }

    return {
      summary: {
        netDiscrepancy: Math.round(totalDiscrepancy * 100) / 100,
        underpaidCount,
        overpaidCount,
        largestUnderpayment: Math.round(largestUnderpayment * 100) / 100,
        totalDiscrepantInvoices,
      },
      byHcr: byHcrRows.sort((a, b) => a.netDiscrepancy - b.netDiscrepancy),
    };
  },
});

export const getLoadHcrMap = internalQuery({
  args: { loadIds: v.array(v.id('loadInformation')) },
  handler: async (ctx, args) => {
    const entries = await Promise.all(
      args.loadIds.map(async (loadId) => {
        const load = await ctx.db.get(loadId);
        return [loadId.toString(), load?.parsedHcr ?? 'Unknown HCR'] as const;
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
        return [
          loadId.toString(),
          {
            orderNumber: load?.orderNumber ?? 'N/A',
            hcr: load?.parsedHcr ?? 'Unknown HCR',
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
  invoicedAmount: number;
  paidAmount: number;
  difference: number;
  percentDiff: number;
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
    const loadDetailsMap: Record<string, { orderNumber: string; hcr: string }> = await ctx.runQuery(
      internal.accountingReports.getLoadDetailsMap,
      {
        loadIds: [...new Set(visibleInvoices.map((inv) => inv.loadId))],
      },
    );

    const rows: DiscrepancyDetailRow[] = visibleInvoices.map((inv) => {
      const loadDetails: { orderNumber: string; hcr: string } = loadDetailsMap[inv.loadId.toString()] ?? {
        orderNumber: 'N/A',
        hcr: 'Unknown HCR',
      };
      return {
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        customerName: customerNameMap[inv.customerId.toString()] ?? 'Unknown',
        hcr: loadDetails.hcr,
        loadOrderNumber: loadDetails.orderNumber,
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
    const results = await ctx.db
      .query('loadInvoices')
      .withIndex('by_org_status_created', (q) => {
        const base = q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID');
        if (args.dateRangeStart && args.dateRangeEnd)
          return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
        if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
        if (args.dateRangeEnd) return base.lte('createdAt', args.dateRangeEnd);
        return base;
      })
      .order('desc')
      .paginate(args.paginationOpts);

    // Filter page to only discrepancies
    const discrepantPage = results.page.filter(
      (inv) => inv.paymentDifference !== undefined && Math.abs(inv.paymentDifference) > 0.005,
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

    // Batch-fetch customers and loads for this page
    const customerMap = await batchFetchCustomers(
      ctx,
      filtered.map((inv) => inv.customerId),
    );
    const loadMap = await batchFetchLoads(
      ctx,
      filtered.map((inv) => inv.loadId),
    );

    // Transform page with enriched data
    const enrichedPage = filtered.map((inv) => {
      const customer = customerMap.get(inv.customerId.toString());
      const load = loadMap.get(inv.loadId.toString());
      return {
        _id: inv._id,
        invoiceNumber: inv.invoiceNumber,
        customerName: customer?.name ?? 'Unknown',
        hcr: load?.parsedHcr ?? 'Unknown HCR',
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
    // Fetch finalized invoices with date range filtering
    const statuses = ['BILLED', 'PENDING_PAYMENT', 'PAID'] as const;
    const allInvoices = [];

    for (const status of statuses) {
      const invoices = await ctx.db
        .query('loadInvoices')
        .withIndex('by_org_status_created', (q) => {
          const base = q.eq('workosOrgId', args.workosOrgId).eq('status', status);
          if (args.dateRangeStart && args.dateRangeEnd)
            return base.gte('createdAt', args.dateRangeStart).lte('createdAt', args.dateRangeEnd);
          if (args.dateRangeStart) return base.gte('createdAt', args.dateRangeStart);
          if (args.dateRangeEnd) return base.lte('createdAt', args.dateRangeEnd);
          return base;
        })
        .take(MAX_INVOICES_PER_STATUS);
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
