import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';

/**
 * Migration: strip parsedHcr / parsedTripNumber from every loadInformation
 * document. Required before the schema drop in Phase 5b — Convex pushes a
 * strict schema validation against existing docs, and any doc with a field
 * the new schema doesn't declare will fail validation.
 *
 * Preconditions (gate before running):
 *   - Phase 5a deployed (column writes removed; tags are single source of truth)
 *   - verifyBackfill from migration 005 reports mismatches: []
 *
 * Sequence:
 *   1. npx convex run migrations/007_strip_parsed_columns:startStripMigration
 *   2. wait for logs to stop (or call :verifyComplete)
 *   3. Deploy the schema change (drop parsedHcr, parsedTripNumber, by_hcr_trip)
 *
 * Post-run, all loads will have these fields removed from the doc. Tag-based
 * reads continue unchanged. Any runtime code still reading `load.parsedHcr`
 * will start seeing `undefined` — Phase 3 already converted all such reads.
 */

const BATCH_SIZE = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/007_strip_parsed_columns'];
type _Ref = FunctionReference<'mutation' | 'action' | 'query', 'internal'>;
void (null as unknown as _Ref);

export const stripBatch = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    processed: v.number(),
    stripped: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let stripped = 0;
    for (const load of result.page) {
      // Only patch if there's actually stale data to remove. Convex's
      // ctx.db.patch with { field: undefined } REMOVES the field from
      // the doc (per Convex docs). This is what we want.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch: Record<string, any> = {};
      if ((load as { parsedHcr?: string }).parsedHcr !== undefined) {
        patch.parsedHcr = undefined;
      }
      if ((load as { parsedTripNumber?: string }).parsedTripNumber !== undefined) {
        patch.parsedTripNumber = undefined;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(load._id, patch);
        stripped++;
      }
    }

    return {
      processed: result.page.length,
      stripped,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * Entrypoint: loops stripBatch until all loads are processed. Returns
 * aggregate counts. Safe to re-run (idempotent — patches are no-ops on
 * already-stripped docs).
 */
export const startStripMigration = internalAction({
  args: {},
  returns: v.object({
    totalScanned: v.number(),
    totalStripped: v.number(),
  }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalScanned = 0;
    let totalStripped = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(self.stripBatch, {
        cursor: cursor ?? undefined,
      });
      totalScanned += batch.processed;
      totalStripped += batch.stripped;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(
      `[stripParsedColumns] scanned=${totalScanned} stripped=${totalStripped}`,
    );
    return { totalScanned, totalStripped };
  },
});

/**
 * Verification: counts loads that still have parsedHcr or parsedTripNumber.
 * Must return {remaining: 0} before deploying the schema drop.
 */
export const verifyComplete = internalAction({
  args: {},
  returns: v.object({
    scanned: v.number(),
    withParsedHcr: v.number(),
    withParsedTripNumber: v.number(),
    remaining: v.number(),
  }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let scanned = 0;
    let withParsedHcr = 0;
    let withParsedTripNumber = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runQuery(self.verifyBatch, {
        cursor: cursor ?? undefined,
      });
      scanned += batch.scanned;
      withParsedHcr += batch.withParsedHcr;
      withParsedTripNumber += batch.withParsedTripNumber;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    const remaining = withParsedHcr + withParsedTripNumber;
    console.log(
      `[stripParsedColumns:verify] scanned=${scanned} withHcr=${withParsedHcr} withTrip=${withParsedTripNumber} remaining=${remaining}`,
    );
    return { scanned, withParsedHcr, withParsedTripNumber, remaining };
  },
});

// Internal query used by verifyComplete's loop. Kept as a query so it
// doesn't take a write transaction.
export const verifyBatch = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    scanned: v.number(),
    withParsedHcr: v.number(),
    withParsedTripNumber: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let withParsedHcr = 0;
    let withParsedTripNumber = 0;
    for (const load of result.page) {
      if ((load as { parsedHcr?: string }).parsedHcr !== undefined) {
        withParsedHcr++;
      }
      if ((load as { parsedTripNumber?: string }).parsedTripNumber !== undefined) {
        withParsedTripNumber++;
      }
    }

    return {
      scanned: result.page.length,
      withParsedHcr,
      withParsedTripNumber,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});
