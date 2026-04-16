import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertCallerOwnsOrg } from "./lib/auth";

/**
 * Diagnostic query to check loads requiring review
 */
export const checkReviewLoads = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const reviewNeeded = loads.filter(l => l.requiresManualReview === true);
    const spotLoads = loads.filter(l => l.loadType === "SPOT");
    const contractLoads = loads.filter(l => l.loadType === "CONTRACT");

    return {
      total: loads.length,
      reviewNeeded: reviewNeeded.length,
      spotLoads: spotLoads.length,
      contractLoads: contractLoads.length,
      sampleReviewLoad: reviewNeeded[0] || null,
      sampleSpotLoad: spotLoads[0] || null,
      loadTypes: loads.slice(0, 10).map(l => ({
        orderNumber: l.orderNumber,
        loadType: l.loadType,
        requiresManualReview: l.requiresManualReview,
        parsedHcr: l.parsedHcr,
        parsedTripNumber: l.parsedTripNumber,
      })),
    };
  },
});
