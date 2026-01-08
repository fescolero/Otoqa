/**
 * Invoice Queries
 * Fetch invoice and line item data for accounting dashboard
 * 
 * Invoices are calculated dynamically based on load + contract lane data.
 * Amounts are only stored for BILLED/PAID/VOID status (frozen snapshot).
 */

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { calculateInvoiceAmounts, getZeroInvoiceAmounts } from "./invoiceCalculations";
import { Doc } from "./_generated/dataModel";

/**
 * Helper: Calculate invoice amounts dynamically
 */
async function enrichInvoiceWithCalculatedAmounts(
  ctx: any,
  invoice: Doc<"loadInvoices">
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
    contractLane
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
    status: v.optional(v.union(
      v.literal("MISSING_DATA"),
      v.literal("DRAFT"),
      v.literal("BILLED"),
      v.literal("PENDING_PAYMENT"),
      v.literal("PAID"),
      v.literal("VOID")
    )),
    customerId: v.optional(v.id("customers")),
  },
  handler: async (ctx, args) => {
    let query = ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId));

    if (args.status) {
      query = query.filter((q) => q.eq(q.field("status"), args.status));
    }

    if (args.customerId) {
      query = query.filter((q) => q.eq(q.field("customerId"), args.customerId));
    }

    const invoices = await query.order("desc").collect();

    // Enrich with load, customer info, and calculated amounts
    const enriched = await Promise.all(
      invoices.map(async (invoice) => {
        const load = await ctx.db.get(invoice.loadId);
        const customer = await ctx.db.get(invoice.customerId);
        const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

        return {
          ...invoice,
          ...amounts, // Add calculated amounts
          load: load ? {
            _id: load._id,
            internalId: load.internalId,
            orderNumber: load.orderNumber,
            status: load.status,
            loadType: load.loadType,
          } : null,
          customer: customer ? {
            _id: customer._id,
            name: customer.name,
          } : null,
        };
      })
    );

    return enriched;
  },
});

/**
 * Get single invoice with calculated amounts
 */
export const getInvoice = query({
  args: {
    invoiceId: v.id("loadInvoices"),
  },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) return null;

    // Calculate amounts dynamically
    const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

    // Get load and customer info
    const load = await ctx.db.get(invoice.loadId);
    const customer = await ctx.db.get(invoice.customerId);

    return {
      ...invoice,
      ...amounts,
      load: load ? {
        _id: load._id,
        internalId: load.internalId,
        orderNumber: load.orderNumber,
        status: load.status,
        loadType: load.loadType,
        parsedHcr: load.parsedHcr,
        parsedTripNumber: load.parsedTripNumber,
        effectiveMiles: load.effectiveMiles,
        stopCount: load.stopCount,
      } : null,
      customer: customer ? {
        _id: customer._id,
        name: customer.name,
      } : null,
    };
  },
});

/**
 * Get invoice for a specific load
 */
export const getInvoiceByLoad = query({
  args: {
    loadId: v.id("loadInformation"),
  },
  handler: async (ctx, args) => {
    const invoice = await ctx.db
      .query("loadInvoices")
      .withIndex("by_load", (q) => q.eq("loadId", args.loadId))
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
    // Read from organizationStats aggregate table (1 read)
    const stats = await ctx.db
      .query("organizationStats")
      .withIndex("by_org", (q) => q.eq("workosOrgId", args.workosOrgId))
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
  args: { invoiceId: v.id("loadInvoices") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.invoiceId);
  },
});

/**
 * Get line items for an invoice - generated dynamically for DRAFT invoices
 */
export const getLineItems = query({
  args: { invoiceId: v.id("loadInvoices") },
  handler: async (ctx, args) => {
    const invoice = await ctx.db.get(args.invoiceId);
    if (!invoice) return [];

    // For finalized invoices, return stored line items
    const isFinalized = ['BILLED', 'PENDING_PAYMENT', 'PAID'].includes(invoice.status);
    if (isFinalized) {
      return await ctx.db
        .query("invoiceLineItems")
        .withIndex("by_invoice", (q) => q.eq("invoiceId", args.invoiceId))
        .collect();
    }

    // For DRAFT/MISSING_DATA: generate line items dynamically
    const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);
    
    // Get load and contract lane for details
    const load = await ctx.db.get(invoice.loadId);
    const contractLane = invoice.contractLaneId 
      ? await ctx.db.get(invoice.contractLaneId)
      : null;

    const lineItems: any[] = [];

    // Generate freight line item
    if (amounts.subtotal > 0 && contractLane && load) {
      // For wildcard/SPOT loads (trip = *), show "Extra Trips - HCR TRIP"
      const isWildcard = contractLane.tripNumber === '*';
      let description: string;
      
      if (isWildcard) {
        description = `Extra Trips - ${load.parsedHcr || 'Unknown HCR'} ${load.parsedTripNumber || 'Unknown Trip'}`;
      } else {
        description = contractLane.contractName || 
          `${load.parsedHcr || 'Unknown HCR'} - ${load.parsedTripNumber || 'Unknown Trip'}`;
      }
      
      lineItems.push({
        _id: 'dynamic-freight' as any,
        _creationTime: Date.now(),
        invoiceId: args.invoiceId,
        type: 'FREIGHT' as const,
        description,
        quantity: 1,
        rate: amounts.subtotal,
        amount: amounts.subtotal,
        createdAt: Date.now(),
      });
    }

    // Generate fuel surcharge line item
    if (amounts.fuelSurcharge > 0 && contractLane) {
      lineItems.push({
        _id: 'dynamic-fuel' as any,
        _creationTime: Date.now(),
        invoiceId: args.invoiceId,
        type: 'FUEL' as const,
        description: `Fuel Surcharge (${contractLane.fuelSurchargeType || 'N/A'})`,
        quantity: 1,
        rate: amounts.fuelSurcharge,
        amount: amounts.fuelSurcharge,
        createdAt: Date.now(),
      });
    }

    // Generate accessorials line item
    if (amounts.accessorialsTotal > 0 && load && contractLane) {
      const includedStops = contractLane.includedStops || 2;
      const extraStops = Math.max(0, (load.stopCount || 0) - includedStops);
      
      lineItems.push({
        _id: 'dynamic-accessorial' as any,
        _creationTime: Date.now(),
        invoiceId: args.invoiceId,
        type: 'ACCESSORIAL' as const,
        description: `Stop-off charges (${extraStops} extra stops)`,
        quantity: extraStops,
        rate: contractLane.stopOffRate || 0,
        amount: amounts.accessorialsTotal,
        createdAt: Date.now(),
      });
    }

    return lineItems;
  },
});

/**
 * List invoices with pagination for standard invoice tabs
 * Used in Invoices dashboard for DRAFT, PENDING_PAYMENT, PAID, VOID tabs
 */
export const listInvoices = query({
  args: {
    workosOrgId: v.string(),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("BILLED"),
      v.literal("PENDING_PAYMENT"),
      v.literal("PAID"),
      v.literal("VOID")
    ),
    limit: v.optional(v.number()), // Default 50
    // Filter parameters
    search: v.optional(v.string()), // Search across orderNumber, customer name, invoiceNumber
    hcr: v.optional(v.string()),
    trip: v.optional(v.string()),
    loadType: v.optional(v.union(
      v.literal("CONTRACT"),
      v.literal("SPOT"),
      v.literal("UNMAPPED")
    )),
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 50;
    
    const invoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .filter((q) => q.eq(q.field("status"), args.status))
      .order("desc")
      .take(limit);

    // Enrich with load, customer info, and calculated amounts
    const enriched = await Promise.all(
      invoices.map(async (invoice) => {
        const load = await ctx.db.get(invoice.loadId);
        const customer = await ctx.db.get(invoice.customerId);
        const amounts = await enrichInvoiceWithCalculatedAmounts(ctx, invoice);

        return {
          ...invoice,
          ...amounts,
          load: load ? {
            _id: load._id,
            internalId: load.internalId,
            orderNumber: load.orderNumber,
            status: load.status,
            loadType: load.loadType,
            parsedHcr: load.parsedHcr,
            parsedTripNumber: load.parsedTripNumber,
          } : null,
          customer: customer ? {
            _id: customer._id,
            name: customer.name,
          } : null,
        };
      })
    );

    // Apply filters
    let filtered = enriched;

    // Search filter (orderNumber, customer name, invoiceNumber)
    if (args.search && args.search.trim() !== '') {
      const searchLower = args.search.toLowerCase().trim();
      filtered = filtered.filter((inv) => {
        const orderNumber = inv.load?.orderNumber?.toLowerCase() || '';
        const customerName = inv.customer?.name?.toLowerCase() || '';
        const invoiceNumber = inv.invoiceNumber?.toLowerCase() || '';
        const amount = inv.totalAmount?.toString() || '';
        
        return orderNumber.includes(searchLower) ||
               customerName.includes(searchLower) ||
               invoiceNumber.includes(searchLower) ||
               amount.includes(searchLower);
      });
    }

    // HCR filter
    if (args.hcr) {
      filtered = filtered.filter((inv) => inv.load?.parsedHcr === args.hcr);
    }

    // Trip filter
    if (args.trip) {
      filtered = filtered.filter((inv) => inv.load?.parsedTripNumber === args.trip);
    }

    // Load type filter
    if (args.loadType) {
      filtered = filtered.filter((inv) => inv.load?.loadType === args.loadType);
    }

    // Date range filter
    if (args.dateRangeStart !== undefined) {
      filtered = filtered.filter((inv) => inv.createdAt >= args.dateRangeStart!);
    }
    if (args.dateRangeEnd !== undefined) {
      filtered = filtered.filter((inv) => inv.createdAt <= args.dateRangeEnd!);
    }

    return filtered;
  },
});

/**
 * Bulk update invoice status
 * Used for marking multiple invoices as PAID, PENDING_PAYMENT, etc.
 */
export const bulkUpdateStatus = mutation({
  args: {
    invoiceIds: v.array(v.id("loadInvoices")),
    workosOrgId: v.string(),
    newStatus: v.union(
      v.literal("DRAFT"),
      v.literal("BILLED"),
      v.literal("PENDING_PAYMENT"),
      v.literal("PAID"),
      v.literal("VOID")
    ),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
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
          status: args.newStatus,
          updatedAt: now,
        });

        // ✅ Update organization stats (aggregate table pattern)
        const { updateInvoiceCount } = await import("./stats_helpers");
        await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, args.newStatus);

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
    invoiceIds: v.array(v.id("loadInvoices")),
    workosOrgId: v.string(),
    reason: v.optional(v.string()),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
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
          status: "VOID",
          missingDataReason: args.reason,
          updatedAt: now,
        });

        // ✅ Update organization stats (aggregate table pattern)
        const { updateInvoiceCount } = await import("./stats_helpers");
        await updateInvoiceCount(ctx, invoice.workosOrgId, oldStatus, "VOID");

        results.success++;
      } catch (error) {
        results.failed++;
        results.errors.push(`Failed to void ${invoiceId}: ${error}`);
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
    invoiceIds: v.array(v.id("loadInvoices")),
    workosOrgId: v.string(),
    newLoadType: v.union(
      v.literal("CONTRACT"),
      v.literal("SPOT"),
      v.literal("UNMAPPED")
    ),
    updatedBy: v.string(), // WorkOS user ID
  },
  handler: async (ctx, args) => {
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
