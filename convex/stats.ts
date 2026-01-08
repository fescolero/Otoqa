/**
 * Organization Statistics Recalculation
 * 
 * Industry Standard: Daily Recalculation for Drift Protection
 * - Aggregate tables are updated by mutations (fast)
 * - But bugs or edge cases can cause drift
 * - Daily recalculation ensures accuracy
 * - Same pattern used by Stripe, Shopify, etc.
 */

import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Recalculate organization stats from source data
 * This catches any drift from bugs or missed mutation updates
 */
export const recalculateOrgStats = internalMutation({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    console.log(`Recalculating stats for org: ${args.workosOrgId}`);

    // Count loads by status
    const allLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const loadCounts = {
      Open: allLoads.filter(l => l.status === "Open").length,
      Assigned: allLoads.filter(l => l.status === "Assigned").length,
      Completed: allLoads.filter(l => l.status === "Completed").length,
      Canceled: allLoads.filter(l => l.status === "Canceled").length,
    };

    // Count invoices by status
    const allInvoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const invoiceCounts = {
      MISSING_DATA: allInvoices.filter(i => i.status === "MISSING_DATA").length,
      DRAFT: allInvoices.filter(i => i.status === "DRAFT").length,
      BILLED: allInvoices.filter(i => i.status === "BILLED").length,
      PENDING_PAYMENT: allInvoices.filter(i => i.status === "PENDING_PAYMENT").length,
      PAID: allInvoices.filter(i => i.status === "PAID").length,
      VOID: allInvoices.filter(i => i.status === "VOID").length,
    };

    // Update or create stats
    const existingStats = await ctx.db
      .query("organizationStats")
      .withIndex("by_org", (q) => q.eq("workosOrgId", args.workosOrgId))
      .first();

    const now = Date.now();

    if (existingStats) {
      // Check if there's drift
      const loadDrift = Object.entries(loadCounts).some(
        ([status, count]) => existingStats.loadCounts[status as keyof typeof existingStats.loadCounts] !== count
      );
      const invoiceDrift = Object.entries(invoiceCounts).some(
        ([status, count]) => existingStats.invoiceCounts[status as keyof typeof existingStats.invoiceCounts] !== count
      );

      if (loadDrift || invoiceDrift) {
        console.log(`⚠️  Drift detected for org ${args.workosOrgId} - correcting stats`);
      }

      await ctx.db.patch(existingStats._id, {
        loadCounts,
        invoiceCounts,
        lastRecalculated: now,
        updatedAt: now,
      });
    } else {
      // Create new stats
      console.log(`✅ Creating initial stats for org ${args.workosOrgId}`);
      await ctx.db.insert("organizationStats", {
        workosOrgId: args.workosOrgId,
        loadCounts,
        invoiceCounts,
        lastRecalculated: now,
        updatedAt: now,
      });
    }

    console.log(`✅ Stats recalculated for org ${args.workosOrgId}: ${allLoads.length} loads, ${allInvoices.length} invoices`);
    return null;
  },
});

/**
 * Recalculate stats for all organizations
 * Called by cron job daily
 */
export const recalculateAllOrgs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx, args) => {
    const startTime = Date.now();
    console.log("🔄 Starting daily stats recalculation for all organizations");

    const orgs = await ctx.db.query("organizations").collect();
    
    for (const org of orgs) {
      try {
        await ctx.runMutation(internal.stats.recalculateOrgStats, {
          workosOrgId: org.workosOrgId,
        });
      } catch (error) {
        console.error(`❌ Failed to recalculate stats for org ${org.workosOrgId}:`, error);
        // Continue with other orgs even if one fails
      }
    }
    
    const duration = Date.now() - startTime;
    console.log(`✅ Daily stats recalculation complete for ${orgs.length} organizations in ${duration}ms`);
    return null;
  },
});

