/**
 * Invoice Queries
 * Fetch invoice and line item data for accounting dashboard
 *
 * Invoices are calculated dynamically based on load + contract lane data.
 * Amounts are only stored for BILLED/PAID/VOID status (frozen snapshot).
 */

import { query, mutation, action, MutationCtx } from './_generated/server';
import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { calculateInvoiceAmounts, getZeroInvoiceAmounts } from './invoiceCalculations';
import { Doc } from './_generated/dataModel';
import { updateInvoiceCount } from './stats_helpers';
import { getLoadFacets } from './lib/loadFacets';
import { refreshInvoiceSearchText } from './invoiceSearchText';
import {
  recordInvoiceFinalized,
  recordInvoiceSettled,
  recordPaymentCollected,
  reverseInvoice,
  reversePaymentAndInvoice,
  reversePaymentCollected,
} from './accountingStatsHelpers';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';
import { logAudit } from './lib/audit';

const INVOICE_FINALIZED_STATUSES = ['BILLED', 'PENDING_PAYMENT', 'PAID'];

// customers.paymentTerms enum → net days for due-date calculation.
const PAYMENT_TERMS_DAYS: Record<string, number> = {
  DUE_ON_RECEIPT: 0,
  NET_15: 15,
  NET_30: 30,
  NET_45: 45,
  NET_60: 60,
  NET_90: 90,
};
const DEFAULT_TERMS_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * Helper: Calculate invoice amounts dynamically
 */
async function enrichInvoiceWithCalculatedAmounts(
  ctx: any,
  invoice: Doc<'loadInvoices'>,
  // Optional pre-fetched load/lane (undefined = fetch) so a caller that already
  // has them doesn't pay a second read.
  prefetchedLoad?: Doc<'loadInformation'> | null,
  prefetchedLane?: Doc<'contractLanes'> | null,
) {
  // For finalized invoices (BILLED/PENDING_PAYMENT/PAID), use stored amounts
  const isFinalized = ['BILLED', 'PENDING_PAYMENT', 'PAID'].includes(invoice.status);

  if (isFinalized && invoice.totalAmount !== undefined) {
    return {
      subtotal: invoice.subtotal ?? 0,
      fuelSurcharge: invoice.fuelSurcharge ?? 0,
      accessorialsTotal: invoice.accessorialsTotal ?? 0,
      taxAmount: invoice.taxAmount ?? 0,
      totalAmount: invoice.totalAmount,
    };
  }

  // For DRAFT/MISSING_DATA: calculate dynamically
  const load = prefetchedLoad === undefined ? await ctx.db.get(invoice.loadId) : prefetchedLoad;

  // MISSING_DATA or no contract lane: return $0
  if (!invoice.contractLaneId || !load) {
    const zero = getZeroInvoiceAmounts();
    return {
      subtotal: zero.subtotal,
      fuelSurcharge: zero.fuelSurcharge,
      accessorialsTotal: zero.accessorialsTotal,
      taxAmount: zero.taxAmount,
      totalAmount: zero.totalAmount,
    };
  }

  // Get contract lane and calculate
  const contractLane = prefetchedLane === undefined ? await ctx.db.get(invoice.contractLaneId) : prefetchedLane;
  if (!contractLane) {
    const zero = getZeroInvoiceAmounts();
    return {
      subtotal: zero.subtotal,
      fuelSurcharge: zero.fuelSurcharge,
      accessorialsTotal: zero.accessorialsTotal,
      taxAmount: zero.taxAmount,
      totalAmount: zero.totalAmount,
    };
  }

  const calculated = calculateInvoiceAmounts(
    { effectiveMiles: load.effectiveMiles, stopCount: load.stopCount },
    contractLane,
  );

  return {
    subtotal: calculated.subtotal,
    fuelSurcharge: calculated.fuelSurcharge,
    accessorialsTotal: calculated.accessorialsTotal,
    taxAmount: calculated.taxAmount,
    totalAmount: calculated.totalAmount,
  };
}

type FrozenAmounts = {
  subtotal: number;
  fuelSurcharge: number;
  accessorialsTotal: number;
  taxAmount: number;
  totalAmount: number;
};

/**
 * Helper: claim the next invoice number for an org — <PREFIX>YYYY-NNNN
 * (default prefix "INV-", configurable per org on Settings → General), one
 * sequence per org per year. Runs inside the calling mutation's transaction,
 * so Convex serializability makes concurrent claims race-free.
 */
async function claimInvoiceNumber(
  ctx: MutationCtx,
  workosOrgId: string,
  anchorTimestamp: number,
): Promise<string> {
  const year = new Date(anchorTimestamp).getUTCFullYear();
  const counter = await ctx.db
    .query('invoiceCounters')
    .withIndex('by_org_year', (q) => q.eq('workosOrgId', workosOrgId).eq('year', year))
    .first();

  let seq: number;
  if (counter) {
    seq = counter.nextSeq;
    await ctx.db.patch(counter._id, { nextSeq: seq + 1, updatedAt: Date.now() });
  } else {
    seq = 1;
    await ctx.db.insert('invoiceCounters', { workosOrgId, year, nextSeq: 2, updatedAt: Date.now() });
  }

  const org = await ctx.db
    .query('organizations')
    .withIndex('by_organization', (q) => q.eq('workosOrgId', workosOrgId))
    .unique();
  const prefix = org?.invoicePrefix ?? 'INV-';

  return `${prefix}${year}-${String(seq).padStart(4, '0')}`;
}

/**
 * Helper: materialize line items for an invoice being finalized, if none
 * exist yet. Shared by bulkMarkBilled, bulkMarkPaid, bulkUpdateStatus and
 * confirmPaymentChunk so every finalization path produces the same items.
 */
async function materializeLineItems(
  ctx: MutationCtx,
  invoice: Doc<'loadInvoices'>,
  amounts: FrozenAmounts,
  now: number,
  // Optional pre-fetched load/lane (undefined = fetch) to avoid a redundant read.
  prefetchedLoad?: Doc<'loadInformation'> | null,
  prefetchedLane?: Doc<'contractLanes'> | null,
): Promise<void> {
  const existing = await ctx.db
    .query('invoiceLineItems')
    .withIndex('by_invoice', (q) => q.eq('invoiceId', invoice._id))
    .take(1);
  if (existing.length > 0) return;

  const load = prefetchedLoad === undefined ? await ctx.db.get(invoice.loadId) : prefetchedLoad;
  const contractLane =
    prefetchedLane !== undefined
      ? prefetchedLane
      : invoice.contractLaneId
        ? await ctx.db.get(invoice.contractLaneId)
        : null;

  if (amounts.subtotal > 0 && contractLane && load) {
    const isWildcard = (contractLane as any).tripNumber === '*';
    const loadFacets = await getLoadFacets(ctx, load._id);
    const desc = isWildcard
      ? `Extra Trips - ${loadFacets.hcr || 'Unknown HCR'} ${loadFacets.trip || 'Unknown Trip'}`
      : (contractLane as any).contractName ||
        `${loadFacets.hcr || 'Unknown HCR'} - ${loadFacets.trip || 'Unknown Trip'}`;

    await ctx.db.insert('invoiceLineItems', {
      invoiceId: invoice._id,
      type: 'FREIGHT',
      description: desc,
      quantity: 1,
      rate: amounts.subtotal,
      amount: amounts.subtotal,
      createdAt: now,
    });
  }

  if (amounts.fuelSurcharge > 0 && contractLane) {
    await ctx.db.insert('invoiceLineItems', {
      invoiceId: invoice._id,
      type: 'FUEL',
      description: `Fuel Surcharge (${(contractLane as any).fuelSurchargeType || 'N/A'})`,
      quantity: 1,
      rate: amounts.fuelSurcharge,
      amount: amounts.fuelSurcharge,
      createdAt: now,
    });
  }

  if (amounts.accessorialsTotal > 0 && load && contractLane) {
    const includedStops = (contractLane as any).includedStops || 2;
    const extraStops = Math.max(0, ((load as any).stopCount || 0) - includedStops);
    await ctx.db.insert('invoiceLineItems', {
      invoiceId: invoice._id,
      type: 'ACCESSORIAL',
      description: `Stop-off charges (${extraStops} extra stops)`,
      quantity: extraStops,
      rate: (contractLane as any).stopOffRate || 0,
      amount: amounts.accessorialsTotal,
      createdAt: now,
    });
  }
}

/**
 * Resolve the timestamp an invoice should be *issued* and *reported* under.
 *
 * Revenue belongs to the month the service was performed, not the day the
 * invoice happened to be billed — otherwise a backlogged bulk-send dumps months
 * of older loads into the current period (which is exactly what happened on the
 * Jul-2 bulk send). We anchor to the load's first-stop (service) date; if it's
 * missing or unparseable we fall back to `now`. Callers pass the invoice's
 * existing `invoiceDateNumeric` first when re-finalizing so a prior anchor is
 * never overwritten (e.g. re-billing after an undo).
 */
async function resolveServiceAnchor(
  ctx: MutationCtx,
  invoice: Doc<'loadInvoices'>,
  now: number,
  // Pass an already-fetched load (or null) to avoid a redundant read on hot
  // paths; `undefined` means "fetch it here".
  prefetchedLoad?: Doc<'loadInformation'> | null,
): Promise<number> {
  const load = prefetchedLoad === undefined ? await ctx.db.get(invoice.loadId) : prefetchedLoad;
  const firstStop = (load as { firstStopDate?: string } | null)?.firstStopDate;
  if (firstStop) {
    const parsed = Date.parse(firstStop);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return now;
}

/**
 * Get invoices for an organization with filters
 */
export const getInvoices = query({
  args: {
    workosOrgId: v.string(),
    status: v.optional(
      v.union(
        v.literal('MISSING_DATA'),
        v.literal('DRAFT'),
        v.literal('BILLED'),
        v.literal('PENDING_PAYMENT'),
        v.literal('PAID'),
        v.literal('VOID'),
      ),
    ),
    customerId: v.optional(v.id('customers')),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    let query = ctx.db.query('loadInvoices').withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field('status'), args.status));
    }

    if (args.customerId) {
      query = query.filter((q) => q.eq(q.field('customerId'), args.customerId));
    }

    const invoices = await query.order('desc').collect();

    // Enrich with load, customer info, and calculated amounts
    const enriched = await Promise.all(
      invoices.map(async (invoice) => {
        const load = await ctx.db.get(invoice.loadId);
        const customer = await ctx.db.get(invoice.customerId);
        const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

        return {
          ...invoice,
          ...amounts, // Add calculated amounts
          load: load
            ? {
                _id: load._id,
                internalId: load.internalId,
                orderNumber: load.orderNumber,
                status: load.status,
                loadType: load.loadType,
              }
            : null,
          customer: customer
            ? {
                _id: customer._id,
                name: customer.name,
              }
            : null,
        };
      }),
    );

    return enriched;
  },
});

/**
 * Get single invoice with calculated amounts
 */
export const getInvoice = query({
  args: {
    invoiceId: v.id('loadInvoices'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) return null;
    if (invoice.workosOrgId !== callerOrgId) return null;

    // Calculate amounts dynamically
    const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

    // Get load, customer, and contract lane info
    const load = await ctx.db.get(invoice.loadId);
    const customer = await ctx.db.get(invoice.customerId);
    const contractLane = invoice.contractLaneId ? await ctx.db.get(invoice.contractLaneId) : null;
    const loadFacets = load
      ? await getLoadFacets(ctx, load._id)
      : { hcr: undefined, trip: undefined };

    return {
      ...invoice,
      ...amounts,
      load: load
        ? {
            _id: load._id,
            internalId: load.internalId,
            orderNumber: load.orderNumber,
            status: load.status,
            loadType: load.loadType,
            parsedHcr: loadFacets.hcr,
            parsedTripNumber: loadFacets.trip,
            effectiveMiles: load.effectiveMiles,
            contractMiles: load.contractMiles,
            googleMiles: load.googleMiles,
            importedMiles: load.importedMiles,
            manualMiles: load.manualMiles,
            stopCount: load.stopCount,
          }
        : null,
      customer: customer
        ? {
            _id: customer._id,
            name: customer.name,
          }
        : null,
      contractLaneMiles: contractLane?.miles ?? null,
    };
  },
});

/**
 * List the ACTIVE payment ledger rows for an invoice, oldest first.
 *
 * `loadInvoices.paidAmount`/`paymentReference`/`paymentDate` are only the
 * maintained aggregate snapshot (sum, and the *last* reference/date). This
 * exposes the individual rows so split / partial payments are visible —
 * each with its own date, reference, miles, and amount.
 */
export const listInvoicePayments = query({
  args: { invoiceId: v.id('loadInvoices') },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice || invoice.workosOrgId !== callerOrgId) return [];

    const rows = await ctx.db
      .query('invoicePayments')
      .withIndex('by_invoice', (q) => q.eq('invoiceId', args.invoiceId))
      .collect();

    return rows
      .filter((r) => r.status === 'ACTIVE')
      .map((r) => ({
        _id: r._id,
        amount: r.amount,
        miles: r.miles ?? null,
        paymentDate: r.paymentDate ?? null,
        reference: r.reference ?? null,
        note: r.note ?? null,
      }))
      // Oldest first. ISO 8601 dates sort lexically; undated rows sink to the end.
      .sort((a, b) => (a.paymentDate ?? '￿').localeCompare(b.paymentDate ?? '￿'));
  },
});

/**
 * Get invoice for a specific load
 */
export const getInvoiceByLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return null;

    const invoice = await ctx.db
      .query('loadInvoices')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .first();

    if (!invoice) return null;

    // Calculate amounts dynamically
    const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

    return {
      ...invoice,
      ...amounts,
    };
  },
});

/**
 * Count invoices by status
 */
// ✅ Optimized: Reads from aggregate table (1 read instead of 10,000+)
export const countInvoicesByStatus = query({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.object({
    MISSING_DATA: v.number(),
    DRAFT: v.number(),
    BILLED: v.number(),
    PENDING_PAYMENT: v.number(),
    PAID: v.number(),
    VOID: v.number(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // Read from organizationStats aggregate table (1 read)
    const stats = await ctx.db
      .query('organizationStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    if (!stats) {
      // Return zeros if stats don't exist yet (before migration)
      return {
        MISSING_DATA: 0,
        DRAFT: 0,
        BILLED: 0,
        PENDING_PAYMENT: 0,
        PAID: 0,
        VOID: 0,
        total: 0,
      };
    }

    // Calculate total from all invoice counts
    const total = Object.values(stats.invoiceCounts).reduce((sum, count) => sum + count, 0);

    return {
      MISSING_DATA: stats.invoiceCounts.MISSING_DATA,
      DRAFT: stats.invoiceCounts.DRAFT,
      BILLED: stats.invoiceCounts.BILLED,
      PENDING_PAYMENT: stats.invoiceCounts.PENDING_PAYMENT,
      PAID: stats.invoiceCounts.PAID,
      VOID: stats.invoiceCounts.VOID,
      total,
    };
  },
});

/**
 * Aggregate dollar figures for the Invoices page header stat-chips.
 *
 * - outstanding: open AR — sum of (totalAmount − paidAmount) across all
 *   finalized-but-unpaid invoices (BILLED + PENDING_PAYMENT) with a balance.
 * - overdue: the subset of `outstanding` whose dueDate is in the past.
 *
 * Reads only invoice docs (finalized invoices carry frozen amounts), so no
 * per-invoice enrichment. The take() per status must cover the FULL unpaid set
 * or `outstanding` silently undercounts (an earlier 5k cap dropped the newest
 * unpaid invoices once an org passed 5k open). 15k stays under the Convex
 * per-query read ceiling (~16k docs); an org that exceeds it should move these
 * sums into organizationStats/accountingPeriodStats (already materialized).
 */
export const getInvoiceSummary = query({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.object({
    outstanding: v.number(),
    overdue: v.number(),
    overdueCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    let outstanding = 0;
    let overdue = 0;
    let overdueCount = 0;

    for (const status of ['BILLED', 'PENDING_PAYMENT'] as const) {
      const invoices = await ctx.db
        .query('loadInvoices')
        .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', status))
        .take(15000);

      for (const inv of invoices) {
        const balance = (inv.totalAmount ?? 0) - (inv.paidAmount ?? 0);
        if (balance <= 0) continue;
        outstanding += balance;
        if (inv.dueDate && new Date(inv.dueDate).getTime() < now) {
          overdue += balance;
          overdueCount += 1;
        }
      }
    }

    return { outstanding, overdue, overdueCount };
  },
});

/**
 * Get invoice by ID (simple version for preview)
 */
export const getById = query({
  args: { invoiceId: v.id('loadInvoices') },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice || invoice.workosOrgId !== callerOrgId) return null;
    return invoice;
  },
});

/**
 * Get line items for an invoice - generated dynamically for DRAFT invoices
 */
export const getLineItems = query({
  args: { invoiceId: v.id('loadInvoices') },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) return [];
    if (invoice.workosOrgId !== callerOrgId) return [];

    // For finalized invoices, try stored line items first
    const isFinalized = ['BILLED', 'PENDING_PAYMENT', 'PAID'].includes(invoice.status);
    if (isFinalized) {
      const stored = await ctx.db
        .query('invoiceLineItems')
        .withIndex('by_invoice', (q) => q.eq('invoiceId', args.invoiceId))
        .collect();
      if (stored.length > 0) return stored;
      // Fall through to dynamic generation if no stored line items exist
    }

    // Generate line items dynamically (DRAFT/MISSING_DATA, or finalized without stored items)
    const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

    const load = await ctx.db.get(invoice.loadId);
    const contractLane = invoice.contractLaneId ? await ctx.db.get(invoice.contractLaneId) : null;

    const lineItems: any[] = [];

    if (amounts.subtotal > 0 && contractLane && load) {
      const isWildcard = contractLane.tripNumber === '*';
      const loadFacets = await getLoadFacets(ctx, load._id);
      let description: string;

      if (isWildcard) {
        description = `Extra Trips - ${loadFacets.hcr || 'Unknown HCR'} ${loadFacets.trip || 'Unknown Trip'}`;
      } else {
        description =
          contractLane.contractName ||
          `${loadFacets.hcr || 'Unknown HCR'} - ${loadFacets.trip || 'Unknown Trip'}`;
      }

      lineItems.push({
        _id: 'dynamic-freight' as any,
        _creationTime: 0,
        invoiceId: args.invoiceId,
        type: 'FREIGHT' as const,
        description,
        quantity: 1,
        rate: amounts.subtotal,
        amount: amounts.subtotal,
        createdAt: 0,
      });
    }

    if (amounts.fuelSurcharge > 0 && contractLane) {
      lineItems.push({
        _id: 'dynamic-fuel' as any,
        _creationTime: 0,
        invoiceId: args.invoiceId,
        type: 'FUEL' as const,
        description: `Fuel Surcharge (${contractLane.fuelSurchargeType || 'N/A'})`,
        quantity: 1,
        rate: amounts.fuelSurcharge,
        amount: amounts.fuelSurcharge,
        createdAt: 0,
      });
    }

    if (amounts.accessorialsTotal > 0 && load && contractLane) {
      const includedStops = contractLane.includedStops || 2;
      const extraStops = Math.max(0, (load.stopCount || 0) - includedStops);

      lineItems.push({
        _id: 'dynamic-accessorial' as any,
        _creationTime: 0,
        invoiceId: args.invoiceId,
        type: 'ACCESSORIAL' as const,
        description: `Stop-off charges (${extraStops} extra stops)`,
        quantity: extraStops,
        rate: contractLane.stopOffRate || 0,
        amount: amounts.accessorialsTotal,
        createdAt: 0,
      });
    }

    return lineItems;
  },
});

/**
 * Add a manual line item to an invoice. Used by the load-detail "Pay
 * adjustments" modal's billing-side preset chips (fuel charge, detention,
 * lumper, tolls, etc.).
 *
 * Only allowed on DRAFT/MISSING_DATA invoices — once an invoice has been
 * billed, further changes need to go through the credit-memo flow on the
 * Invoice page, not here.
 */
export const addLineItem = mutation({
  args: {
    invoiceId: v.id('loadInvoices'),
    type: v.union(
      v.literal('FREIGHT'),
      v.literal('FUEL'),
      v.literal('ACCESSORIAL'),
      v.literal('TAX'),
    ),
    description: v.string(),
    quantity: v.number(),
    rate: v.number(),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) throw new Error('Invoice not found');
    if (invoice.workosOrgId !== callerOrgId) throw new Error('Invoice not found');

    // Block edits on finalized invoices — those go through credit memos.
    if (invoice.status !== 'DRAFT' && invoice.status !== 'MISSING_DATA') {
      throw new Error(
        `Cannot add line items to a ${invoice.status.toLowerCase()} invoice. ` +
          'Use a credit memo from the Invoice page instead.',
      );
    }

    const amount = args.quantity * args.rate;
    const now = Date.now();

    const lineItemId = await ctx.db.insert('invoiceLineItems', {
      invoiceId: args.invoiceId,
      type: args.type,
      description: args.description,
      quantity: args.quantity,
      rate: args.rate,
      amount,
      createdAt: now,
    });

    return lineItemId;
  },
});

/**
 * Update an existing invoice line item's description and/or rate. Used by
 * the load-detail Pay Adjustments modal for inline edits.
 *
 * Mirrors `addLineItem`'s status guard — finalized invoices are immutable
 * outside the credit-memo flow.
 */
export const updateLineItem = mutation({
  args: {
    lineItemId: v.id('invoiceLineItems'),
    description: v.optional(v.string()),
    rate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const line = await ctx.db.get(args.lineItemId);
    if (!line) throw new Error('Line item not found');

    const invoice = await ctx.db.get(line.invoiceId);
    if (!invoice || invoice.workosOrgId !== callerOrgId) {
      throw new Error('Line item not found');
    }
    if (invoice.status !== 'DRAFT' && invoice.status !== 'MISSING_DATA') {
      throw new Error(
        `Cannot edit lines on a ${invoice.status.toLowerCase()} invoice. ` +
          'Use a credit memo from the Invoice page instead.',
      );
    }

    const patch: Record<string, unknown> = {};
    if (args.description !== undefined && args.description !== line.description) {
      patch.description = args.description;
    }
    if (args.rate !== undefined && args.rate !== line.rate) {
      patch.rate = args.rate;
      patch.amount = line.quantity * args.rate;
    }
    if (Object.keys(patch).length === 0) return;

    await ctx.db.patch(args.lineItemId, patch);
  },
});

/**
 * Remove an invoice line item. Hard delete — `invoiceLineItems` is a
 * derived-then-stored table, no soft-delete column. Mirrors `addLineItem`'s
 * status guard.
 */
export const removeLineItem = mutation({
  args: { lineItemId: v.id('invoiceLineItems') },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const line = await ctx.db.get(args.lineItemId);
    if (!line) return;

    const invoice = await ctx.db.get(line.invoiceId);
    if (!invoice || invoice.workosOrgId !== callerOrgId) {
      throw new Error('Line item not found');
    }
    if (invoice.status !== 'DRAFT' && invoice.status !== 'MISSING_DATA') {
      throw new Error(
        `Cannot remove lines from a ${invoice.status.toLowerCase()} invoice. ` +
          'Use a credit memo from the Invoice page instead.',
      );
    }

    await ctx.db.delete(args.lineItemId);
  },
});

/**
 * List invoices with cursor-based pagination for standard invoice tabs.
 * Supports infinite scroll via usePaginatedQuery on the frontend.
 */
export const listInvoices = query({
  args: {
    workosOrgId: v.string(),
    status: v.union(
      v.literal('DRAFT'),
      v.literal('BILLED'),
      v.literal('PENDING_PAYMENT'),
      v.literal('PAID'),
      v.literal('VOID'),
    ),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
    hcr: v.optional(v.string()),
    trip: v.optional(v.string()),
    loadType: v.optional(v.union(v.literal('CONTRACT'), v.literal('SPOT'), v.literal('UNMAPPED'))),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    // When true, keep only past-due invoices with an open balance. Applied
    // post-fetch alongside the other filters; used by the "Overdue" saved view
    // (callers pass status: 'PENDING_PAYMENT').
    overdueOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const searchTerm = args.search?.trim();

    // With a search term, run the full-text index over the denormalized
    // searchText (invoice # / order # / customer), scoped to this org + status.
    // This scans the WHOLE dataset — the old post-fetch filter only saw the
    // current page, so deep matches came back empty. Results are relevance-
    // ordered (so overdueOnly's date ordering doesn't apply while searching).
    const result = searchTerm
      ? await ctx.db
          .query('loadInvoices')
          .withSearchIndex('search_text', (q) =>
            q.search('searchText', searchTerm).eq('workosOrgId', args.workosOrgId).eq('status', args.status),
          )
          .paginate(args.paginationOpts)
      : await ctx.db
          .query('loadInvoices')
          .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', args.status))
          // Overdue invoices are the OLDEST unpaid ones; since overdueOnly is a
          // post-fetch page filter, newest-first ordering buries them under the
          // (current, not-overdue) recent invoices and the view comes back empty.
          // Ascending surfaces overdue on the first page. Other views keep desc.
          .order(args.overdueOnly ? 'asc' : 'desc')
          .paginate(args.paginationOpts);

    const enriched = await Promise.all(
      result.page.map(async (invoice) => {
        const load = await ctx.db.get(invoice.loadId);
        const customer = await ctx.db.get(invoice.customerId);
        const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);
        const loadFacets = load
          ? await getLoadFacets(ctx, load._id)
          : { hcr: undefined, trip: undefined, hcrCanonical: undefined, tripCanonical: undefined };

        return {
          ...invoice,
          ...amounts,
          load: load
            ? {
                _id: load._id,
                internalId: load.internalId,
                orderNumber: load.orderNumber,
                status: load.status,
                loadType: load.loadType,
                parsedHcr: loadFacets.hcr,
                parsedTripNumber: loadFacets.trip,
                // Canonical values attached for filter comparison below,
                // not exposed in the response payload shape.
                _hcrCanonical: loadFacets.hcrCanonical,
                _tripCanonical: loadFacets.tripCanonical,
              }
            : null,
          customer: customer
            ? {
                _id: customer._id,
                name: customer.name,
              }
            : null,
        };
      }),
    );

    // Search is handled server-side by the search index above. The remaining
    // chips (hcr, trip, loadType, dateRange, overdueOnly) filter the page.
    let filtered = enriched;

    if (args.hcr) {
      const canonical = args.hcr.trim().toUpperCase();
      filtered = filtered.filter((inv) => inv.load?._hcrCanonical === canonical);
    }
    if (args.trip) {
      const canonical = args.trip.trim().toUpperCase();
      filtered = filtered.filter((inv) => inv.load?._tripCanonical === canonical);
    }
    if (args.loadType) {
      filtered = filtered.filter((inv) => inv.load?.loadType === args.loadType);
    }
    if (args.dateRangeStart !== undefined) {
      filtered = filtered.filter((inv) => inv.createdAt >= args.dateRangeStart!);
    }
    if (args.dateRangeEnd !== undefined) {
      filtered = filtered.filter((inv) => inv.createdAt <= args.dateRangeEnd!);
    }
    if (args.overdueOnly) {
      const now = Date.now();
      filtered = filtered.filter((inv) => {
        const balance = (inv.totalAmount ?? 0) - (inv.paidAmount ?? 0);
        return balance > 0 && !!inv.dueDate && new Date(inv.dueDate).getTime() < now;
      });
    }

    // Strip internal canonical-helper fields before returning.
    const pageOut = filtered.map(({ load, ...rest }) => ({
      ...rest,
      load: load
        ? (() => {
            const { _hcrCanonical: _h, _tripCanonical: _t, ...publicLoad } =
              load as typeof load & {
                _hcrCanonical?: string;
                _tripCanonical?: string;
              };
            void _h;
            void _t;
            return publicLoad;
          })()
        : null,
    }));

    return {
      ...result,
      page: pageOut,
    };
  },
});

/**
 * Get distinct HCR and Trip values for filter dropdowns.
 * Scans invoices by status to provide complete filter options.
 */
export const getFilterOptions = query({
  args: {
    workosOrgId: v.string(),
    status: v.union(
      v.literal('DRAFT'),
      v.literal('BILLED'),
      v.literal('PENDING_PAYMENT'),
      v.literal('PAID'),
      v.literal('VOID'),
    ),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const invoices = await ctx.db
      .query('loadInvoices')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', args.status))
      .take(500);

    const hcrs = new Set<string>();
    const trips = new Set<string>();

    await Promise.all(
      invoices.map(async (invoice) => {
        const facets = await getLoadFacets(ctx, invoice.loadId);
        if (facets.hcr) hcrs.add(facets.hcr);
        if (facets.trip) trips.add(facets.trip);
      }),
    );

    return {
      hcrs: Array.from(hcrs).sort(),
      trips: Array.from(trips).sort(),
    };
  },
});

/**
 * Bulk update invoice status
 * Used for marking multiple invoices as PAID, PENDING_PAYMENT, etc.
 */
export const bulkUpdateStatus = mutation({
  args: {
    invoiceIds: v.array(v.id('loadInvoices')),
    workosOrgId: v.string(),
    newStatus: v.union(
      v.literal('DRAFT'),
      v.literal('BILLED'),
      v.literal('PENDING_PAYMENT'),
      v.literal('PAID'),
      v.literal('VOID'),
    ),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const results = { success: 0, failed: 0, errors: [] as string[] };
    const finalized = ['BILLED', 'PENDING_PAYMENT', 'PAID'];

    for (const invoiceId of args.invoiceIds) {
      try {
        const invoice = await ctx.db.get(invoiceId);

        if (!invoice || invoice.workosOrgId !== args.workosOrgId) {
          results.failed++;
          results.errors.push(`Invoice ${invoiceId} not found or access denied`);
          continue;
        }

        const oldStatus = invoice.status;
        const wasFinalized = finalized.includes(oldStatus);
        const willBeFinalized = finalized.includes(args.newStatus);

        // Every finalized invoice gets a number; existing numbers are kept.
        const invoiceNumber =
          willBeFinalized && !invoice.invoiceNumber
            ? await claimInvoiceNumber(ctx, args.workosOrgId, now)
            : invoice.invoiceNumber;

        // Issue/report under the load's service date on first finalization
        // (matches bulkMarkBilled); an existing anchor is always preserved.
        const anchor =
          invoice.invoiceDateNumeric ??
          (!wasFinalized && willBeFinalized ? await resolveServiceAnchor(ctx, invoice, now) : now);

        // Freeze amounts when moving from non-finalized → finalized
        if (!wasFinalized && willBeFinalized && invoice.totalAmount === undefined) {
          const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);
          await materializeLineItems(ctx, invoice, amounts, now);

          await ctx.db.patch(invoiceId, {
            status: args.newStatus,
            invoiceNumber,
            subtotal: amounts.subtotal,
            fuelSurcharge: amounts.fuelSurcharge,
            accessorialsTotal: amounts.accessorialsTotal,
            taxAmount: amounts.taxAmount,
            totalAmount: amounts.totalAmount,
            invoiceDate: invoice.invoiceDate ?? new Date(anchor).toISOString(),
            invoiceDateNumeric: anchor, // Set on first finalization only
            updatedAt: now,
          });
        } else {
          await ctx.db.patch(invoiceId, {
            status: args.newStatus,
            invoiceNumber,
            invoiceDateNumeric: anchor, // Set if missing (e.g., legacy data)
            updatedAt: now,
          });
        }

        // Number may have just been assigned — refresh the search haystack.
        await refreshInvoiceSearchText(ctx, invoiceId);

        await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, args.newStatus);

        // Update accounting period stats when invoice is finalized
        if (!wasFinalized && willBeFinalized) {
          const updatedInvoice = await ctx.db.get(invoiceId);
          const frozenAmount = updatedInvoice?.totalAmount ?? 0;
          const dateAnchor = updatedInvoice?.invoiceDateNumeric ?? now;
          if (frozenAmount > 0) {
            await recordInvoiceFinalized(ctx, invoice.workosOrgId, frozenAmount, dateAnchor);
          }
        }

        // Keep collected stats symmetric when an invoice with recorded payment
        // data moves into or out of PAID (e.g. restoring a voided paid invoice).
        const dateAnchor = invoice.invoiceDateNumeric ?? now;
        const recordedPaid = invoice.paidAmount ?? 0;
        if (recordedPaid > 0 && oldStatus !== 'PAID' && args.newStatus === 'PAID') {
          await recordPaymentCollected(ctx, invoice.workosOrgId, recordedPaid, 0, dateAnchor);
          // Settle into PAID: a PAID invoice owes $0, so drop its remaining
          // balance + open-item out of A/R (matches recordInvoicePayment).
          const curTotal = (await ctx.db.get(invoiceId))?.totalAmount ?? invoice.totalAmount ?? 0;
          await recordInvoiceSettled(ctx, invoice.workosOrgId, curTotal - recordedPaid, dateAnchor);
        } else if (recordedPaid > 0 && oldStatus === 'PAID' && args.newStatus !== 'PAID') {
          await reversePaymentCollected(ctx, invoice.workosOrgId, recordedPaid, dateAnchor);
        }

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to update ${invoiceId}: ${error}`);
      }
    }

    if (results.success > 0) {
      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'invoice',
        entityId: 'bulk',
        action: 'bulk_updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Updated status to ${args.newStatus} for ${results.success} invoices`,
        metadata: JSON.stringify({ count: results.success, status: args.newStatus }),
      });
    }

    return results;
  },
});

/**
 * Bulk bill DRAFT invoices — the "Ready to invoice → Sent" step.
 * Assigns the next per-org invoice number (INV-YYYY-NNNN), stamps the invoice
 * date, computes the due date from the customer's payment terms (default
 * Net 30), freezes amounts + line items, and moves to PENDING_PAYMENT so the
 * invoice shows up in AR tracking (Sent/Overdue views, outstanding stats).
 */
export const bulkMarkBilled = mutation({
  args: {
    invoiceIds: v.array(v.id('loadInvoices')),
    workosOrgId: v.string(),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const results = { success: 0, skipped: 0, failed: 0, errors: [] as string[] };

    for (const invoiceId of args.invoiceIds) {
      try {
        const invoice = await ctx.db.get(invoiceId);
        if (!invoice || invoice.workosOrgId !== args.workosOrgId) {
          results.failed++;
          results.errors.push(`Invoice ${invoiceId} not found or access denied`);
          continue;
        }
        // Only DRAFT invoices can be billed; anything else is left untouched.
        if (invoice.status !== 'DRAFT') {
          results.skipped++;
          continue;
        }

        // Fetch the load + contract lane ONCE and thread them through enrich,
        // materialize, and the service-date anchor — they'd otherwise each read
        // the same two docs (up to 5 redundant reads per invoice, ×40/chunk).
        const load = await ctx.db.get(invoice.loadId);
        const contractLane = invoice.contractLaneId ? await ctx.db.get(invoice.contractLaneId) : null;

        const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice, load, contractLane);
        await materializeLineItems(ctx, invoice, amounts, now, load, contractLane);

        // Re-billing after an undo reuses the previously assigned number.
        const invoiceNumber = invoice.invoiceNumber ?? (await claimInvoiceNumber(ctx, args.workosOrgId, now));
        const customer = await ctx.db.get(invoice.customerId);
        const termsDays = PAYMENT_TERMS_DAYS[customer?.paymentTerms ?? ''] ?? DEFAULT_TERMS_DAYS;

        // Issue/report the invoice under the load's service date, not today —
        // so a backlogged bulk-send lands in the month the work was performed.
        // A prior anchor (re-billing after undo) is preserved.
        const anchor = invoice.invoiceDateNumeric ?? (await resolveServiceAnchor(ctx, invoice, now, load));

        await ctx.db.patch(invoiceId, {
          status: 'PENDING_PAYMENT',
          invoiceNumber,
          invoiceDate: new Date(anchor).toISOString(),
          dueDate: new Date(anchor + termsDays * DAY_MS).toISOString(),
          subtotal: amounts.subtotal,
          fuelSurcharge: amounts.fuelSurcharge,
          accessorialsTotal: amounts.accessorialsTotal,
          taxAmount: amounts.taxAmount,
          totalAmount: amounts.totalAmount,
          invoiceDateNumeric: anchor,
          updatedAt: now,
        });

        await updateInvoiceCount(ctx, args.workosOrgId, 'DRAFT', 'PENDING_PAYMENT');
        if (amounts.totalAmount > 0) {
          await recordInvoiceFinalized(ctx, args.workosOrgId, amounts.totalAmount, anchor);
        }

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to bill ${invoiceId}: ${error}`);
      }
    }

    return results;
  },
});

/**
 * Undo of bulkMarkBilled: restore freshly billed invoices to DRAFT.
 * Clears the issue/due dates and unfreezes amounts (line items are removed so
 * a later re-bill regenerates them from current lane data). The assigned
 * invoice number is kept on the record and reused on re-bill, so the per-org
 * sequence stays gap-free.
 */
export const bulkUnmarkBilled = mutation({
  args: {
    invoiceIds: v.array(v.id('loadInvoices')),
    workosOrgId: v.string(),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const results = { success: 0, skipped: 0, failed: 0, errors: [] as string[] };

    for (const invoiceId of args.invoiceIds) {
      try {
        const invoice = await ctx.db.get(invoiceId);
        if (!invoice || invoice.workosOrgId !== args.workosOrgId) {
          results.failed++;
          results.errors.push(`Invoice ${invoiceId} not found or access denied`);
          continue;
        }
        // Only un-bill invoices that are sitting in PENDING_PAYMENT unpaid.
        if (invoice.status !== 'PENDING_PAYMENT' || (invoice.paidAmount ?? 0) > 0) {
          results.skipped++;
          continue;
        }

        const lineItems = await ctx.db
          .query('invoiceLineItems')
          .withIndex('by_invoice', (q) => q.eq('invoiceId', invoiceId))
          .collect();
        for (const item of lineItems) {
          await ctx.db.delete(item._id);
        }

        await ctx.db.patch(invoiceId, {
          status: 'DRAFT',
          invoiceDate: undefined,
          dueDate: undefined,
          subtotal: undefined,
          fuelSurcharge: undefined,
          accessorialsTotal: undefined,
          taxAmount: undefined,
          totalAmount: undefined,
          invoiceDateNumeric: undefined,
          updatedAt: now,
        });

        await updateInvoiceCount(ctx, args.workosOrgId, 'PENDING_PAYMENT', 'DRAFT');
        if ((invoice.totalAmount ?? 0) > 0) {
          await reverseInvoice(
            ctx,
            args.workosOrgId,
            invoice.totalAmount ?? 0,
            false,
            0,
            invoice.invoiceDateNumeric ?? invoice.createdAt,
          );
        }

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to un-bill ${invoiceId}: ${error}`);
      }
    }

    return results;
  },
});

/**
 * Bulk mark invoices as paid in full — the one-click manual confirmation.
 * Unlike the old generic status flip, this records real payment data
 * (paidAmount = frozen total, paymentDate = today) and updates collected
 * stats, so it produces the same shape as the CSV payment import.
 */
export const bulkMarkPaid = mutation({
  args: {
    invoiceIds: v.array(v.id('loadInvoices')),
    workosOrgId: v.string(),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const nowIso = new Date(Date.now()).toISOString();
    const results = { success: 0, skipped: 0, failed: 0, errors: [] as string[] };

    for (const invoiceId of args.invoiceIds) {
      try {
        const invoice = await ctx.db.get(invoiceId);
        if (!invoice || invoice.workosOrgId !== args.workosOrgId) {
          results.failed++;
          results.errors.push(`Invoice ${invoiceId} not found or access denied`);
          continue;
        }
        if (invoice.status === 'PAID' || invoice.status === 'VOID' || invoice.status === 'MISSING_DATA') {
          results.skipped++;
          continue;
        }

        // Settle the full remaining balance through the one primitive — records a
        // ledger row and keeps stats correct (fixes double-count when marking an
        // already-partially-paid invoice paid).
        await recordInvoicePayment(ctx, {
          invoice,
          payInFull: true,
          paymentDate: nowIso,
          reference: 'Manual confirmation',
          userId: args.updatedBy,
        });

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to mark ${invoiceId} paid: ${error}`);
      }
    }

    return results;
  },
});

/**
 * Undo of bulkMarkPaid: clear the manual payment data and restore the
 * invoice to the status it had before (DRAFT or PENDING_PAYMENT), reversing
 * the collected — and, when restoring to DRAFT, invoiced — stats.
 */
export const bulkUnmarkPaid = mutation({
  args: {
    invoiceIds: v.array(v.id('loadInvoices')),
    workosOrgId: v.string(),
    restoreStatus: v.union(v.literal('DRAFT'), v.literal('PENDING_PAYMENT')),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const results = { success: 0, skipped: 0, failed: 0, errors: [] as string[] };

    for (const invoiceId of args.invoiceIds) {
      try {
        const invoice = await ctx.db.get(invoiceId);
        if (!invoice || invoice.workosOrgId !== args.workosOrgId) {
          results.failed++;
          results.errors.push(`Invoice ${invoiceId} not found or access denied`);
          continue;
        }
        if (invoice.status !== 'PAID') {
          results.skipped++;
          continue;
        }

        const paidAmount = invoice.paidAmount ?? 0;
        const dateAnchor = invoice.invoiceDateNumeric ?? invoice.createdAt;

        if (args.restoreStatus === 'PENDING_PAYMENT') {
          // Back to "sent, awaiting payment": keep number, dates and frozen
          // amounts; just remove the payment record.
          await ctx.db.patch(invoiceId, {
            status: 'PENDING_PAYMENT',
            paidAmount: undefined,
            paymentDate: undefined,
            paymentReference: undefined,
            paymentDifference: undefined,
            paymentMiles: undefined,
            updatedAt: now,
          });
          if (paidAmount > 0) {
            await reversePaymentCollected(ctx, args.workosOrgId, paidAmount, dateAnchor);
          }
        } else {
          // Back to DRAFT: full unwind (mirrors resetPaidToDraft) so the
          // invoice re-freezes from current lane data when billed again. The
          // assigned invoice number is kept and reused on re-bill.
          const lineItems = await ctx.db
            .query('invoiceLineItems')
            .withIndex('by_invoice', (q) => q.eq('invoiceId', invoiceId))
            .collect();
          for (const item of lineItems) {
            await ctx.db.delete(item._id);
          }

          await ctx.db.patch(invoiceId, {
            status: 'DRAFT',
            paidAmount: undefined,
            paymentDate: undefined,
            paymentReference: undefined,
            paymentDifference: undefined,
            paymentMiles: undefined,
            invoiceDate: undefined,
            dueDate: undefined,
            subtotal: undefined,
            fuelSurcharge: undefined,
            accessorialsTotal: undefined,
            taxAmount: undefined,
            totalAmount: undefined,
            invoiceDateNumeric: undefined,
            updatedAt: now,
          });
          if (paidAmount > 0 || (invoice.totalAmount ?? 0) > 0) {
            await reversePaymentAndInvoice(
              ctx,
              args.workosOrgId,
              paidAmount,
              invoice.totalAmount ?? 0,
              dateAnchor,
            );
          }
        }

        await updateInvoiceCount(ctx, args.workosOrgId, 'PAID', args.restoreStatus);
        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to undo payment on ${invoiceId}: ${error}`);
      }
    }

    return results;
  },
});

/**
 * Bulk void invoices
 * Sets status to VOID and optionally adds a reason
 */
export const bulkVoidInvoices = mutation({
  args: {
    invoiceIds: v.array(v.id('loadInvoices')),
    workosOrgId: v.string(),
    reason: v.optional(v.string()),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const results = { success: 0, failed: 0, errors: [] as string[] };

    for (const invoiceId of args.invoiceIds) {
      try {
        const invoice = await ctx.db.get(invoiceId);

        // Security check: verify invoice belongs to organization
        if (!invoice || invoice.workosOrgId !== args.workosOrgId) {
          results.failed++;
          results.errors.push(`Invoice ${invoiceId} not found or access denied`);
          continue;
        }

        const oldStatus = invoice.status;

        await ctx.db.patch(invoiceId, {
          status: 'VOID',
          missingDataReason: args.reason,
          updatedAt: now,
        });

        // ✅ Update organization stats (aggregate table pattern)
        await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, 'VOID');

        // Reverse accounting stats if voiding from a finalized state
        const finalizedStatuses = ['BILLED', 'PENDING_PAYMENT', 'PAID'];
        if (finalizedStatuses.includes(oldStatus) && (invoice.totalAmount ?? 0) > 0) {
          const wasPaid = oldStatus === 'PAID';
          await reverseInvoice(
            ctx,
            invoice.workosOrgId,
            invoice.totalAmount ?? 0,
            wasPaid,
            invoice.paidAmount ?? 0,
            invoice.invoiceDateNumeric ?? invoice.createdAt,
          );
        }

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to void ${invoiceId}: ${error}`);
      }
    }

    if (results.success > 0) {
      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'invoice',
        entityId: 'bulk',
        action: 'voided',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Voided ${results.success} invoices`,
        metadata: JSON.stringify({ count: results.success }),
      });
    }

    return results;
  },
});

const paymentBatchArgs = {
  workosOrgId: v.string(),
  userId: v.string(),
  matchType: v.union(v.literal('invoiceNumber'), v.literal('orderNumber')),
  payments: v.array(
    v.object({
      matchKey: v.string(),
      paidAmount: v.number(),
      paymentDate: v.optional(v.string()),
      paymentReference: v.optional(v.string()),
      paymentMiles: v.optional(v.number()),
      // Client-computed idempotency key: content + a per-file occurrence index so
      // identical rows (no unique txn id) are distinct yet stable on re-import.
      importKey: v.string(),
    }),
  ),
};

/**
 * The one payment-recording primitive. Every payment entry point (single-invoice
 * UI, bulk mark-paid, CSV import) should funnel through this so miles, payment
 * difference, the `invoicePayments` ledger row, and accounting stats are always
 * maintained identically. Freezes the invoice on first payment, appends a ledger
 * row, recomputes the maintained aggregates on the invoice from the ACTIVE rows,
 * and applies an O(1) stats delta anchored to the invoice's immutable period.
 */
async function recordInvoicePayment(
  ctx: MutationCtx,
  args: {
    invoice: Doc<'loadInvoices'>;
    amount?: number; // required unless payInFull
    payInFull?: boolean; // settle the full remaining balance (amount is derived after freeze)
    miles?: number;
    paymentDate?: string;
    reference?: string;
    note?: string;
    closeShort?: boolean; // accept an underpayment as final (close the invoice)
    importKey?: string; // idempotency key for imported rows (skip if already applied)
    skipMigrate?: boolean; // imports: replace a pre-ledger paidAmount rather than preserve it
    userId: string;
  },
): Promise<{ duplicate: boolean; paidAmount: number; totalAmount: number; difference: number }> {
  const now = Date.now();
  let invoice = args.invoice;

  // 1. Finalize once: freeze amounts + claim invoice number + set the immutable
  //    period anchor, and count the invoiced side into stats exactly once.
  const needsFreeze =
    !['BILLED', 'PENDING_PAYMENT', 'PAID'].includes(invoice.status) || invoice.totalAmount === undefined;
  if (needsFreeze) {
    const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);
    await materializeLineItems(ctx, invoice, amounts, now);
    // Anchor a freshly-frozen invoice to its service date (same rule as billing).
    const freezeAnchor = invoice.invoiceDateNumeric ?? (await resolveServiceAnchor(ctx, invoice, now));
    await ctx.db.patch(invoice._id, {
      subtotal: amounts.subtotal,
      fuelSurcharge: amounts.fuelSurcharge,
      accessorialsTotal: amounts.accessorialsTotal,
      taxAmount: amounts.taxAmount,
      totalAmount: amounts.totalAmount,
      invoiceNumber: invoice.invoiceNumber ?? (await claimInvoiceNumber(ctx, invoice.workosOrgId, now)),
      invoiceDate: invoice.invoiceDate ?? new Date(freezeAnchor).toISOString(),
      invoiceDateNumeric: invoice.invoiceDateNumeric ?? freezeAnchor,
    });
    // Number may have just been assigned — refresh the search haystack.
    await refreshInvoiceSearchText(ctx, invoice._id);
    invoice = (await ctx.db.get(invoice._id))!;
  }

  const total = invoice.totalAmount ?? 0;
  const anchor = invoice.invoiceDateNumeric ?? now;

  // Count the invoiced side into stats exactly once. Record it only when we
  // actually finalized here (needsFreeze); an invoice that was already finalized
  // had its invoiced side recorded by whatever finalized it (bulkMarkBilled /
  // confirmPaymentChunk), so we just mark the flag — never double-count.
  if (!invoice.statsFinalized) {
    if (needsFreeze) {
      await recordInvoiceFinalized(ctx, invoice.workosOrgId, total, anchor);
    }
    await ctx.db.patch(invoice._id, { statsFinalized: true });
    invoice = (await ctx.db.get(invoice._id))!;
  }

  // 2. Migrate-on-touch: if the invoice carries a paidAmount recorded before the
  //    ledger existed (or otherwise not represented in ACTIVE rows), seed a
  //    synthetic row for the difference so the invariant "paidAmount = Σ ACTIVE
  //    rows" holds from the first touch. This is exactly what the one-time
  //    backfill does, applied lazily — keeping the primitive correct regardless
  //    of backfill state and preventing a recompute from clobbering prior
  //    non-ledger payments.
  const previousPaid = invoice.paidAmount ?? 0;
  const priorRows = await ctx.db
    .query('invoicePayments')
    .withIndex('by_invoice', (q) => q.eq('invoiceId', invoice._id))
    .collect();

  // Idempotency: an imported row whose importKey already exists on this invoice
  // was applied by a prior import — skip it so re-importing the full file never
  // double-counts. The invoice already reflects it (paidAmount = Σ ACTIVE rows).
  // Dedup regardless of ACTIVE/VOID: a row that was imported then intentionally
  // VOIDed must NOT be re-created by re-importing the same file.
  if (args.importKey && priorRows.some((r) => r.importKey === args.importKey)) {
    const total0 = invoice.totalAmount ?? 0;
    return {
      duplicate: true,
      paidAmount: previousPaid,
      totalAmount: total0,
      difference: Math.round((previousPaid - total0) * 100) / 100,
    };
  }

  const priorActiveSum = priorRows.filter((r) => r.status === 'ACTIVE').reduce((s, r) => s + r.amount, 0);
  // Migrate-on-touch preserves a pre-ledger paidAmount as a synthetic row so the
  // "paidAmount = Σ ACTIVE" invariant holds. Skipped for imports (skipMigrate):
  // the file is authoritative for customer payments, so an old — possibly buggy —
  // importer paidAmount must be REPLACED by the file's rows, not preserved.
  if (!args.skipMigrate && previousPaid > priorActiveSum + 0.005) {
    await ctx.db.insert('invoicePayments', {
      workosOrgId: invoice.workosOrgId,
      invoiceId: invoice._id,
      loadId: invoice.loadId,
      customerId: invoice.customerId,
      amount: Math.round((previousPaid - priorActiveSum) * 100) / 100,
      miles: invoice.paymentMiles,
      paymentDate: invoice.paymentDate,
      reference: invoice.paymentReference,
      note: 'Migrated from prior payment record',
      status: 'ACTIVE',
      createdBy: args.userId,
      createdAt: now,
    });
  }

  // The amount to record: an explicit amount, or (payInFull) the remaining
  // balance derived after freeze so "mark paid in full" settles exactly.
  const amount = args.payInFull
    ? Math.max(0, Math.round((total - previousPaid) * 100) / 100)
    : Math.round((args.amount ?? 0) * 100) / 100;

  // 3. Append this payment to the ledger (skip a no-op $0 settle). A negative
  //    amount is a valid correction (customer clawing back an overpayment); it
  //    nets against the positive rows in the recompute below.
  if (Math.abs(amount) >= 0.005) {
    await ctx.db.insert('invoicePayments', {
      workosOrgId: invoice.workosOrgId,
      invoiceId: invoice._id,
      loadId: invoice.loadId,
      customerId: invoice.customerId,
      amount,
      miles: args.miles,
      paymentDate: args.paymentDate,
      reference: args.reference,
      note: args.note,
      importKey: args.importKey,
      status: 'ACTIVE',
      createdBy: args.userId,
      createdAt: now,
    });
  }

  // 4. Recompute maintained aggregates from the ACTIVE ledger rows.
  const rows = await ctx.db
    .query('invoicePayments')
    .withIndex('by_invoice', (q) => q.eq('invoiceId', invoice._id))
    .collect();
  const active = rows.filter((r) => r.status === 'ACTIVE');
  const paidAmount = Math.round(active.reduce((s, r) => s + r.amount, 0) * 100) / 100;
  const milesSum = active.reduce((s, r) => s + (r.miles ?? 0), 0);
  const fullyPaid = paidAmount >= total - 0.005;
  const newStatus: Doc<'loadInvoices'>['status'] =
    fullyPaid || args.closeShort || args.payInFull ? 'PAID' : 'PENDING_PAYMENT';

  await ctx.db.patch(invoice._id, {
    paidAmount,
    paymentMiles: milesSum > 0 ? milesSum : undefined,
    paymentDifference: Math.round((paidAmount - total) * 100) / 100,
    paymentDate: args.paymentDate ?? invoice.paymentDate,
    paymentReference: args.reference ?? invoice.paymentReference,
    status: newStatus,
    updatedAt: now,
  });

  if (invoice.status !== newStatus) {
    await updateInvoiceCount(ctx, invoice.workosOrgId, invoice.status, newStatus);
  }

  // 5. Stats: add this payment's delta to collected, anchored to the invoice's
  //    immutable period. Passing (new cumulative, old cumulative) reuses the
  //    helper's delta + first-payment-count logic correctly. Skip on a $0 settle.
  if (Math.abs(amount) >= 0.005) {
    // invoice.status is still the PRE-patch status here — skip the A/R side when
    // the invoice was already PAID (it contributes $0 to Outstanding either way).
    await recordPaymentCollected(ctx, invoice.workosOrgId, paidAmount, previousPaid, anchor, invoice.status === 'PAID');
  }

  // 6. A/R: on the transition into PAID, drop the invoice out of Outstanding
  //    entirely — a PAID invoice owes $0 even on an accepted short-pay, so its
  //    remaining balance + open-item slot leave A/R (matching the recalc, which
  //    excludes PAID). recordPaymentCollected above only removed the paid delta,
  //    which would otherwise leave a short-pay residual stuck in Outstanding.
  if (newStatus === 'PAID' && invoice.status !== 'PAID') {
    await recordInvoiceSettled(ctx, invoice.workosOrgId, total - paidAmount, anchor);
  }

  return {
    duplicate: false,
    paidAmount,
    totalAmount: total,
    difference: Math.round((paidAmount - total) * 100) / 100,
  };
}

/**
 * Record a single customer payment against one invoice (manual entry). Supports
 * partial payments (invoice stays PENDING_PAYMENT with a balance) and accepting
 * a short-pay as final (`closeShort`). Routes through the shared primitive.
 */
export const recordSinglePayment = mutation({
  args: {
    workosOrgId: v.string(),
    invoiceId: v.id('loadInvoices'),
    userId: v.string(),
    amount: v.number(),
    miles: v.optional(v.number()),
    paymentDate: v.optional(v.string()),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    closeShort: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice || invoice.workosOrgId !== args.workosOrgId) throw new Error('Invoice not found');
    if (invoice.status === 'VOID' || invoice.status === 'MISSING_DATA') {
      throw new Error(`Cannot record a payment on a ${invoice.status} invoice`);
    }
    if (!(args.amount > 0)) throw new Error('Payment amount must be greater than zero');
    await recordInvoicePayment(ctx, {
      invoice,
      amount: args.amount,
      miles: args.miles,
      paymentDate: args.paymentDate,
      reference: args.reference,
      note: args.note,
      closeShort: args.closeShort,
      userId: args.userId,
    });
    return { ok: true };
  },
});

/**
 * Public mutation: process a single chunk of payment confirmations.
 * Called from the client in a loop so the UI can show progress between chunks.
 */
export const confirmPaymentChunk = mutation({
  args: paymentBatchArgs,
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const results = {
      success: 0,
      failed: 0,
      alreadyPaid: 0,
      notFound: [] as string[],
      noInvoice: [] as string[],
      discrepancies: [] as Array<{
        matchKey: string;
        invoicedAmount: number;
        paidAmount: number;
        difference: number;
      }>,
    };

    for (const payment of args.payments) {
      try {
        let invoice: Doc<'loadInvoices'> | null = null;
        const matchKey = payment.matchKey.trim();

        if (args.matchType === 'invoiceNumber') {
          const candidates = await ctx.db
            .query('loadInvoices')
            .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
            .filter((q) => q.eq(q.field('invoiceNumber'), matchKey))
            .take(1);
          invoice = candidates[0] ?? null;
        } else {
          // 1. Try orderNumber (e.g. "96073365")
          let load = await ctx.db
            .query('loadInformation')
            .withIndex('by_order_number', (q) => q.eq('workosOrgId', args.workosOrgId).eq('orderNumber', matchKey))
            .first();

          // 2. Try internalId directly (e.g. "96073365")
          if (!load) {
            load = await ctx.db
              .query('loadInformation')
              .withIndex('by_internal_id', (q) => q.eq('workosOrgId', args.workosOrgId).eq('internalId', matchKey))
              .first();
          }

          // 3. Try internalId with FK- prefix (e.g. "FK-96073365")
          if (!load) {
            load = await ctx.db
              .query('loadInformation')
              .withIndex('by_internal_id', (q) =>
                q.eq('workosOrgId', args.workosOrgId).eq('internalId', `FK-${matchKey}`),
              )
              .first();
          }

          // 4. Try externalLoadId (FourKites shipment ID) — both casing variants
          if (!load) {
            load = await ctx.db
              .query('loadInformation')
              .withIndex('by_external_id', (q) => q.eq('externalSource', 'FourKites').eq('externalLoadId', matchKey))
              .first();
            if (!load) {
              load = await ctx.db
                .query('loadInformation')
                .withIndex('by_external_id', (q) => q.eq('externalSource', 'FOURKITES').eq('externalLoadId', matchKey))
                .first();
            }
            if (load && load.workosOrgId !== args.workosOrgId) {
              load = null;
            }
          }

          // Load found but no invoice exists for it
          if (load && !invoice) {
            invoice = await ctx.db
              .query('loadInvoices')
              .withIndex('by_load', (q) => q.eq('loadId', load!._id))
              .first();
            if (!invoice) {
              results.noInvoice.push(matchKey);
              results.failed++;
              continue;
            }
          }
        }

        if (!invoice) {
          results.notFound.push(matchKey);
          results.failed++;
          continue;
        }

        if (invoice.workosOrgId !== args.workosOrgId) {
          results.notFound.push(matchKey);
          results.failed++;
          continue;
        }

        if (invoice.status === 'VOID' || invoice.status === 'MISSING_DATA') {
          // Can't record a payment on a void / missing-data invoice.
          results.failed++;
          continue;
        }

        // Funnel through the shared payment primitive so each row becomes a
        // ledger entry and paidAmount = Σ ACTIVE rows. This ACCUMULATES split
        // payments (multiple rows, even across chunks) instead of overwriting,
        // and the client-computed importKey (content + per-file occurrence index)
        // makes re-imports idempotent while keeping legitimate identical rows
        // distinct. skipMigrate: the file is authoritative, so any prior
        // (possibly buggy) importer paidAmount is replaced, not preserved.
        const res = await recordInvoicePayment(ctx, {
          invoice,
          amount: payment.paidAmount,
          miles: payment.paymentMiles,
          paymentDate: payment.paymentDate,
          reference: payment.paymentReference,
          importKey: payment.importKey,
          skipMigrate: true,
          closeShort: true, // an imported payment is the customer's final remittance
          userId: args.userId,
        });

        if (res.duplicate) {
          results.alreadyPaid++;
          continue;
        }

        // Material net over/underpayment (≥ $1; sub-dollar is per-mile rounding).
        if (Math.abs(res.difference) >= 1) {
          results.discrepancies.push({
            matchKey: payment.matchKey,
            invoicedAmount: res.totalAmount,
            paidAmount: res.paidAmount,
            difference: res.difference,
          });
        }

        results.success++;
      } catch (error) {
        results.failed++;
      }
    }

    if (results.success > 0) {
      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'invoice',
        entityId: 'bulk',
        action: 'bulk_updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Confirmed payment for ${results.success} invoices`,
        metadata: JSON.stringify({ count: results.success }),
      });
    }

    return results;
  },
});

/**
 * Bulk update load type classification (CONTRACT/SPOT)
 * Note: This updates the associated load, not the invoice directly
 */
export const bulkUpdateLoadType = mutation({
  args: {
    invoiceIds: v.array(v.id('loadInvoices')),
    workosOrgId: v.string(),
    newLoadType: v.union(v.literal('CONTRACT'), v.literal('SPOT'), v.literal('UNMAPPED')),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    const results = { success: 0, failed: 0, errors: [] as string[] };

    for (const invoiceId of args.invoiceIds) {
      try {
        const invoice = await ctx.db.get(invoiceId);

        // Security check: verify invoice belongs to organization
        if (!invoice || invoice.workosOrgId !== args.workosOrgId) {
          results.failed++;
          results.errors.push(`Invoice ${invoiceId} not found or access denied`);
          continue;
        }

        // Get the associated load
        const load = await ctx.db.get(invoice.loadId);
        if (!load) {
          results.failed++;
          results.errors.push(`Load not found for invoice ${invoiceId}`);
          continue;
        }

        // Update the load's type
        await ctx.db.patch(invoice.loadId, {
          loadType: args.newLoadType,
          updatedAt: now,
        });

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to update load type for ${invoiceId}: ${error}`);
      }
    }

    if (results.success > 0) {
      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'invoice',
        entityId: 'bulk',
        action: 'bulk_updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Updated load type to ${args.newLoadType} for ${results.success} invoices`,
        metadata: JSON.stringify({ count: results.success, loadType: args.newLoadType }),
      });
    }

    return results;
  },
});

/**
 * Diagnostic query: debug why a CSV match key isn't finding a load.
 * Searches all identifier fields and returns what was found at each step.
 */
export const debugLoadLookup = query({
  args: {
    workosOrgId: v.string(),
    searchValue: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const val = args.searchValue.trim();
    const results: Record<string, unknown> = { searchValue: val };

    // 1. orderNumber exact match
    const byOrder = await ctx.db
      .query('loadInformation')
      .withIndex('by_order_number', (q) => q.eq('workosOrgId', args.workosOrgId).eq('orderNumber', val))
      .first();
    results.byOrderNumber = byOrder
      ? {
          _id: byOrder._id,
          orderNumber: byOrder.orderNumber,
          internalId: byOrder.internalId,
          externalLoadId: byOrder.externalLoadId,
          externalSource: byOrder.externalSource,
        }
      : null;

    // 2. internalId exact match
    const byInternal = await ctx.db
      .query('loadInformation')
      .withIndex('by_internal_id', (q) => q.eq('workosOrgId', args.workosOrgId).eq('internalId', val))
      .first();
    results.byInternalId = byInternal
      ? { _id: byInternal._id, orderNumber: byInternal.orderNumber, internalId: byInternal.internalId }
      : null;

    // 3. internalId with FK- prefix
    const byFk = await ctx.db
      .query('loadInformation')
      .withIndex('by_internal_id', (q) => q.eq('workosOrgId', args.workosOrgId).eq('internalId', `FK-${val}`))
      .first();
    results.byFkPrefix = byFk ? { _id: byFk._id, orderNumber: byFk.orderNumber, internalId: byFk.internalId } : null;

    // 4. externalLoadId
    const byExt1 = await ctx.db
      .query('loadInformation')
      .withIndex('by_external_id', (q) => q.eq('externalSource', 'FourKites').eq('externalLoadId', val))
      .first();
    const byExt2 = !byExt1
      ? await ctx.db
          .query('loadInformation')
          .withIndex('by_external_id', (q) => q.eq('externalSource', 'FOURKITES').eq('externalLoadId', val))
          .first()
      : null;
    const byExt = byExt1 ?? byExt2;
    results.byExternalLoadId = byExt
      ? {
          _id: byExt._id,
          orderNumber: byExt.orderNumber,
          internalId: byExt.internalId,
          externalLoadId: byExt.externalLoadId,
          workosOrgId: byExt.workosOrgId,
        }
      : null;

    // 5. Brute-force: scan a sample of loads to find any containing this value
    const sampleLoads = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .take(500);

    const fuzzyMatch = sampleLoads.find(
      (l) =>
        l.orderNumber?.includes(val) ||
        l.internalId?.includes(val) ||
        l.externalLoadId?.includes(val) ||
        l.poNumber?.includes(val),
    );
    results.fuzzyMatchInFirst500 = fuzzyMatch
      ? {
          _id: fuzzyMatch._id,
          orderNumber: fuzzyMatch.orderNumber,
          internalId: fuzzyMatch.internalId,
          externalLoadId: fuzzyMatch.externalLoadId,
          poNumber: fuzzyMatch.poNumber,
        }
      : null;

    // 6. Sample of what identifiers look like in the org
    const firstFew = sampleLoads.slice(0, 5).map((l) => ({
      orderNumber: l.orderNumber,
      internalId: l.internalId,
      externalLoadId: l.externalLoadId,
      poNumber: l.poNumber,
    }));
    results.sampleLoadIdentifiers = firstFew;
    results.totalLoadsScanned = sampleLoads.length;

    // 7. If any load was found, check if it has an invoice
    const foundLoad = byOrder ?? byInternal ?? byFk ?? byExt ?? fuzzyMatch;
    if (foundLoad) {
      const invoice = await ctx.db
        .query('loadInvoices')
        .withIndex('by_load', (q) => q.eq('loadId', foundLoad._id))
        .first();
      results.hasInvoice = !!invoice;
      results.invoiceStatus = invoice?.status ?? null;
    }

    return results;
  },
});

/**
 * ONE-TIME: Reset all PAID invoices back to DRAFT so they can be re-imported
 * with proper line items and frozen amounts. Clears payment fields and deletes
 * any existing line items. Process in batches to avoid transaction limits.
 */
export const resetPaidToDraft = mutation({
  args: {
    workosOrgId: v.string(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const limit = args.batchSize ?? 100;
    const now = Date.now();

    const paidInvoices = await ctx.db
      .query('loadInvoices')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID'))
      .take(limit);

    let reset = 0;
    let lineItemsDeleted = 0;

    for (const invoice of paidInvoices) {
      const existingItems = await ctx.db
        .query('invoiceLineItems')
        .withIndex('by_invoice', (q) => q.eq('invoiceId', invoice._id))
        .collect();

      for (const item of existingItems) {
        await ctx.db.delete(item._id);
        lineItemsDeleted++;
      }

      await ctx.db.patch(invoice._id, {
        status: 'DRAFT',
        paidAmount: undefined,
        paymentDate: undefined,
        paymentReference: undefined,
        paymentDifference: undefined,
        paymentMiles: undefined,
        subtotal: undefined,
        fuelSurcharge: undefined,
        accessorialsTotal: undefined,
        taxAmount: undefined,
        totalAmount: undefined,
        invoiceDateNumeric: undefined, // Clear so it gets a fresh date on re-finalization
        updatedAt: now,
      });

      await updateInvoiceCount(ctx, invoice.workosOrgId, 'PAID', 'DRAFT');

      // Reverse accounting stats for this paid invoice
      if ((invoice.paidAmount ?? 0) > 0 || (invoice.totalAmount ?? 0) > 0) {
        await reversePaymentAndInvoice(
          ctx,
          invoice.workosOrgId,
          invoice.paidAmount ?? 0,
          invoice.totalAmount ?? 0,
          invoice.invoiceDateNumeric ?? invoice.createdAt,
        );
      }

      reset++;
    }

    if (reset > 0) {
      await logAudit(ctx, {
        organizationId: args.workosOrgId,
        entityType: 'invoice',
        entityId: 'bulk',
        action: 'bulk_updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Reset ${reset} paid invoices to draft`,
        metadata: JSON.stringify({ count: reset }),
      });
    }

    const remaining = await ctx.db
      .query('loadInvoices')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID'))
      .take(1);

    return {
      reset,
      lineItemsDeleted,
      hasMore: remaining.length > 0,
    };
  },
});

/**
 * ONE-TIME: Backfill invoice numbers for finalized invoices that predate
 * numbering. Assigns INV-YYYY-NNNN from the per-org yearly sequence in
 * createdAt order (chronological), anchoring the year to invoiceDateNumeric
 * when available. Call repeatedly until hasMore=false.
 *
 * Scans each finalized status via by_org_status_created (so drafts never
 * count against the transaction read budget) and merges the three candidate
 * streams by createdAt, preserving global chronological order across
 * statuses. Already-numbered invoices are skipped by the filter, so every
 * batch makes progress and the loop terminates.
 */
export const backfillInvoiceNumbers = mutation({
  args: {
    workosOrgId: v.string(),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const limit = args.batchSize ?? 200;
    const now = Date.now();

    const perStatus = await Promise.all(
      (['BILLED', 'PENDING_PAYMENT', 'PAID'] as const).map((status) =>
        ctx.db
          .query('loadInvoices')
          .withIndex('by_org_status_created', (q) =>
            q.eq('workosOrgId', args.workosOrgId).eq('status', status),
          )
          .order('asc')
          .filter((q) => q.eq(q.field('invoiceNumber'), undefined))
          .take(limit),
      ),
    );

    const candidates = perStatus
      .flat()
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);

    let numbered = 0;
    for (const invoice of candidates) {
      const anchor = invoice.invoiceDateNumeric ?? invoice.createdAt;
      const invoiceNumber = await claimInvoiceNumber(ctx, args.workosOrgId, anchor);
      await ctx.db.patch(invoice._id, { invoiceNumber, updatedAt: now });
      await refreshInvoiceSearchText(ctx, invoice._id);
      numbered++;
    }

    return {
      numbered,
      // A full batch means a status stream may have more behind it.
      hasMore: candidates.length === limit,
    };
  },
});
