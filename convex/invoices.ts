/**
 * Invoice Queries
 * Fetch invoice and line item data for accounting dashboard
 *
 * Invoices are calculated dynamically based on load + contract lane data.
 * Amounts are only stored for BILLED/PAID/VOID status (frozen snapshot).
 */

import { query, mutation, internalMutation, action } from './_generated/server';
import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { calculateInvoiceAmounts, getZeroInvoiceAmounts } from './invoiceCalculations';
import { Doc } from './_generated/dataModel';
import { updateInvoiceCount } from './stats_helpers';
import {
  recordInvoiceFinalized,
  recordPaymentCollected,
  reverseInvoice,
  reversePaymentAndInvoice,
} from './accountingStatsHelpers';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';

/**
 * Helper: Calculate invoice amounts dynamically
 */
async function enrichInvoiceWithCalculatedAmounts(ctx: any, invoice: Doc<'loadInvoices'>) {
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
  const load = await ctx.db.get(invoice.loadId);

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
  const contractLane = await ctx.db.get(invoice.contractLaneId);
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
            parsedHcr: load.parsedHcr,
            parsedTripNumber: load.parsedTripNumber,
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
      let description: string;

      if (isWildcard) {
        description = `Extra Trips - ${load.parsedHcr || 'Unknown HCR'} ${load.parsedTripNumber || 'Unknown Trip'}`;
      } else {
        description =
          contractLane.contractName ||
          `${load.parsedHcr || 'Unknown HCR'} - ${load.parsedTripNumber || 'Unknown Trip'}`;
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
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const result = await ctx.db
      .query('loadInvoices')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', args.status))
      .order('desc')
      .paginate(args.paginationOpts);

    const enriched = await Promise.all(
      result.page.map(async (invoice) => {
        const load = await ctx.db.get(invoice.loadId);
        const customer = await ctx.db.get(invoice.customerId);
        const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

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
                parsedHcr: load.parsedHcr,
                parsedTripNumber: load.parsedTripNumber,
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

    // Apply post-fetch filters (search, hcr, trip, loadType, dateRange)
    let filtered = enriched;

    if (args.search && args.search.trim() !== '') {
      const searchLower = args.search.toLowerCase().trim();
      filtered = filtered.filter((inv) => {
        const orderNumber = inv.load?.orderNumber?.toLowerCase() || '';
        const customerName = inv.customer?.name?.toLowerCase() || '';
        const invoiceNumber = inv.invoiceNumber?.toLowerCase() || '';
        const amount = inv.totalAmount?.toString() || '';
        return (
          orderNumber.includes(searchLower) ||
          customerName.includes(searchLower) ||
          invoiceNumber.includes(searchLower) ||
          amount.includes(searchLower)
        );
      });
    }

    if (args.hcr) {
      filtered = filtered.filter((inv) => inv.load?.parsedHcr === args.hcr);
    }
    if (args.trip) {
      filtered = filtered.filter((inv) => inv.load?.parsedTripNumber === args.trip);
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

    return {
      ...result,
      page: filtered,
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
        const load = await ctx.db.get(invoice.loadId);
        if (load?.parsedHcr) hcrs.add(load.parsedHcr);
        if (load?.parsedTripNumber) trips.add(load.parsedTripNumber);
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
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
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

        // Freeze amounts when moving from non-finalized → finalized
        if (!wasFinalized && willBeFinalized && invoice.totalAmount === undefined) {
          const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

          // Store line items if none exist
          const existingItems = await ctx.db
            .query('invoiceLineItems')
            .withIndex('by_invoice', (q) => q.eq('invoiceId', invoiceId))
            .take(1);

          if (existingItems.length === 0) {
            const load = await ctx.db.get(invoice.loadId);
            const contractLane = invoice.contractLaneId ? await ctx.db.get(invoice.contractLaneId) : null;

            if (amounts.subtotal > 0 && contractLane && load) {
              const isWildcard = (contractLane as any).tripNumber === '*';
              const desc = isWildcard
                ? `Extra Trips - ${(load as any).parsedHcr || 'Unknown HCR'} ${(load as any).parsedTripNumber || 'Unknown Trip'}`
                : (contractLane as any).contractName ||
                  `${(load as any).parsedHcr || 'Unknown HCR'} - ${(load as any).parsedTripNumber || 'Unknown Trip'}`;

              await ctx.db.insert('invoiceLineItems', {
                invoiceId,
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
                invoiceId,
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
                invoiceId,
                type: 'ACCESSORIAL',
                description: `Stop-off charges (${extraStops} extra stops)`,
                quantity: extraStops,
                rate: (contractLane as any).stopOffRate || 0,
                amount: amounts.accessorialsTotal,
                createdAt: now,
              });
            }
          }

          await ctx.db.patch(invoiceId, {
            status: args.newStatus,
            subtotal: amounts.subtotal,
            fuelSurcharge: amounts.fuelSurcharge,
            accessorialsTotal: amounts.accessorialsTotal,
            taxAmount: amounts.taxAmount,
            totalAmount: amounts.totalAmount,
            invoiceDateNumeric: invoice.invoiceDateNumeric ?? now, // Set on first finalization only
            updatedAt: now,
          });
        } else {
          await ctx.db.patch(invoiceId, {
            status: args.newStatus,
            invoiceDateNumeric: invoice.invoiceDateNumeric ?? now, // Set if missing (e.g., legacy data)
            updatedAt: now,
          });
        }

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

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to update ${invoiceId}: ${error}`);
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
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
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

    return results;
  },
});

const PAYMENT_BATCH_SIZE = 25;

const paymentBatchArgs = {
  workosOrgId: v.string(),
  matchType: v.union(v.literal('invoiceNumber'), v.literal('orderNumber')),
  payments: v.array(
    v.object({
      matchKey: v.string(),
      paidAmount: v.number(),
      paymentDate: v.optional(v.string()),
      paymentReference: v.optional(v.string()),
      paymentMiles: v.optional(v.number()),
    }),
  ),
};

/**
 * Internal mutation: process a small batch of payment confirmations.
 * Called by the confirmPaymentBatch action in chunks to stay within transaction limits.
 */
export const processPaymentChunk = internalMutation({
  args: paymentBatchArgs,
  handler: async (ctx, args) => {
    const now = Date.now();
    const results = {
      success: 0,
      failed: 0,
      notFound: [] as string[],
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

        if (args.matchType === 'invoiceNumber') {
          const candidates = await ctx.db
            .query('loadInvoices')
            .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
            .filter((q) => q.eq(q.field('invoiceNumber'), payment.matchKey))
            .take(1);
          invoice = candidates[0] ?? null;
        } else {
          // Try orderNumber first, then internalId, then FK-prefixed internalId
          let load = await ctx.db
            .query('loadInformation')
            .withIndex('by_order_number', (q) =>
              q.eq('workosOrgId', args.workosOrgId).eq('orderNumber', payment.matchKey),
            )
            .first();

          if (!load) {
            load = await ctx.db
              .query('loadInformation')
              .withIndex('by_internal_id', (q) =>
                q.eq('workosOrgId', args.workosOrgId).eq('internalId', payment.matchKey),
              )
              .first();
          }

          if (!load) {
            load = await ctx.db
              .query('loadInformation')
              .withIndex('by_internal_id', (q) =>
                q.eq('workosOrgId', args.workosOrgId).eq('internalId', `FK-${payment.matchKey}`),
              )
              .first();
          }

          if (load) {
            invoice = await ctx.db
              .query('loadInvoices')
              .withIndex('by_load', (q) => q.eq('loadId', load._id))
              .first();
          }
        }

        if (!invoice) {
          results.notFound.push(payment.matchKey);
          results.failed++;
          continue;
        }

        if (invoice.workosOrgId !== args.workosOrgId) {
          results.notFound.push(payment.matchKey);
          results.failed++;
          continue;
        }

        const invoicedAmount = invoice.totalAmount ?? 0;
        const difference = payment.paidAmount - invoicedAmount;
        const oldStatus = invoice.status;

        await ctx.db.patch(invoice._id, {
          status: 'PAID',
          paidAmount: payment.paidAmount,
          paymentDate: payment.paymentDate,
          paymentReference: payment.paymentReference,
          paymentDifference: difference,
          updatedAt: now,
        });

        if (oldStatus !== 'PAID') {
          await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, 'PAID');
        }

        if (Math.abs(difference) > 0.005) {
          results.discrepancies.push({
            matchKey: payment.matchKey,
            invoicedAmount,
            paidAmount: payment.paidAmount,
            difference,
          });
        }

        results.success++;
      } catch (error) {
        results.failed++;
      }
    }

    return results;
  },
});

/**
 * Public mutation: process a single chunk of payment confirmations.
 * Called from the client in a loop so the UI can show progress between chunks.
 */
export const confirmPaymentChunk = mutation({
  args: paymentBatchArgs,
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
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

        // Duplicate protection: skip if already PAID with the same amount
        if (
          invoice.status === 'PAID' &&
          invoice.paidAmount !== undefined &&
          Math.abs(invoice.paidAmount - payment.paidAmount) < 0.005
        ) {
          results.alreadyPaid++;
          continue;
        }

        const oldStatus = invoice.status;
        const needsFreeze =
          !['BILLED', 'PENDING_PAYMENT', 'PAID'].includes(oldStatus) || invoice.totalAmount === undefined;

        let invoicedAmount = invoice.totalAmount ?? 0;
        if (needsFreeze) {
          const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);
          invoicedAmount = amounts.totalAmount;

          const load = await ctx.db.get(invoice.loadId);
          const contractLane = invoice.contractLaneId ? await ctx.db.get(invoice.contractLaneId) : null;

          if (amounts.subtotal > 0 && contractLane && load) {
            const isWildcard = (contractLane as any).tripNumber === '*';
            const desc = isWildcard
              ? `Extra Trips - ${(load as any).parsedHcr || 'Unknown HCR'} ${(load as any).parsedTripNumber || 'Unknown Trip'}`
              : (contractLane as any).contractName ||
                `${(load as any).parsedHcr || 'Unknown HCR'} - ${(load as any).parsedTripNumber || 'Unknown Trip'}`;

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

          await ctx.db.patch(invoice._id, {
            subtotal: amounts.subtotal,
            fuelSurcharge: amounts.fuelSurcharge,
            accessorialsTotal: amounts.accessorialsTotal,
            taxAmount: amounts.taxAmount,
            totalAmount: amounts.totalAmount,
            invoiceDateNumeric: invoice.invoiceDateNumeric ?? now, // Set on first finalization
          });
        }

        const difference = payment.paidAmount - invoicedAmount;

        await ctx.db.patch(invoice._id, {
          status: 'PAID',
          paidAmount: payment.paidAmount,
          paymentDate: payment.paymentDate,
          paymentReference: payment.paymentReference,
          paymentMiles: payment.paymentMiles,
          paymentDifference: difference,
          invoiceDateNumeric: invoice.invoiceDateNumeric ?? now, // Ensure set even if skipping freeze
          updatedAt: now,
        });

        if (oldStatus !== 'PAID') {
          await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, 'PAID');
        }

        // Update accounting period stats
        const dateAnchor = invoice.invoiceDateNumeric ?? now;
        if (needsFreeze && invoicedAmount > 0) {
          // Invoice was finalized AND paid in one step (DRAFT->PAID skip of BILLED)
          await recordInvoiceFinalized(ctx, invoice.workosOrgId, invoicedAmount, dateAnchor);
        }
        const previousPaidAmount = oldStatus === 'PAID' ? (invoice.paidAmount ?? 0) : 0;
        await recordPaymentCollected(ctx, invoice.workosOrgId, payment.paidAmount, previousPaidAmount, dateAnchor);

        if (Math.abs(difference) > 0.005) {
          results.discrepancies.push({
            matchKey: payment.matchKey,
            invoicedAmount,
            paidAmount: payment.paidAmount,
            difference,
          });
        }

        results.success++;
      } catch (error) {
        results.failed++;
      }
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
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
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
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
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
