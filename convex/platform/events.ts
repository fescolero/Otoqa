import { v } from 'convex/values';
import { query } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';

/**
 * Platform console — the systemEvents "needs attention" feed. Staff-only.
 */

export const recentEvents = query({
  args: {
    minSeverity: v.optional(
      v.union(v.literal('info'), v.literal('warn'), v.literal('error'), v.literal('critical')),
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);

    const rank = { info: 0, warn: 1, error: 2, critical: 3 } as const;
    const min = rank[args.minSeverity ?? 'info'];

    // Events are pruned at 30 days, so a bounded recent scan + filter is
    // cheaper than four per-severity index reads stitched together.
    const recent = await ctx.db
      .query('systemEvents')
      .withIndex('by_time')
      .order('desc')
      .take(Math.max(limit * 4, 200));

    return recent.filter((e) => rank[e.severity] >= min).slice(0, limit);
  },
});
