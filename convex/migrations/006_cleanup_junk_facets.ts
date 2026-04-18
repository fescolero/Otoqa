import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { internal } from '../_generated/api';
import { classifyRefToken } from '../fourKitesApiClient';
import type { FunctionReference } from 'convex/server';

/**
 * Migration: clean up junk values that leaked into parsedHcr / parsedTripNumber
 * via the old position-based FourKites parser (e.g. "MPG", "BTF_DIESEL").
 *
 * Strategy — uses classifyRefToken (the new production classifier) as the
 * single source of truth for "what counts as a valid HCR/TRIP value".
 * Anything in parsedHcr that the classifier doesn't recognize as 'HCR',
 * or anything in parsedTripNumber that doesn't classify as 'TRIP', is
 * treated as junk and:
 *
 *   1. The bad field is set to undefined on loadInformation
 *   2. The matching loadTags row is deleted
 *   3. The facetValues row is deleted IF no remaining tags reference it
 *
 * Run after deploying the parser fix so future syncs write correct values:
 *   npx convex run migrations/006_cleanup_junk_facets:dryRun
 *   npx convex run migrations/006_cleanup_junk_facets:apply
 *
 * dryRun reports what WOULD be cleaned without modifying data.
 * apply runs the actual cleanup.
 *
 * Both are paginated and self-rescheduling for large datasets.
 */

const BATCH_SIZE = 100;

// Self-references for the scheduler (slash-keyed namespace can't be
// indexed via TS literal types).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/006_cleanup_junk_facets'];
type _Ref = FunctionReference<'mutation' | 'query', 'internal'>;
void (null as unknown as _Ref);

interface JunkFinding {
  loadId: string;
  workosOrgId: string;
  internalId: string;
  externalSource?: string;
  badHcr?: string;
  badTrip?: string;
}

// ─────────────────────────────────────────────────────────────────────
// SHARED SCAN — used by both dryRun and apply
// ─────────────────────────────────────────────────────────────────────

interface ScanAccumulator {
  scanned: number;
  badHcrCount: number;
  badTripCount: number;
  badHcrValues: Record<string, number>; // value → count
  badTripValues: Record<string, number>;
  sample: JunkFinding[];
}

function isJunkHcr(value: string | undefined): boolean {
  if (!value) return false;
  return classifyRefToken(value) !== 'HCR';
}
function isJunkTrip(value: string | undefined): boolean {
  if (!value) return false;
  return classifyRefToken(value) !== 'TRIP';
}

function emptyAcc(): ScanAccumulator {
  return {
    scanned: 0,
    badHcrCount: 0,
    badTripCount: 0,
    badHcrValues: {},
    badTripValues: {},
    sample: [],
  };
}

// ─────────────────────────────────────────────────────────────────────
// DRY RUN — read-only report
// ─────────────────────────────────────────────────────────────────────

/**
 * Scan a single batch. Used by the dryRun action and also directly
 * callable for tests/small datasets. Returns the batch's contribution
 * plus the cursor to continue from.
 */
export const scanBatch = internalQuery({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    batchScanned: v.number(),
    batchBadHcr: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        workosOrgId: v.string(),
        internalId: v.string(),
        externalSource: v.optional(v.string()),
        value: v.string(),
      }),
    ),
    batchBadTrip: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        workosOrgId: v.string(),
        internalId: v.string(),
        externalSource: v.optional(v.string()),
        value: v.string(),
      }),
    ),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    const batchBadHcr = [];
    const batchBadTrip = [];
    for (const load of result.page) {
      // Historic cleanup: reads stale column data still on pre-7b docs.
      const staleLoad = load as {
        parsedHcr?: string;
        parsedTripNumber?: string;
      };
      if (isJunkHcr(staleLoad.parsedHcr)) {
        batchBadHcr.push({
          loadId: load._id,
          workosOrgId: load.workosOrgId,
          internalId: load.internalId,
          externalSource: load.externalSource,
          value: staleLoad.parsedHcr!,
        });
      }
      if (isJunkTrip(staleLoad.parsedTripNumber)) {
        batchBadTrip.push({
          loadId: load._id,
          workosOrgId: load.workosOrgId,
          internalId: load.internalId,
          externalSource: load.externalSource,
          value: staleLoad.parsedTripNumber!,
        });
      }
    }

    return {
      batchScanned: result.page.length,
      batchBadHcr,
      batchBadTrip,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * Read-only dry run: paginates through ALL loads via scanBatch and
 * returns aggregated junk-value report. Runs as an action so it can
 * loop across many query invocations (a single query can't paginate
 * unbounded).
 */
export const dryRun = internalAction({
  args: {},
  returns: v.object({
    scanned: v.number(),
    badHcrCount: v.number(),
    badTripCount: v.number(),
    distinctBadHcrValues: v.array(
      v.object({ value: v.string(), count: v.number() }),
    ),
    distinctBadTripValues: v.array(
      v.object({ value: v.string(), count: v.number() }),
    ),
    sample: v.array(
      v.object({
        loadId: v.string(),
        workosOrgId: v.string(),
        internalId: v.string(),
        externalSource: v.optional(v.string()),
        badHcr: v.optional(v.string()),
        badTrip: v.optional(v.string()),
      }),
    ),
  }),
  handler: async (ctx) => {
    const acc = emptyAcc();
    let cursor: string | null = null;
    let iterations = 0;
    // Safety upper bound — at BATCH_SIZE=100 this is 2M loads max.
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runQuery(self.scanBatch, {
        cursor: cursor ?? undefined,
      });
      acc.scanned += batch.batchScanned;

      for (const row of batch.batchBadHcr) {
        acc.badHcrCount++;
        const k = row.value.trim().toUpperCase();
        acc.badHcrValues[k] = (acc.badHcrValues[k] ?? 0) + 1;
        if (acc.sample.length < 20) {
          acc.sample.push({
            loadId: row.loadId,
            workosOrgId: row.workosOrgId,
            internalId: row.internalId,
            externalSource: row.externalSource,
            badHcr: row.value,
          });
        }
      }
      for (const row of batch.batchBadTrip) {
        acc.badTripCount++;
        const k = row.value.trim().toUpperCase();
        acc.badTripValues[k] = (acc.badTripValues[k] ?? 0) + 1;
        if (acc.sample.length < 20) {
          acc.sample.push({
            loadId: row.loadId,
            workosOrgId: row.workosOrgId,
            internalId: row.internalId,
            externalSource: row.externalSource,
            badTrip: row.value,
          });
        }
      }

      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(
      `[cleanupJunk:dryRun] scanned=${acc.scanned} badHcr=${acc.badHcrCount} badTrip=${acc.badTripCount}`,
    );

    return {
      scanned: acc.scanned,
      badHcrCount: acc.badHcrCount,
      badTripCount: acc.badTripCount,
      distinctBadHcrValues: Object.entries(acc.badHcrValues)
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
      distinctBadTripValues: Object.entries(acc.badTripValues)
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
      sample: acc.sample,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// APPLY — destructive cleanup
// ─────────────────────────────────────────────────────────────────────

/**
 * Process a single batch of cleanup. Used by the apply action and
 * directly callable for tests/small datasets.
 */
export const applyBatch = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    processed: v.number(),
    loadsCleared: v.number(),
    tagsDeleted: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let loadsCleared = 0;
    let tagsDeleted = 0;

    for (const load of result.page) {
      // Historic cleanup: reads stale column data still on pre-7b docs.
      const staleLoad = load as {
        parsedHcr?: string;
        parsedTripNumber?: string;
      };
      const badHcr = isJunkHcr(staleLoad.parsedHcr);
      const badTrip = isJunkTrip(staleLoad.parsedTripNumber);
      if (!badHcr && !badTrip) continue;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const patch: Record<string, any> = {};
      if (badHcr) patch.parsedHcr = undefined;
      if (badTrip) patch.parsedTripNumber = undefined;
      // Cast through any for the patch since the schema no longer
      // declares these fields but the doc still carries them.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (ctx.db as any).patch(load._id, patch);

      if (badHcr) {
        const hcrTag = await ctx.db
          .query('loadTags')
          .withIndex('by_load_key', (q) =>
            q.eq('loadId', load._id).eq('facetKey', 'HCR'),
          )
          .unique();
        if (hcrTag) {
          await ctx.db.delete(hcrTag._id);
          tagsDeleted++;
        }
      }
      if (badTrip) {
        const tripTag = await ctx.db
          .query('loadTags')
          .withIndex('by_load_key', (q) =>
            q.eq('loadId', load._id).eq('facetKey', 'TRIP'),
          )
          .unique();
        if (tripTag) {
          await ctx.db.delete(tripTag._id);
          tagsDeleted++;
        }
      }
      loadsCleared++;
    }

    return {
      processed: result.page.length,
      loadsCleared,
      tagsDeleted,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

/**
 * Apply the cleanup synchronously: loops applyBatch until done, then
 * prunes orphaned facetValues. Returns final aggregated counts.
 *
 * Action variant chosen over a self-rescheduling mutation so the CLI
 * invocation actually waits for completion. Each batch is still its
 * own transaction, so partial failures don't corrupt mid-cleanup.
 */
export const apply = internalAction({
  args: {},
  returns: v.object({
    totalScanned: v.number(),
    totalLoadsCleared: v.number(),
    totalTagsDeleted: v.number(),
    totalFacetValuesPruned: v.number(),
  }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalScanned = 0;
    let totalLoadsCleared = 0;
    let totalTagsDeleted = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(self.applyBatch, {
        cursor: cursor ?? undefined,
      });
      totalScanned += batch.processed;
      totalLoadsCleared += batch.loadsCleared;
      totalTagsDeleted += batch.tagsDeleted;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    // Prune orphaned facetValues (the now-unreferenced MPG / BTF_DIESEL rows).
    let pruneCursor: string | null = null;
    let totalFacetValuesPruned = 0;
    let pruneIterations = 0;
    while (pruneIterations < MAX_ITERATIONS) {
      pruneIterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(self.pruneBatch, {
        cursor: pruneCursor ?? undefined,
      });
      totalFacetValuesPruned += batch.pruned;
      if (batch.isDone) break;
      pruneCursor = batch.nextCursor;
    }

    console.log(
      `[cleanupJunk:apply] scanned=${totalScanned} cleared=${totalLoadsCleared} tagsDeleted=${totalTagsDeleted} pruned=${totalFacetValuesPruned}`,
    );

    return {
      totalScanned,
      totalLoadsCleared,
      totalTagsDeleted,
      totalFacetValuesPruned,
    };
  },
});

/**
 * Single-batch prune of orphaned facetValues. Called in a loop by the
 * apply action. Deletes facetValues rows whose canonicalValue has no
 * remaining loadTags references — typically the just-cleared junk rows
 * (MPG, BTF_DIESEL).
 *
 * Idempotent and safe to run independently if needed.
 */
export const pruneBatch = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    processed: v.number(),
    pruned: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('facetValues')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let pruned = 0;
    for (const facet of result.page) {
      const referencingTag = await ctx.db
        .query('loadTags')
        .withIndex('by_org_key_canonical_date', (q) =>
          q
            .eq('workosOrgId', facet.workosOrgId)
            .eq('facetKey', facet.facetKey)
            .eq('canonicalValue', facet.canonicalValue),
        )
        .first();
      if (!referencingTag) {
        await ctx.db.delete(facet._id);
        pruned++;
      }
    }

    return {
      processed: result.page.length,
      pruned,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});
