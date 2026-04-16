import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertCallerOwnsOrg } from "./lib/auth";

export const get = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    return await ctx.db
      .query("contractLanes")
      .withIndex("by_organization", (q) => q.eq("workosOrgId", args.workosOrgId))
      .first();
  },
});
