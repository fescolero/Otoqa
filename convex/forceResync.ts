import { mutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { assertCallerOwnsOrg } from "./lib/auth";

/**
 * Clear all FourKites loads to force a fresh sync
 */
export const clearFourKitesLoads = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new ConvexError('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // Find the CALLER ORG's FK loads only. (Previously this collected the
    // entire loadInformation table and deleted FK- loads across all orgs.)
    const loads = await ctx.db
      .query("loadInformation")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .collect();

    const fkLoads = loads.filter((load) =>
      load.internalId?.startsWith("FK-")
    );

    // Delete them
    for (const load of fkLoads) {
      await ctx.db.delete(load._id);
    }

    return {
      deleted: fkLoads.length,
    };
  },
});
