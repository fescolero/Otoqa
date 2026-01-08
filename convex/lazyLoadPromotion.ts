/**
 * Lazy Load Promotion
 * Checks and promotes individual SPOT loads when accessed, avoiding bulk reprocessing
 */

import { mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

/**
 * Check a single load and promote if specific lane exists
 * Called when a load is viewed/accessed
 */
export const checkAndPromoteLoad = mutation({
  args: {
    loadId: v.id("loadInformation"),
  },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) return { promoted: false };

    // Only check SPOT loads that need review
    if (load.loadType !== "SPOT" || !load.requiresManualReview) {
      return { promoted: false };
    }

    if (!load.parsedHcr || !load.parsedTripNumber) {
      return { promoted: false };
    }

    // Check if specific lane exists (using efficient compound index)
    const specificLane = await ctx.db
      .query("contractLanes")
      .withIndex("by_org_hcr_trip", (q) => 
        q.eq("workosOrgId", load.workosOrgId)
         .eq("hcr", load.parsedHcr)
         .eq("tripNumber", load.parsedTripNumber)
      )
      .filter((q) => q.eq(q.field("isDeleted"), false))
      .first();

    if (specificLane) {
      // Promote to CONTRACT
      await ctx.db.patch(args.loadId, {
        loadType: "CONTRACT",
        requiresManualReview: false,
        updatedAt: Date.now(),
      });

      // Update invoice status from MISSING_DATA → DRAFT
      const invoice = await ctx.db
        .query("loadInvoices")
        .withIndex("by_load", (q) => q.eq("loadId", args.loadId))
        .first();
      
      if (invoice && invoice.status === "MISSING_DATA") {
        await ctx.db.patch(invoice._id, {
          status: "DRAFT",
          missingDataReason: undefined,
          updatedAt: Date.now(),
        });

        // ✅ Update organization stats (MISSING_DATA → DRAFT)
        const { updateInvoiceCount } = await import("./stats_helpers");
        await updateInvoiceCount(ctx, load.workosOrgId, "MISSING_DATA", "DRAFT");
      }
      
      return { promoted: true, lane: specificLane.contractName };
    }

    return { promoted: false };
  },
});

/**
 * ⚠️ DEPRECATED - DO NOT USE
 * 
 * This function has been disabled to prevent excessive database reads.
 * The self-scheduling loop was causing 15GB+ reads per day.
 * 
 * PROMOTION NOW HAPPENS VIA:
 * 1. createLaneAndBackfill - When a lane is created, it backfills matching loads
 * 2. checkAndPromoteLoad - When a load is accessed, it checks for matching lanes
 * 
 * This is an EVENT-DRIVEN approach instead of POLLING.
 */
export const periodicCleanup = internalMutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // ⚠️ DISABLED - This function previously caused excessive reads
    // by continuously polling for UNMAPPED/SPOT loads.
    // 
    // Promotion is now handled event-driven:
    // - Lane creation triggers backfill
    // - Load access triggers promotion check
    
    console.warn(
      "⚠️ lazyLoadPromotion.periodicCleanup is DEPRECATED. " +
      "Promotion is now event-driven via createLaneAndBackfill and checkAndPromoteLoad."
    );
    
    return { processed: 0, promoted: 0, deprecated: true };
  },
});
