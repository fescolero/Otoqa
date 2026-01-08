/**
 * Migration: Backfill firstStopDate on all loadInformation documents
 * 
 * This migration populates the new denormalized firstStopDate field
 * based on each load's first stop (sequenceNumber = 1) windowBeginDate.
 * 
 * Run this migration ONCE after deploying the schema changes.
 * 
 * Usage (via Convex Dashboard → Functions → Mutations):
 *   1. Run startBackfillFirstStopDate to begin the migration
 *   2. It will process in batches of 200 loads
 *   3. Monitor progress in the console logs
 *   4. Run getBackfillProgress to check status
 */

import { internalMutation, internalAction, query } from "../_generated/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";

// Batch size for processing (keeps under read limits)
const BATCH_SIZE = 200;

/**
 * Process a single batch of loads
 * Returns the cursor for the next batch, or null if done
 */
export const backfillBatch = internalMutation({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get next batch of loads
    const result = await ctx.db
      .query("loadInformation")
      .paginate({
        numItems: BATCH_SIZE,
        cursor: args.cursor ?? null,
      });

    let updated = 0;
    let skipped = 0;

    for (const load of result.page) {
      // Get the first stop for this load
      const firstStop = await ctx.db
        .query("loadStops")
        .withIndex("by_sequence", (q) => 
          q.eq("loadId", load._id).eq("sequenceNumber", 1)
        )
        .first();

      // Extract and sanitize the date
      let firstStopDate: string | undefined = undefined;
      
      if (firstStop?.windowBeginDate) {
        const rawDate = firstStop.windowBeginDate;
        
        // Handle TBD or empty values
        if (rawDate && rawDate !== "TBD") {
          // Extract YYYY-MM-DD from potential ISO string
          firstStopDate = rawDate.split("T")[0];
          
          // Validate format (must be YYYY-MM-DD)
          if (!/^\d{4}-\d{2}-\d{2}$/.test(firstStopDate)) {
            firstStopDate = undefined;
          }
        }
      }

      // Only update if the value is different (avoid unnecessary writes)
      if (load.firstStopDate !== firstStopDate) {
        await ctx.db.patch(load._id, { firstStopDate });
        updated++;
      } else {
        skipped++;
      }
    }

    console.log(
      `Batch processed: ${updated} updated, ${skipped} skipped, isDone: ${result.isDone}`
    );

    return {
      continueCursor: result.isDone ? null : result.continueCursor,
      updated,
      skipped,
      isDone: result.isDone,
    };
  },
});

/**
 * Action to orchestrate the full migration
 * Calls backfillBatch repeatedly until all loads are processed
 */
export const runBackfillMigration = internalAction({
  args: {},
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let batchCount = 0;

    console.log("Starting firstStopDate backfill migration...");

    while (true) {
      const result: {
        continueCursor: string | null;
        updated: number;
        skipped: number;
        isDone: boolean;
      } = await ctx.runMutation(internal.migrations.backfillFirstStopDate.backfillBatch, {
        cursor: cursor ?? undefined,
      });

      totalUpdated += result.updated;
      totalSkipped += result.skipped;
      batchCount++;

      console.log(
        `Batch ${batchCount}: ${result.updated} updated, ${result.skipped} skipped. Total: ${totalUpdated} updated, ${totalSkipped} skipped`
      );

      if (result.isDone || !result.continueCursor) {
        break;
      }

      cursor = result.continueCursor;
    }

    console.log(
      `Migration complete! Processed ${batchCount} batches. ${totalUpdated} loads updated, ${totalSkipped} skipped.`
    );

    return {
      success: true,
      totalUpdated,
      totalSkipped,
      batchCount,
    };
  },
});

/**
 * Query to check migration progress (for manual verification)
 */
export const getMigrationStatus = query({
  args: {},
  handler: async (ctx) => {
    // Count loads with and without firstStopDate
    const allLoads = await ctx.db.query("loadInformation").collect();
    
    const withDate = allLoads.filter(l => l.firstStopDate !== undefined).length;
    const withoutDate = allLoads.filter(l => l.firstStopDate === undefined).length;
    const withTBD = allLoads.filter(l => l.firstStopDate === "TBD").length; // Should be 0
    
    return {
      totalLoads: allLoads.length,
      withFirstStopDate: withDate,
      withoutFirstStopDate: withoutDate,
      withInvalidTBD: withTBD,
      percentComplete: allLoads.length > 0 
        ? Math.round((withDate / allLoads.length) * 100) 
        : 100,
    };
  },
});

