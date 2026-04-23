import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';
import { computeLegScheduledTimes } from '../_helpers/timeUtils';

/**
 * Migration: backfill scheduledStartMs / scheduledEndMs onto every existing
 * dispatchLeg document.
 *
 * Context: getAvailableDrivers was reading start/end stops per leg to
 * compute the time window, which blew the 4096-read limit on orgs with
 * large PENDING backlogs. Denormalizing the times onto the leg eliminates
 * ~2/3 of reads. Fields are populated on new inserts by computeLegScheduledTimes
 * at every insert site; this migration patches historical rows.
 *
 * Idempotent — safe to re-run. A leg whose stops have unparsable window
 * times will remain with undefined cached fields; the read path falls back
 * to live stop reads for those rows.
 *
 * Run:
 *   npx convex run migrations/010_backfill_leg_scheduled_times:startBackfill
 *   npx convex run migrations/010_backfill_leg_scheduled_times:verifyComplete
 */

const BATCH_SIZE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/010_backfill_leg_scheduled_times'];
type _Ref = FunctionReference<'mutation' | 'action', 'internal'>;
void (null as unknown as _Ref);

export const backfillBatch = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    processed: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('dispatchLegs')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    for (const leg of result.page) {
      const times = await computeLegScheduledTimes(ctx, leg.startStopId, leg.endStopId);
      await ctx.db.patch(leg._id, times);
    }

    return {
      processed: result.page.length,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

export const startBackfill = internalAction({
  args: {},
  returns: v.object({ totalProcessed: v.number() }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalProcessed = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(self.backfillBatch, {
        cursor: cursor ?? undefined,
      });
      totalProcessed += batch.processed;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(`[backfillLegScheduledTimes] processed=${totalProcessed}`);
    return { totalProcessed };
  },
});

/**
 * Verify: counts legs that have both cached scheduled fields set vs. those
 * missing either. A non-zero "missing but recoverable" count means the
 * backfill has work left. A non-zero "missing and unrecoverable" count means
 * the leg's stops have bad window data — the read-path fallback handles it
 * but the number should be small/stable.
 */
export const verifyComplete = internalAction({
  args: {},
  returns: v.object({
    totalLegs: v.number(),
    legsWithBothCached: v.number(),
    legsMissingCachedRecoverable: v.number(),
    legsMissingCachedUnrecoverable: v.number(),
  }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalLegs = 0;
    let legsWithBothCached = 0;
    let legsMissingCachedRecoverable = 0;
    let legsMissingCachedUnrecoverable = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runQuery(self.verifyBatch, {
        cursor: cursor ?? undefined,
      });
      totalLegs += batch.totalLegs;
      legsWithBothCached += batch.legsWithBothCached;
      legsMissingCachedRecoverable += batch.legsMissingCachedRecoverable;
      legsMissingCachedUnrecoverable += batch.legsMissingCachedUnrecoverable;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(
      `[backfillLegScheduledTimes:verify] total=${totalLegs} both=${legsWithBothCached} recoverable=${legsMissingCachedRecoverable} unrecoverable=${legsMissingCachedUnrecoverable}`,
    );
    return {
      totalLegs,
      legsWithBothCached,
      legsMissingCachedRecoverable,
      legsMissingCachedUnrecoverable,
    };
  },
});

export const verifyBatch = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    totalLegs: v.number(),
    legsWithBothCached: v.number(),
    legsMissingCachedRecoverable: v.number(),
    legsMissingCachedUnrecoverable: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('dispatchLegs')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let legsWithBothCached = 0;
    let legsMissingCachedRecoverable = 0;
    let legsMissingCachedUnrecoverable = 0;

    for (const leg of result.page) {
      if (leg.scheduledStartMs !== undefined && leg.scheduledEndMs !== undefined) {
        legsWithBothCached++;
        continue;
      }
      // Missing — probe whether the live stop reads can produce a value.
      const times = await computeLegScheduledTimes(ctx, leg.startStopId, leg.endStopId);
      if (times.scheduledStartMs !== undefined && times.scheduledEndMs !== undefined) {
        legsMissingCachedRecoverable++;
      } else {
        legsMissingCachedUnrecoverable++;
      }
    }

    return {
      totalLegs: result.page.length,
      legsWithBothCached,
      legsMissingCachedRecoverable,
      legsMissingCachedUnrecoverable,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});
