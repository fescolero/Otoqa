import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { setLoadTag, registerContractLaneFacet } from '../lib/loadFacets';

// Self-references for the scheduler. internal.migrations is keyed by full
// slash path which TS literal-indexing rejects; cast through unknown gives
// us a typed handle for the three functions we self-schedule.
type FnRef = Parameters<
  typeof import('../_generated/server')['internalMutation']
>[0] extends never
  ? never
  : import('convex/server').FunctionReference<'mutation', 'internal'>;
const self = (
  internal as unknown as Record<string, Record<string, FnRef>>
)['migrations/005_backfill_load_tags'];

/**
 * Migration: backfill loadTags + facetValues from existing loadInformation
 * and contractLanes data.
 *
 * Idempotent: setLoadTag and registerContractLaneFacet are no-ops when
 * the target row already matches. Safe to re-run after partial completion.
 *
 * Architecture: a self-rescheduling mutation. Each invocation processes
 * BATCH_SIZE rows and reschedules itself for the next batch via the
 * scheduler. This keeps each transaction within Convex's read/write
 * limits even on orgs with 100K+ loads.
 *
 * Run with:
 *   npx convex run migrations/005_backfill_load_tags:startBackfill
 *
 * Check progress:
 *   npx convex run migrations/005_backfill_load_tags:getProgress
 */

const BATCH_SIZE = 100;

// ─────────────────────────────────────────────────────────────────────
// PHASE A — backfill from contractLanes (small table, runs in one pass)
// ─────────────────────────────────────────────────────────────────────

export const backfillContractLaneFacets = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    processed: v.number(),
    registered: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('contractLanes')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let registered = 0;
    for (const lane of result.page) {
      if (lane.isDeleted) continue;
      if (lane.hcr) {
        await registerContractLaneFacet(ctx, lane.workosOrgId, 'HCR', lane.hcr);
        registered++;
      }
      if (lane.tripNumber) {
        await registerContractLaneFacet(
          ctx,
          lane.workosOrgId,
          'TRIP',
          lane.tripNumber,
        );
        registered++;
      }
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(
        0,
        self.backfillContractLaneFacets,
        { cursor: result.continueCursor },
      );
    }

    console.log(
      `[backfillContractLaneFacets] processed=${result.page.length} registered=${registered} done=${result.isDone}`,
    );

    return {
      processed: result.page.length,
      registered,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// PHASE B — backfill from loadInformation (large table, paginated)
// ─────────────────────────────────────────────────────────────────────

export const backfillLoadTags = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    processed: v.number(),
    tagged: v.number(),
    skipped: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    let tagged = 0;
    let skipped = 0;
    for (const load of result.page) {
      // Historic migration: reads stale column data that still lives on
      // pre-Phase-5b docs. Schema no longer declares these fields, so
      // cast to a loose shape for the read.
      const staleLoad = load as {
        parsedHcr?: string;
        parsedTripNumber?: string;
      };
      const hasHcr = !!staleLoad.parsedHcr;
      const hasTrip = !!staleLoad.parsedTripNumber;
      if (!hasHcr && !hasTrip) {
        skipped++;
        continue;
      }
      if (hasHcr) {
        await setLoadTag(ctx, {
          loadId: load._id,
          workosOrgId: load.workosOrgId,
          facetKey: 'HCR',
          value: staleLoad.parsedHcr,
          source: 'LOAD_MANUAL', // historic origin unknown — treat as manual
          firstStopDate: load.firstStopDate,
        });
        tagged++;
      }
      if (hasTrip) {
        await setLoadTag(ctx, {
          loadId: load._id,
          workosOrgId: load.workosOrgId,
          facetKey: 'TRIP',
          value: staleLoad.parsedTripNumber,
          source: 'LOAD_MANUAL',
          firstStopDate: load.firstStopDate,
        });
        tagged++;
      }
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, self.backfillLoadTags, {
        cursor: result.continueCursor,
      });
    }

    console.log(
      `[backfillLoadTags] processed=${result.page.length} tagged=${tagged} skipped=${skipped} done=${result.isDone}`,
    );

    return {
      processed: result.page.length,
      tagged,
      skipped,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// ENTRYPOINT — kicks off both phases
// ─────────────────────────────────────────────────────────────────────

export const startBackfill = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.boolean() }),
  handler: async (ctx) => {
    // Run lanes first (small, fast) so dropdown values are present
    // even if the load backfill is still in flight.
    await ctx.scheduler.runAfter(0, self.backfillContractLaneFacets, {});
    await ctx.scheduler.runAfter(0, self.backfillLoadTags, {});
    return { scheduled: true };
  },
});

// ─────────────────────────────────────────────────────────────────────
// VERIFICATION — run after backfill completes
// ─────────────────────────────────────────────────────────────────────

/**
 * Compares the parsedHcr/parsedTripNumber columns to the loadTags table
 * and reports any drift. Run after the backfill scheduler completes
 * to gate Phase 3 (reader swap).
 *
 * For each load: counts whether (parsedHcr -> HCR tag) and
 * (parsedTripNumber -> TRIP tag) are consistent.
 */
export const verifyBackfill = internalMutation({
  args: { cursor: v.optional(v.string()), accumulator: v.optional(v.any()) },
  returns: v.object({
    loadsChecked: v.number(),
    expectedHcrTags: v.number(),
    expectedTripTags: v.number(),
    actualHcrTags: v.number(),
    actualTripTags: v.number(),
    mismatches: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        kind: v.string(),
        expected: v.optional(v.string()),
        actual: v.optional(v.string()),
      }),
    ),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const acc = (args.accumulator as
      | undefined
      | {
          loadsChecked: number;
          expectedHcrTags: number;
          expectedTripTags: number;
          actualHcrTags: number;
          actualTripTags: number;
          mismatches: Array<{
            loadId: string;
            kind: string;
            expected?: string;
            actual?: string;
          }>;
        }) ?? {
      loadsChecked: 0,
      expectedHcrTags: 0,
      expectedTripTags: 0,
      actualHcrTags: 0,
      actualTripTags: 0,
      mismatches: [],
    };

    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    for (const load of result.page) {
      acc.loadsChecked++;
      // Historic verification: reads stale column data still on pre-7b docs.
      const staleLoad = load as {
        parsedHcr?: string;
        parsedTripNumber?: string;
      };
      if (staleLoad.parsedHcr) acc.expectedHcrTags++;
      if (staleLoad.parsedTripNumber) acc.expectedTripTags++;

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      const hcrTag = tags.find((t) => t.facetKey === 'HCR');
      const tripTag = tags.find((t) => t.facetKey === 'TRIP');
      if (hcrTag) acc.actualHcrTags++;
      if (tripTag) acc.actualTripTags++;

      // Mismatch detection: compare canonical
      if (staleLoad.parsedHcr) {
        const expected = staleLoad.parsedHcr.trim().toUpperCase();
        if (!hcrTag) {
          acc.mismatches.push({
            loadId: load._id,
            kind: 'HCR_MISSING_TAG',
            expected,
          });
        } else if (hcrTag.canonicalValue !== expected) {
          acc.mismatches.push({
            loadId: load._id,
            kind: 'HCR_VALUE_MISMATCH',
            expected,
            actual: hcrTag.canonicalValue,
          });
        }
      }
      if (staleLoad.parsedTripNumber) {
        const expected = staleLoad.parsedTripNumber.trim().toUpperCase();
        if (!tripTag) {
          acc.mismatches.push({
            loadId: load._id,
            kind: 'TRIP_MISSING_TAG',
            expected,
          });
        } else if (tripTag.canonicalValue !== expected) {
          acc.mismatches.push({
            loadId: load._id,
            kind: 'TRIP_VALUE_MISMATCH',
            expected,
            actual: tripTag.canonicalValue,
          });
        }
      }
    }

    if (!result.isDone) {
      await ctx.scheduler.runAfter(0, self.verifyBackfill, {
        cursor: result.continueCursor,
        accumulator: acc,
      });
    }

    console.log(
      `[verifyBackfill] checked=${acc.loadsChecked} mismatches=${acc.mismatches.length} done=${result.isDone}`,
    );

    return {
      loadsChecked: acc.loadsChecked,
      expectedHcrTags: acc.expectedHcrTags,
      expectedTripTags: acc.expectedTripTags,
      actualHcrTags: acc.actualHcrTags,
      actualTripTags: acc.actualTripTags,
      mismatches: acc.mismatches.slice(0, 50).map((m) => ({
        loadId: m.loadId as import('../_generated/dataModel').Id<
          'loadInformation'
        >,
        kind: m.kind,
        expected: m.expected,
        actual: m.actual,
      })),
      isDone: result.isDone,
    };
  },
});
