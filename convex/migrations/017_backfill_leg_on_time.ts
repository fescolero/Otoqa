import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';
import { computeLegOnTime } from '../lib/legOnTime';

/**
 * Migration: stamp `deliveriesEvaluated` / `deliveriesOnTime` onto every
 * COMPLETED dispatch leg that predates the on-time stamp (see
 * _helpers/onTime.ts). New completions are stamped inline by
 * dispatchLegs.completeLeg / handoffLoad; this patches history so the
 * driver "On-time" KPI covers the whole year.
 *
 * Idempotent — legs already carrying `deliveriesEvaluated` are skipped, so
 * a re-run only touches rows added since. Pass `force: true` to
 * recompute every completed leg (e.g. after changing the grace rule).
 *
 * Run:
 *   npx convex run migrations/017_backfill_leg_on_time:startBackfill
 *   npx convex run migrations/017_backfill_leg_on_time:startBackfill '{"force":true}'
 */

const BATCH_SIZE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/017_backfill_leg_on_time'];
type _Ref = FunctionReference<'mutation' | 'action', 'internal'>;
void (null as unknown as _Ref);

export const backfillBatch = internalMutation({
  args: { cursor: v.optional(v.string()), force: v.optional(v.boolean()) },
  returns: v.object({
    scanned: v.number(),
    stamped: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('dispatchLegs')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let stamped = 0;
    for (const leg of result.page) {
      if (leg.status !== 'COMPLETED') continue;
      if (!args.force && leg.deliveriesEvaluated !== undefined) continue;
      const summary = await computeLegOnTime(ctx, leg);
      await ctx.db.patch(leg._id, summary);
      stamped++;
    }

    return {
      scanned: result.page.length,
      stamped,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const startBackfill = internalAction({
  args: { force: v.optional(v.boolean()) },
  returns: v.object({ totalScanned: v.number(), totalStamped: v.number() }),
  handler: async (ctx, args) => {
    let cursor: string | null = null;
    let totalScanned = 0;
    let totalStamped = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(self.backfillBatch, {
        cursor: cursor ?? undefined,
        force: args.force,
      });
      totalScanned += batch.scanned;
      totalStamped += batch.stamped;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(`[backfillLegOnTime] scanned=${totalScanned} stamped=${totalStamped}`);
    return { totalScanned, totalStamped };
  },
});
