/**
 * Migration: Backfill Contract Lanes
 * 
 * This migration adds default values to existing contract lanes for the new fields:
 * - currency: Defaults to 'USD'
 * - includedStops: Defaults to 2 (pickup + delivery)
 * - stopOffRate: Defaults to 0 (no stop-off charges)
 * 
 * Run this ONCE after deploying the schema update:
 * npx convex run migrations/001_backfill_contract_lanes:backfillContractLanes
 */

import { internalMutation } from "../_generated/server";

export const backfillContractLanes = internalMutation({
  handler: async (ctx) => {
    console.log("[Migration] Starting contract lanes backfill...");
    
    const lanes = await ctx.db.query("contractLanes").collect();
    
    let updated = 0;
    let skipped = 0;
    
    for (const lane of lanes) {
      const updates: any = {};
      
      // Add currency if missing (schema now requires it)
      if (!lane.currency) {
        updates.currency = "USD";
      }
      
      // Add includedStops if missing
      if (lane.includedStops === undefined) {
        updates.includedStops = 2; // Default: pickup + delivery
      }
      
      // Add stopOffRate if missing
      if (lane.stopOffRate === undefined) {
        updates.stopOffRate = 0; // Default: no extra charges
      }
      
      // Apply updates if any
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(lane._id, updates);
        updated++;
        
        console.log(`[Migration] Updated lane ${lane.contractName}: ${JSON.stringify(updates)}`);
      } else {
        skipped++;
      }
    }
    
    console.log(`[Migration] Complete: ${updated} lanes updated, ${skipped} skipped`);
    
    return {
      success: true,
      totalLanes: lanes.length,
      updated,
      skipped,
    };
  },
});
