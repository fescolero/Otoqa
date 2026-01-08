import { query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Diagnostic query to check wildcard contract lanes
 */
export const checkWildcardLanes = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const lanes = await ctx.db
      .query("contractLanes")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const wildcardLanes = lanes.filter(l => l.tripNumber === "*");
    const specificLanes = lanes.filter(l => l.tripNumber !== "*");

    return {
      total: lanes.length,
      wildcardCount: wildcardLanes.length,
      specificCount: specificLanes.length,
      wildcardLanes: wildcardLanes.map(l => ({
        _id: l._id,
        hcr: l.hcr,
        tripNumber: l.tripNumber,
        contractName: l.contractName,
        rateType: l.rateType,
        rate: l.rate,
      })),
      sampleSpecificLanes: specificLanes.slice(0, 5).map(l => ({
        hcr: l.hcr,
        tripNumber: l.tripNumber,
        contractName: l.contractName,
      })),
    };
  },
});
