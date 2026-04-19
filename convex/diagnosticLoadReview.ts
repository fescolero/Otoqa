import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertCallerOwnsOrg } from "./lib/auth";

/**
 * Diagnostic query to check loads requiring review.
 *
 * HCR / TRIP values are sourced from loadTags (not the denormalized
 * columns on loadInformation) so this query stays correct after Phase 5
 * drops those columns.
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

    // Enrich the sample slice with tag-derived HCR/TRIP values.
    const sample = loads.slice(0, 10);
    const loadTypes = await Promise.all(
      sample.map(async (l) => {
        const tags = await ctx.db
          .query("loadTags")
          .withIndex("by_load", (q) => q.eq("loadId", l._id))
          .collect();
        const hcr = tags.find((t) => t.facetKey === "HCR")?.value;
        const tripNumber = tags.find((t) => t.facetKey === "TRIP")?.value;
        return {
          orderNumber: l.orderNumber,
          loadType: l.loadType,
          requiresManualReview: l.requiresManualReview,
          parsedHcr: hcr,
          parsedTripNumber: tripNumber,
        };
      }),
    );

    return {
      total: loads.length,
      reviewNeeded: reviewNeeded.length,
      spotLoads: spotLoads.length,
      contractLoads: contractLoads.length,
      sampleReviewLoad: reviewNeeded[0] || null,
      sampleSpotLoad: spotLoads[0] || null,
      loadTypes,
    };
  },
});
