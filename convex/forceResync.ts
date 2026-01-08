import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Clear all FourKites loads to force a fresh sync
 */
export const clearFourKitesLoads = mutation({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Find all FK loads
    const loads = await ctx.db
      .query("loadInformation")
      .filter((q) => q.eq(q.field("internalId"), q.field("internalId")))
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
