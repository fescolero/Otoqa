import { v, ConvexError } from 'convex/values';
import { query, mutation } from '../_generated/server';
import { requirePlatformStaff } from '../lib/auth';

/**
 * Platform console — the systemEvents "needs attention" feed. Staff-only.
 *
 * The feed is only useful if it can reach zero. Events collapse by dedupe key
 * (lib/systemEvents.ts) and can be acknowledged; an acknowledged event that
 * HAPPENS AGAIN returns to the feed, because `lastSeenAt` moves past
 * `ackedAt`. So acking is "I've seen this occurrence", never "hide this
 * forever" — which is what makes it safe to ack aggressively.
 */

/** Unacked = never acked, or seen again since the ack. */
function isUnacked(e: {
  ackedAt?: number;
  lastSeenAt?: number;
  createdAt: number;
}): boolean {
  if (e.ackedAt === undefined) return true;
  return (e.lastSeenAt ?? e.createdAt) > e.ackedAt;
}

export const recentEvents = query({
  args: {
    minSeverity: v.optional(
      v.union(v.literal('info'), v.literal('warn'), v.literal('error'), v.literal('critical')),
    ),
    includeAcked: v.optional(v.boolean()),
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

    return recent
      .filter((e) => rank[e.severity] >= min)
      .filter((e) => args.includeAcked === true || isUnacked(e))
      .slice(0, limit)
      .map((e) => ({ ...e, unacked: isUnacked(e) }));
  },
});

export const ackEvent = mutation({
  args: { eventId: v.id('systemEvents') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const event = await ctx.db.get(args.eventId);
    if (!event) throw new ConvexError('Event not found');
    await ctx.db.patch(args.eventId, { ackedAt: Date.now(), ackedBy: staff.email });
    return null;
  },
});

/**
 * Clear the backlog in one action. Bounded per call; the count returned tells
 * the operator whether to run it again.
 */
export const ackAllEvents = mutation({
  args: {
    olderThanMs: v.optional(v.number()), // e.g. only events older than a day
    maxSeverity: v.optional(
      v.union(v.literal('info'), v.literal('warn'), v.literal('error')),
    ),
  },
  returns: v.object({ acked: v.number(), remaining: v.number() }),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const now = Date.now();
    const rank = { info: 0, warn: 1, error: 2, critical: 3 } as const;
    // Critical events are never bulk-ackable: clearing those must be a
    // deliberate, individual act.
    const ceiling = rank[args.maxSeverity ?? 'error'];

    const BATCH = 200;
    const recent = await ctx.db.query('systemEvents').withIndex('by_time').order('desc').take(500);
    const targets = recent.filter(
      (e) =>
        isUnacked(e) &&
        rank[e.severity] <= ceiling &&
        (args.olderThanMs === undefined || now - (e.lastSeenAt ?? e.createdAt) >= args.olderThanMs),
    );

    for (const e of targets.slice(0, BATCH)) {
      await ctx.db.patch(e._id, { ackedAt: now, ackedBy: staff.email });
    }
    return {
      acked: Math.min(targets.length, BATCH),
      remaining: Math.max(0, targets.length - BATCH),
    };
  },
});
