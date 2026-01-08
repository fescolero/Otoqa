import { query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("contractLanes")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .first();
  },
});
