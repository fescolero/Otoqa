/**
 * Maintenance tasks for data integrity and drift protection
 * 
 * These functions handle reconciliation of denormalized data
 * to ensure consistency between source-of-truth and cached fields.
 */

import { internalMutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Batch size for reconciliation (keeps under read limits)
const RECONCILIATION_BATCH_SIZE = 200;

/**
 * Reconcile firstStopDate for a batch of loads
 * Compares denormalized field with actual first stop data
 * 
 * @returns Statistics about drift found and fixed
 */
export const reconcileFirstStopDateBatch = internalMutation({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get next batch of loads
    const result = await ctx.db
      .query("loadInformation")
      .paginate({
        numItems: RECONCILIATION_BATCH_SIZE,
        cursor: args.cursor ?? null,
      });

    let checked = 0;
    let driftFound = 0;
    let fixed = 0;

    for (const load of result.page) {
      checked++;
      
      // Get the first stop for this load
      const firstStop = await ctx.db
        .query("loadStops")
        .withIndex("by_sequence", (q) => 
          q.eq("loadId", load._id).eq("sequenceNumber", 1)
        )
        .first();

      // Calculate expected firstStopDate
      let expectedDate: string | undefined = undefined;
      
      if (firstStop?.windowBeginDate) {
        const rawDate = firstStop.windowBeginDate;
        
        // Handle TBD or empty values
        if (rawDate && rawDate !== "TBD") {
          // Extract YYYY-MM-DD from potential ISO string
          expectedDate = rawDate.split("T")[0];
          
          // Validate format (must be YYYY-MM-DD)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(expectedDate)) {
            expectedDate = undefined;
          }
        }
      }

      // Check for drift
      if (load.firstStopDate !== expectedDate) {
        driftFound++;
        
        // Fix the drift
        await ctx.db.patch(load._id, { firstStopDate: expectedDate });
        fixed++;
        
        console.log(
          `Drift fixed for load ${load.internalId}: ` +
          `${load.firstStopDate} → ${expectedDate}`
        );
      }
    }

    return {
      continueCursor: result.isDone ? null : result.continueCursor,
      checked,
      driftFound,
      fixed,
      isDone: result.isDone,
    };
  },
});

/**
 * Action to orchestrate the full reconciliation
 * Calls reconcileFirstStopDateBatch repeatedly until all loads are checked
 */
export const runFirstStopDateReconciliation = internalAction({
  args: {},
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalChecked = 0;
    let totalDriftFound = 0;
    let totalFixed = 0;
    let batchCount = 0;

    console.log("Starting firstStopDate reconciliation...");

    while (true) {
      const result: {
        continueCursor: string | null;
        checked: number;
        driftFound: number;
        fixed: number;
        isDone: boolean;
      } = await ctx.runMutation(
        internal.maintenance.reconcileFirstStopDateBatch,
        { cursor: cursor ?? undefined }
      );

      totalChecked += result.checked;
      totalDriftFound += result.driftFound;
      totalFixed += result.fixed;
      batchCount++;

      if (result.isDone || !result.continueCursor) {
        break;
      }

      cursor = result.continueCursor;
    }

    const summary = {
      success: true,
      totalChecked,
      totalDriftFound,
      totalFixed,
      batchCount,
      driftRate: totalChecked > 0 
        ? `${((totalDriftFound / totalChecked) * 100).toFixed(2)}%` 
        : "0%",
    };

    if (totalDriftFound > 0) {
      console.log(
        `⚠️ Reconciliation complete: Found and fixed ${totalDriftFound} ` +
        `drifted records out of ${totalChecked} (${summary.driftRate} drift rate)`
      );
    } else {
      console.log(
        `✅ Reconciliation complete: All ${totalChecked} records are in sync`
      );
    }

    return summary;
  },
});

