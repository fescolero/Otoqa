import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
} from './_generated/server';
import { internal } from './_generated/api';
import type { FunctionReference } from 'convex/server';

/**
 * Facet system maintenance.
 *
 * The facetValues table is a presence-only cache — no refcount is tracked
 * on writes to avoid OCC hotspots. setLoadTag / removeAllTagsForLoad
 * leave facetValues rows in place when their last referencing loadTag
 * disappears (e.g. a load gets deleted, or its tag value changes).
 *
 * This cron reconciles the drift: every night it walks facetValues and
 * deletes any row that no loadTag references. Bounded and idempotent.
 */

const BATCH_SIZE = 200;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['facetMaintenance'];
type _Ref = FunctionReference<'mutation' | 'action', 'internal'>;
void (null as unknown as _Ref);

/**
 * Process a single batch. Deletes facetValues rows with no remaining
 * loadTags pointing at the same (org, facetKey, canonicalValue) tuple.
 */
export const pruneOrphanedFacetValuesBatch = internalMutation({
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

/**
 * Cron entrypoint: loops pruneOrphanedFacetValuesBatch until every
 * facetValues row has been evaluated. Safe to run at any frequency —
 * idempotent, bounded (each batch is one transaction), and cheap
 * (presence check is a single index lookup per facetValues row).
 */
export const pruneOrphanedFacetValues = internalAction({
  args: {},
  returns: v.object({
    totalScanned: v.number(),
    totalPruned: v.number(),
  }),
  handler: async (ctx) => {
    let cursor: string | null = null;
    let totalScanned = 0;
    let totalPruned = 0;
    let iterations = 0;
    const MAX_ITERATIONS = 20_000;

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const batch: any = await ctx.runMutation(
        self.pruneOrphanedFacetValuesBatch,
        { cursor: cursor ?? undefined },
      );
      totalScanned += batch.processed;
      totalPruned += batch.pruned;
      if (batch.isDone) break;
      cursor = batch.nextCursor;
    }

    console.log(
      `[facetMaintenance:pruneOrphans] scanned=${totalScanned} pruned=${totalPruned}`,
    );
    return { totalScanned, totalPruned };
  },
});
