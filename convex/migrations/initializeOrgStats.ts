/**
 * Initialize organizationStats for all existing organizations
 * 
 * Run this migration once after deploying Phase 2 changes
 * 
 * How to run:
 * 1. Deploy all Phase 2 changes
 * 2. Open Convex dashboard
 * 3. Go to Functions tab
 * 4. Find and run: internal.migrations.initializeOrgStats.initialize({})
 * 5. Check logs to verify completion
 */

import { internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

export const initialize = internalMutation({
  args: {},
  returns: v.object({
    totalOrgs: v.number(),
    success: v.number(),
    failed: v.number(),
  }),
  handler: async (ctx, args) => {
    const startTime = Date.now();
    console.log("🚀 Starting organizationStats initialization migration...");

    const orgs = await ctx.db.query("organizations").collect();
    console.log(`📊 Found ${orgs.length} organizations to initialize`);

    let success = 0;
    let failed = 0;

    for (const org of orgs) {
      // Skip carrier orgs without workosOrgId (they use clerkOrgId)
      if (!org.workosOrgId) {
        console.log(`Skipping org without workosOrgId: ${org.name}`);
        continue;
      }

      try {
        console.log(`Processing organization: ${org.name} (${org.workosOrgId})`);
        
        // Recalculate stats from source data
        await ctx.runMutation(internal.stats.recalculateOrgStats, {
          workosOrgId: org.workosOrgId,
        });
        
        success++;
      } catch (error) {
        console.error(`❌ Failed to initialize stats for org ${org.workosOrgId}:`, error);
        failed++;
      }
    }

    const duration = Date.now() - startTime;
    const result = {
      totalOrgs: orgs.length,
      success,
      failed,
    };

    console.log("="  .repeat(50));
    console.log("✅ Migration Complete!");
    console.log(`Total Organizations: ${result.totalOrgs}`);
    console.log(`Success: ${result.success}`);
    console.log(`Failed: ${result.failed}`);
    console.log(`Duration: ${duration}ms`);
    console.log("=" .repeat(50));

    if (failed > 0) {
      console.warn(`⚠️  ${failed} organizations failed. Check logs above for details.`);
    }

    return result;
  },
});

/**
 * Verify stats are accurate (optional - for testing)
 * Compares current stats with recalculated counts
 */
export const verifyStats = internalMutation({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.object({
    accurate: v.boolean(),
    stats: v.any(),
    actual: v.any(),
  }),
  handler: async (ctx, args) => {
    // Get current stats
    const stats = await ctx.db
      .query("organizationStats")
      .withIndex("by_org", (q) => q.eq("workosOrgId", args.workosOrgId))
      .first();

    if (!stats) {
      console.log(`❌ No stats found for org ${args.workosOrgId}`);
      return {
        accurate: false,
        stats: null,
        actual: null,
      };
    }

    // Count actual data
    const allLoads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const actualLoadCounts = {
      Open: allLoads.filter(l => l.status === "Open").length,
      Assigned: allLoads.filter(l => l.status === "Assigned").length,
      Completed: allLoads.filter(l => l.status === "Completed").length,
      Canceled: allLoads.filter(l => l.status === "Canceled").length,
    };

    const allInvoices = await ctx.db
      .query("loadInvoices")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const actualInvoiceCounts = {
      MISSING_DATA: allInvoices.filter(i => i.status === "MISSING_DATA").length,
      DRAFT: allInvoices.filter(i => i.status === "DRAFT").length,
      BILLED: allInvoices.filter(i => i.status === "BILLED").length,
      PENDING_PAYMENT: allInvoices.filter(i => i.status === "PENDING_PAYMENT").length,
      PAID: allInvoices.filter(i => i.status === "PAID").length,
      VOID: allInvoices.filter(i => i.status === "VOID").length,
    };

    // Compare
    const loadMatch = Object.entries(actualLoadCounts).every(
      ([status, count]) => stats.loadCounts[status as keyof typeof stats.loadCounts] === count
    );
    const invoiceMatch = Object.entries(actualInvoiceCounts).every(
      ([status, count]) => stats.invoiceCounts[status as keyof typeof stats.invoiceCounts] === count
    );

    const accurate = loadMatch && invoiceMatch;

    if (!accurate) {
      console.log(`⚠️  Stats drift detected for org ${args.workosOrgId}`);
      console.log("Current stats:", stats.loadCounts, stats.invoiceCounts);
      console.log("Actual counts:", actualLoadCounts, actualInvoiceCounts);
    } else {
      console.log(`✅ Stats accurate for org ${args.workosOrgId}`);
    }

    return {
      accurate,
      stats: {
        loadCounts: stats.loadCounts,
        invoiceCounts: stats.invoiceCounts,
      },
      actual: {
        loadCounts: actualLoadCounts,
        invoiceCounts: actualInvoiceCounts,
      },
    };
  },
});

