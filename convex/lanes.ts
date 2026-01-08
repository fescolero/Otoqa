/**
 * Lane Management Mutations
 * Handle contract lane creation and invoice backfill for unmapped loads
 */

import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Preview Backfill Impact
 * Shows which loads would be affected by creating a contract lane with given date range
 * Used in FixLaneModal to show live preview before executing
 */
export const previewBackfillImpact = query({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.string(),
    contractStartDate: v.string(), // YYYY-MM-DD
    contractEndDate: v.string(),   // YYYY-MM-DD
  },
  handler: async (ctx, args) => {
    // Find all loads matching this HCR+Trip pattern
    const candidateLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_hcr_trip", (q) =>
        q.eq("workosOrgId", args.workosOrgId)
         .eq("parsedHcr", args.hcr)
         .eq("parsedTripNumber", args.tripNumber)
      )
      .filter((q) => q.eq(q.field("loadType"), "UNMAPPED"))
      .collect();

    // Convert date strings to timestamps for comparison
    const startTimestamp = new Date(args.contractStartDate).getTime();
    const endTimestamp = new Date(args.contractEndDate).getTime();

    // Filter by date range
    const affectedLoads = candidateLoads.filter((load) => {
      return load.createdAt >= startTimestamp && load.createdAt <= endTimestamp;
    });

    // Get invoices for affected loads
    const invoices = await Promise.all(
      affectedLoads.map((load) =>
        ctx.db
          .query("loadInvoices")
          .withIndex("by_load", (q) => q.eq("loadId", load._id))
          .first()
      )
    );

    // Calculate estimated revenue
    const estimatedRevenue = invoices.reduce((sum, inv) => sum + (inv?.subtotal || 0), 0);

    return {
      affectedLoadIds: affectedLoads.map((load) => load._id),
      affectedLoads: affectedLoads.map((load) => ({
        _id: load._id,
        internalId: load.internalId,
        orderNumber: load.orderNumber,
        createdAt: load.createdAt,
        status: load.status,
      })),
      count: affectedLoads.length,
      estimatedRevenue,
    };
  },
});

/**
 * Create Lane and Backfill Invoices
 * 1. Creates a contract lane (or finds existing customer)
 * 2. Updates affected loads from UNMAPPED to CONTRACT/SPOT
 * 3. Moves invoices from MISSING_DATA to DRAFT
 * 4. Generates invoice line items based on contract rates
 */
export const createLaneAndBackfill = mutation({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.string(),
    
    // Customer info (for new or existing customer)
    customerName: v.string(),
    customerOffice: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    
    // Contract details
    contractName: v.string(),
    contractStartDate: v.string(), // YYYY-MM-DD
    contractEndDate: v.string(),   // YYYY-MM-DD
    
    // Rate information
    rate: v.number(),
    rateType: v.union(v.literal("Per Mile"), v.literal("Flat Rate"), v.literal("Per Stop")),
    currency: v.union(v.literal("USD"), v.literal("CAD"), v.literal("MXN")),
    
    // Optional: Fuel surcharge
    fuelSurchargeType: v.optional(v.union(
      v.literal("PERCENTAGE"),
      v.literal("FLAT"),
      v.literal("DOE_INDEX")
    )),
    fuelSurchargeValue: v.optional(v.number()),
    
    // Optional: Stop-off charges
    stopOffRate: v.optional(v.number()),
    includedStops: v.optional(v.number()), // Default 2 (pickup + delivery)
    
    // Is wildcard match (affects loadType: SPOT vs CONTRACT)
    isWildcard: v.boolean(),
    
    // Granular selection (optional - if not provided, all matching loads are backfilled)
    selectedLoadIds: v.optional(v.array(v.id("loadInformation"))),
    
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    // Step 1: Ensure customer exists
    let finalCustomerId = args.customerId;
    
    if (!finalCustomerId) {
      // Check if customer already exists by name AND office (to handle duplicates like USPS Chicago vs USPS NYC)
      const existingCustomer = await ctx.db
        .query("customers")
        .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
        .filter((q) => 
          q.and(
            q.eq(q.field("name"), args.customerName),
            q.eq(q.field("office"), args.customerOffice || undefined)
          )
        )
        .first();
      
      if (existingCustomer) {
        finalCustomerId = existingCustomer._id;
      } else {
        // Create new customer
        finalCustomerId = await ctx.db.insert("customers", {
          name: args.customerName,
          office: args.customerOffice,
          companyType: "Shipper",
          status: "Active",
          addressLine1: "TBD",
          city: "TBD",
          state: "TBD",
          zip: "00000",
          country: "USA",
          workosOrgId: args.workosOrgId,
          createdBy: args.createdBy,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isDeleted: false,
        });
      }
    }

    // Step 2: Create contract lane (skip for SPOT loads to avoid wasted storage)
    let laneId = undefined;
    if (!args.isWildcard) {
      laneId = await ctx.db.insert("contractLanes", {
        workosOrgId: args.workosOrgId,
        customerCompanyId: finalCustomerId,
        contractName: args.contractName,
        contractPeriodStart: args.contractStartDate,
        contractPeriodEnd: args.contractEndDate,
        hcr: args.hcr,
        tripNumber: args.tripNumber,
        rate: args.rate,
        rateType: args.rateType,
        currency: args.currency,
        fuelSurchargeType: args.fuelSurchargeType,
        fuelSurchargeValue: args.fuelSurchargeValue,
        stopOffRate: args.stopOffRate,
        includedStops: args.includedStops || 2,
        stops: [], // User can add stops later
        isActive: true,
        isDeleted: false,
        createdBy: args.createdBy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Step 3: Find affected loads
    const startTimestamp = new Date(args.contractStartDate).getTime();
    const endTimestamp = new Date(args.contractEndDate).getTime();
    
    const candidateLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_hcr_trip", (q) =>
        q.eq("workosOrgId", args.workosOrgId)
         .eq("parsedHcr", args.hcr)
         .eq("parsedTripNumber", args.tripNumber)
      )
      .filter((q) => q.eq(q.field("loadType"), "UNMAPPED"))
      .collect();

    // Filter by date range and granular selection (if provided)
    let affectedLoads = candidateLoads.filter((load) => {
      const inDateRange = load.createdAt >= startTimestamp && load.createdAt <= endTimestamp;
      const isSelected = !args.selectedLoadIds || args.selectedLoadIds.includes(load._id);
      return inDateRange && isSelected;
    });

    // Step 4: Update loads and invoices
    let updatedCount = 0;
    let totalRevenue = 0;

    for (const load of affectedLoads) {
      try {
        // Update load
        await ctx.db.patch(load._id, {
          loadType: args.isWildcard ? "SPOT" : "CONTRACT",
          customerId: finalCustomerId,
          customerName: args.customerName,
          requiresManualReview: args.isWildcard,
          updatedAt: Date.now(),
        });

        // Find invoice
        const invoice = await ctx.db
          .query("loadInvoices")
          .withIndex("by_load", (q) => q.eq("loadId", load._id))
          .first();

        if (!invoice) continue;

        // Calculate billing amounts
        const stopCount = load.stopCount || 2;
        const includedStops = args.includedStops || 2;
        const extraStops = Math.max(0, stopCount - includedStops);
        
        let baseRate = 0;
        if (args.rateType === "Per Mile" && load.contractMiles) {
          baseRate = args.rate * load.contractMiles;
        } else if (args.rateType === "Flat Rate") {
          baseRate = args.rate;
        } else if (args.rateType === "Per Stop") {
          baseRate = args.rate * stopCount;
        }

        let fuelSurcharge = 0;
        if (args.fuelSurchargeType === "PERCENTAGE" && args.fuelSurchargeValue) {
          fuelSurcharge = baseRate * (args.fuelSurchargeValue / 100);
        } else if (args.fuelSurchargeType === "FLAT" && args.fuelSurchargeValue) {
          fuelSurcharge = args.fuelSurchargeValue;
        }

        const stopOffCharges = extraStops * (args.stopOffRate || 0);
        const subtotal = baseRate;
        const totalAmount = subtotal + fuelSurcharge + stopOffCharges;

        // Update invoice to DRAFT
        const oldInvoiceStatus = invoice.status;
        
        await ctx.db.patch(invoice._id, {
          status: "DRAFT",
          customerId: finalCustomerId,
          subtotal,
          fuelSurcharge: fuelSurcharge > 0 ? fuelSurcharge : undefined,
          accessorialsTotal: stopOffCharges > 0 ? stopOffCharges : undefined,
          totalAmount,
          missingDataReason: undefined, // Clear error message
          updatedAt: Date.now(),
        });

        // ✅ Update organization stats (MISSING_DATA → DRAFT)
        const { updateInvoiceCount } = await import("./stats_helpers");
        await updateInvoiceCount(ctx, args.workosOrgId, oldInvoiceStatus, "DRAFT");

        // Delete existing line items (if any)
        const existingLineItems = await ctx.db
          .query("invoiceLineItems")
          .withIndex("by_invoice", (q) => q.eq("invoiceId", invoice._id))
          .collect();
        
        for (const item of existingLineItems) {
          await ctx.db.delete(item._id);
        }

        // Create new line items
        // Freight (base rate)
        await ctx.db.insert("invoiceLineItems", {
          invoiceId: invoice._id,
          type: "FREIGHT",
          description: `Freight: ${args.contractName}`,
          quantity: 1,
          rate: baseRate,
          amount: baseRate,
          createdAt: Date.now(),
        });

        // Fuel surcharge
        if (fuelSurcharge > 0) {
          await ctx.db.insert("invoiceLineItems", {
            invoiceId: invoice._id,
            type: "FUEL",
            description: `Fuel Surcharge (${args.fuelSurchargeType})`,
            quantity: 1,
            rate: fuelSurcharge,
            amount: fuelSurcharge,
            createdAt: Date.now(),
          });
        }

        // Stop-off charges
        if (stopOffCharges > 0) {
          await ctx.db.insert("invoiceLineItems", {
            invoiceId: invoice._id,
            type: "ACCESSORIAL",
            description: `Stop-off charges (${extraStops} extra stops)`,
            quantity: extraStops,
            rate: args.stopOffRate || 0,
            amount: stopOffCharges,
            createdAt: Date.now(),
          });
        }

        updatedCount++;
        totalRevenue += totalAmount;
      } catch (err) {
        console.error(`Failed to backfill load ${load._id}:`, err);
        // Continue with next load
      }
    }

    return {
      laneId: laneId || null, // null for SPOT loads (no contract lane created)
      customerId: finalCustomerId,
      loadsUpdated: updatedCount,
      totalRevenue,
    };
  },
});

/**
 * Void Unmapped Group
 * Marks all invoices in a group as VOID without affecting operational data
 * Used for trash data that should not be billed (e.g. test loads, cancelled bookings)
 */
export const voidUnmappedGroup = mutation({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.string(),
    voidReason: v.string(),
    createdBy: v.string(),
    // Optional: customer info if user selected one before voiding
    customerName: v.optional(v.string()),
    customerOffice: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
  },
  handler: async (ctx, args) => {
    // Step 1: Resolve customer if provided
    let finalCustomerId = args.customerId;
    
    if (!finalCustomerId && args.customerName) {
      // Check if customer already exists by name AND office
      const existingCustomer = await ctx.db
        .query("customers")
        .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
        .filter((q) => 
          q.and(
            q.eq(q.field("name"), args.customerName),
            q.eq(q.field("office"), args.customerOffice || undefined)
          )
        )
        .first();
      
      if (existingCustomer) {
        finalCustomerId = existingCustomer._id;
      } else {
        // Create new customer
        finalCustomerId = await ctx.db.insert("customers", {
          name: args.customerName,
          office: args.customerOffice,
          companyType: "Shipper",
          status: "Active",
          addressLine1: "TBD",
          city: "TBD",
          state: "TBD",
          zip: "00000",
          country: "USA",
          workosOrgId: args.workosOrgId,
          createdBy: args.createdBy,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          isDeleted: false,
        });
      }
    }
    
    // Step 2: Find all loads matching this HCR+Trip pattern
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_hcr_trip", (q) =>
        q.eq("workosOrgId", args.workosOrgId)
         .eq("parsedHcr", args.hcr)
         .eq("parsedTripNumber", args.tripNumber)
      )
      .filter((q) => q.eq(q.field("loadType"), "UNMAPPED"))
      .collect();

    let voidedCount = 0;

    for (const load of loads) {
      try {
        // Update load with customer if provided
        if (finalCustomerId) {
          await ctx.db.patch(load._id, {
            customerId: finalCustomerId,
            customerName: args.customerName,
            updatedAt: Date.now(),
          });
        }
        
        // Find invoice
        const invoice = await ctx.db
          .query("loadInvoices")
          .withIndex("by_load", (q) => q.eq("loadId", load._id))
          .first();

        if (!invoice || invoice.status !== "MISSING_DATA") continue;

        // Mark invoice as VOID (with customer if provided)
        await ctx.db.patch(invoice._id, {
          status: "VOID",
          customerId: finalCustomerId || invoice.customerId,
          missingDataReason: args.voidReason,
          updatedAt: Date.now(),
        });

        voidedCount++;
      } catch (err) {
        console.error(`Failed to void invoice for load ${load._id}:`, err);
      }
    }

    return {
      voidedCount,
      customerId: finalCustomerId || null,
    };
  },
});
