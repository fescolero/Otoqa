import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Count loads, stops, and invoices for an organization
 */
export const countLoadsAndStops = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Count loads
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    // Count stops
    const stops = await ctx.db
      .query("loadStops")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    // Count invoices
    const invoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();
    
    const invoicesByStatus = {
      MISSING_DATA: invoices.filter((i) => i.status === "MISSING_DATA").length,
      DRAFT: invoices.filter((i) => i.status === "DRAFT").length,
      BILLED: invoices.filter((i) => i.status === "BILLED").length,
      PAID: invoices.filter((i) => i.status === "PAID").length,
    };

    // Get FourKites loads
    const fourKitesLoads = loads.filter((l) => l.externalSource === "FourKites");

    // Get sample load with its stops
    const sampleLoad = fourKitesLoads[0];
    let sampleStops = [];
    if (sampleLoad) {
      sampleStops = await ctx.db
        .query("loadStops")
        .withIndex("by_load", (q) => q.eq("loadId", sampleLoad._id))
        .collect();
    }

    return {
      totalLoads: loads.length,
      fourKitesLoads: fourKitesLoads.length,
      totalStops: stops.length,
      totalInvoices: invoices.length,
      invoicesByStatus,
      sampleLoad: sampleLoad
        ? {
            _id: sampleLoad._id,
            internalId: sampleLoad.internalId,
            orderNumber: sampleLoad.orderNumber,
            externalLoadId: sampleLoad.externalLoadId,
            stopCount: sampleStops.length,
          }
        : null,
    };
  },
});
