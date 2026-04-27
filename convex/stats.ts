/**
 * Organization Statistics Recalculation
 * 
 * Industry Standard: Daily Recalculation for Drift Protection
 * - Aggregate tables are updated by mutations (fast)
 * - But bugs or edge cases can cause drift
 * - Daily recalculation ensures accuracy
 * - Same pattern used by Stripe, Shopify, etc.
 * 
 * Architecture: Uses paginated batch counting to stay well within
 * Convex transaction limits (32k doc reads / 16MB bytes).
 * Each countStatus mutation counts one (table, status) pair in
 * paginated batches, then schedules the next status in the sequence.
 * This ensures each transaction reads at most BATCH_SIZE documents.
 */

import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { queryByOrg } from "./_helpers/queryByOrg";

const BATCH_SIZE = 5000;

const LOAD_STATUSES = ["Open", "Assigned", "Completed", "Canceled", "Expired"] as const;
const INVOICE_STATUSES = ["MISSING_DATA", "DRAFT", "BILLED", "PENDING_PAYMENT", "PAID", "VOID"] as const;

type StatusStep =
  | { table: "loadInformation"; status: typeof LOAD_STATUSES[number] }
  | { table: "loadInvoices"; status: typeof INVOICE_STATUSES[number] };

const ALL_STEPS: StatusStep[] = [
  ...LOAD_STATUSES.map((s) => ({ table: "loadInformation" as const, status: s })),
  ...INVOICE_STATUSES.map((s) => ({ table: "loadInvoices" as const, status: s })),
];

/**
 * Count documents for a single (table, status) pair in paginated batches.
 * Accumulates the count across batches, then schedules the next status step.
 * On the final step, writes all counts to organizationStats.
 */
export const countStatus = internalMutation({
  args: {
    workosOrgId: v.string(),
    stepIndex: v.number(),
    cursor: v.union(v.string(), v.null()),
    runningCount: v.number(),
    accumulated: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { workosOrgId, stepIndex, cursor, runningCount } = args;
    const accumulated: Record<string, number> = JSON.parse(args.accumulated);
    const step = ALL_STEPS[stepIndex];

    const results = await ctx.db
      .query(step.table)
      .withIndex("by_status", (q) =>
        q.eq("workosOrgId", workosOrgId).eq("status", step.status)
      )
      .paginate({ numItems: BATCH_SIZE, cursor });

    const batchCount = results.page.length;
    const newRunningCount = runningCount + batchCount;

    if (!results.isDone) {
      await ctx.scheduler.runAfter(0, internal.stats.countStatus, {
        workosOrgId,
        stepIndex,
        cursor: results.continueCursor,
        runningCount: newRunningCount,
        accumulated: args.accumulated,
      });
      return null;
    }

    const key = `${step.table}:${step.status}`;
    accumulated[key] = newRunningCount;

    const nextStepIndex = stepIndex + 1;
    if (nextStepIndex < ALL_STEPS.length) {
      await ctx.scheduler.runAfter(0, internal.stats.countStatus, {
        workosOrgId,
        stepIndex: nextStepIndex,
        cursor: null,
        runningCount: 0,
        accumulated: JSON.stringify(accumulated),
      });
      return null;
    }

    const loadCounts = {
      Open: accumulated["loadInformation:Open"] ?? 0,
      Assigned: accumulated["loadInformation:Assigned"] ?? 0,
      Completed: accumulated["loadInformation:Completed"] ?? 0,
      Canceled: accumulated["loadInformation:Canceled"] ?? 0,
      Expired: accumulated["loadInformation:Expired"] ?? 0,
    };
    const invoiceCounts = {
      MISSING_DATA: accumulated["loadInvoices:MISSING_DATA"] ?? 0,
      DRAFT: accumulated["loadInvoices:DRAFT"] ?? 0,
      BILLED: accumulated["loadInvoices:BILLED"] ?? 0,
      PENDING_PAYMENT: accumulated["loadInvoices:PENDING_PAYMENT"] ?? 0,
      PAID: accumulated["loadInvoices:PAID"] ?? 0,
      VOID: accumulated["loadInvoices:VOID"] ?? 0,
    };

    const stats = await queryByOrg(ctx, "organizationStats", workosOrgId).first();

    const now = Date.now();
    if (stats) {
      const loadDrift = Object.entries(loadCounts).some(
        ([s, c]) => stats.loadCounts[s as keyof typeof stats.loadCounts] !== c
      );
      const invoiceDrift = Object.entries(invoiceCounts).some(
        ([s, c]) => stats.invoiceCounts[s as keyof typeof stats.invoiceCounts] !== c
      );
      if (loadDrift || invoiceDrift) {
        console.log(`⚠️  Drift detected for org ${workosOrgId} - correcting`);
      }
      await ctx.db.patch(stats._id, { loadCounts, invoiceCounts, lastRecalculated: now, updatedAt: now });
    } else {
      console.log(`✅ Creating initial stats for org ${workosOrgId}`);
      await ctx.db.insert("organizationStats", {
        workosOrgId,
        loadCounts,
        invoiceCounts,
        lastRecalculated: now,
        updatedAt: now,
      });
    }

    const totalLoads = Object.values(loadCounts).reduce((a, b) => a + b, 0);
    const totalInvoices = Object.values(invoiceCounts).reduce((a, b) => a + b, 0);
    console.log(`✅ Stats recalculated for org ${workosOrgId}: ${totalLoads} loads, ${totalInvoices} invoices`);
    return null;
  },
});

/**
 * Entry point for recalculating a single org's stats.
 * Kicks off the sequential countStatus chain.
 */
export const recalculateOrgStats = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.scheduler.runAfter(0, internal.stats.countStatus, {
      workosOrgId: args.workosOrgId,
      stepIndex: 0,
      cursor: null,
      runningCount: 0,
      accumulated: JSON.stringify({}),
    });
    return null;
  },
});

/**
 * Recalculate stats for all organizations.
 * Called by cron job daily.
 */
export const recalculateAllOrgs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    console.log("🔄 Starting daily stats recalculation for all organizations");

    const orgs = await ctx.db.query("organizations").collect();
    let scheduled = 0;
    
    for (const org of orgs) {
      if (!org.workosOrgId) {
        continue;
      }
      await ctx.scheduler.runAfter(0, internal.stats.recalculateOrgStats, {
        workosOrgId: org.workosOrgId,
      });
      scheduled++;
    }
    
    console.log(`✅ Scheduled stats recalculation for ${scheduled} organizations`);
    return null;
  },
});

