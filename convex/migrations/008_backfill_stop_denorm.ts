import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';

/**
 * Migration: backfill origin / destination / stopsCount denormalized
 * fields onto every existing loadInformation document.
 *
 * Issue #2 from the original Convex Health warning: `loads:getLoads` was
 * doing an N+1 loadStops query per returned load to derive origin,
 * destination, and stopsCount. Phase Issue#2b swapped reads to use
 * denormalized columns — but columns are undefined for loads created
 * before the schema addition. This migration patches them.
 *
 * Strategy: call syncFirstStopDate on every load. That function was
 * extended to populate all denorm fields in one pass, so calling it
 * over an existing load rewrites every denormalized column from its
 * current stops. Idempotent — safe to re-run.
 *
 * Run:
 *   npx convex run migrations/008_backfill_stop_denorm:startBackfill
 *   npx convex run migrations/008_backfill_stop_denorm:verifyComplete
 */

const BATCH_SIZE = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/008_backfill_stop_denorm'];
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
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    for (const load of result.page) {
      // Directly rewrite the denormalized fields from stops. We don't
      // call syncFirstStopDate from loads.ts to avoid cross-module
      // coupling in a migration; inline the same logic here.
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

      const firstPickup = stops.find((s) => s.stopType === 'PICKUP');
      const lastDelivery = [...stops]
        .reverse()
        .find((s) => s.stopType === 'DELIVERY');

      await ctx.db.patch(load._id, {
        originCity: firstPickup?.city,
        originState: firstPickup?.state,
        originAddress: firstPickup?.address,
        destinationCity: lastDelivery?.city,
        destinationState: lastDelivery?.state,
        destinationAddress: lastDelivery?.address,
        stopsCountDenorm: stops.length,
      });
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

    console.log(
      `[backfillStopDenorm] processed=${totalProcessed}`,
    );
    return { totalProcessed };
  },
});

/**
 * Verify: counts loads that have at least one stop but are missing the
 * denormalized fields. Must return {remaining: 0} to consider backfill
 * complete — any non-zero count indicates loads that the backfill
 * didn't update (e.g. loads with zero stops, which are legitimately
 * expected to have null denorm values).
 */
export const verifyComplete = internalAction({
  args: {},
  returns: v.object({
    totalLoads: v.number(),
    loadsWithStops: v.number(),
    loadsWithDenorm: v.number(),
    loadsMissingDenorm: v.number(),
  }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalLoads = 0;
    let loadsWithStops = 0;
    let loadsWithDenorm = 0;
    let loadsMissingDenorm = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runQuery(self.verifyBatch, {
        cursor: cursor ?? undefined,
      });
      totalLoads += batch.totalLoads;
      loadsWithStops += batch.loadsWithStops;
      loadsWithDenorm += batch.loadsWithDenorm;
      loadsMissingDenorm += batch.loadsMissingDenorm;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(
      `[backfillStopDenorm:verify] totalLoads=${totalLoads} withStops=${loadsWithStops} withDenorm=${loadsWithDenorm} missing=${loadsMissingDenorm}`,
    );
    return {
      totalLoads,
      loadsWithStops,
      loadsWithDenorm,
      loadsMissingDenorm,
    };
  },
});

export const verifyBatch = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    totalLoads: v.number(),
    loadsWithStops: v.number(),
    loadsWithDenorm: v.number(),
    loadsMissingDenorm: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let loadsWithStops = 0;
    let loadsWithDenorm = 0;
    let loadsMissingDenorm = 0;
    for (const load of result.page) {
      const firstStop = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .first();
      const hasStops = firstStop !== null;
      const hasDenorm = load.stopsCountDenorm !== undefined;
      if (hasStops) loadsWithStops++;
      if (hasDenorm) loadsWithDenorm++;
      if (hasStops && !hasDenorm) loadsMissingDenorm++;
    }

    return {
      totalLoads: result.page.length,
      loadsWithStops,
      loadsWithDenorm,
      loadsMissingDenorm,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});
