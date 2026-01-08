/**
 * Manual trigger for load promotion
 * 
 * ⚠️ UPDATED: periodicCleanup has been disabled due to excessive reads.
 * This now provides a one-time batch promotion instead of starting a loop.
 */

import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { updateInvoiceCount } from "./stats_helpers";

/**
 * One-time batch promotion of UNMAPPED/SPOT loads
 * Use this sparingly - it reads all matching loads once
 */
export const triggerCleanup = mutation({
  args: {
    workosOrgId: v.string(),
    batchSize: v.optional(v.number()), // Default 50, max 100
  },
  handler: async (ctx, args) => {
    const BATCH_SIZE = Math.min(args.batchSize || 50, 100);
    
    console.log(`[Manual Cleanup] One-time batch for org ${args.workosOrgId}, batch size: ${BATCH_SIZE}`);
    
    // Get SPOT or UNMAPPED loads that need checking
    const loadsToCheck = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .filter((q) =>
        q.or(
          q.and(
            q.eq(q.field("loadType"), "SPOT"),
            q.eq(q.field("requiresManualReview"), true)
          ),
          q.eq(q.field("loadType"), "UNMAPPED")
        )
      )
      .take(BATCH_SIZE);

    if (loadsToCheck.length === 0) {
      return { 
        success: true, 
        processed: 0, 
        promoted: 0,
        message: "No loads need promotion" 
      };
    }

    let promoted = 0;

    for (const load of loadsToCheck) {
      if (!load.parsedHcr || !load.parsedTripNumber) continue;

      // Check for specific lane (using efficient compound index)
      const specificLane = await ctx.db
        .query("contractLanes")
        .withIndex("by_org_hcr_trip", (q) => 
          q.eq("workosOrgId", args.workosOrgId)
           .eq("hcr", load.parsedHcr)
           .eq("tripNumber", load.parsedTripNumber)
        )
        .filter((q) => q.eq(q.field("isDeleted"), false))
        .first();

      if (specificLane) {
        await ctx.db.patch(load._id, {
          loadType: "CONTRACT",
          requiresManualReview: false,
          updatedAt: Date.now(),
        });

        // Update invoice status from MISSING_DATA → DRAFT
        const invoice = await ctx.db
          .query("loadInvoices")
          .withIndex("by_load", (q) => q.eq("loadId", load._id))
          .first();
        
        if (invoice && invoice.status === "MISSING_DATA") {
          await ctx.db.patch(invoice._id, {
            status: "DRAFT",
            missingDataReason: undefined,
            updatedAt: Date.now(),
          });

          await updateInvoiceCount(ctx, args.workosOrgId, "MISSING_DATA", "DRAFT");
        }
        
        promoted++;
      }
    }

    // ⚠️ NO self-scheduling - this is a ONE-TIME operation
    
    return {
      success: true,
      processed: loadsToCheck.length,
      promoted,
      remaining: loadsToCheck.length === BATCH_SIZE ? "More loads may need promotion" : "All caught up",
      message: `Promoted ${promoted} of ${loadsToCheck.length} loads checked`,
    };
  },
});
