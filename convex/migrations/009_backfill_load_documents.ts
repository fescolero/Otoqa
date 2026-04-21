/**
 * Migration 009 — backfill loadDocuments.
 *
 * Two passes, both idempotent:
 *
 * 1. Remap legacy EXTRA_DOC rows (web settlement uploader) to 'Other'.
 *    The new classification drops EXTRA_DOC from the driver API; keeping
 *    it in the schema union only for migration safety.
 *
 * 2. Walk every loadStops row and emit one `POD`-typed loadDocuments
 *    record per entry in `stop.deliveryPhotos[]`. capturedAt falls back
 *    to checkedOutAt → updatedAt → _creationTime in that order.
 *    inferredContext is hardcoded to AT_STOP because the legacy field
 *    was only written during check-out at a DELIVERY stop.
 *
 * Re-runnable: the pass skips stops already represented in loadDocuments
 * via a (loadId, externalUrl, type=POD) lookup, so partial runs are safe
 * and the migration can be invoked again after backend deploys that land
 * new legacy data (unlikely but safe).
 *
 * Usage (preferred — auto-loops through every page):
 *   npx convex run migrations/009_backfill_load_documents:runAll
 *
 * Usage (manual paging, for debugging a single batch):
 *   npx convex run migrations/009_backfill_load_documents:remapExtraDocRows
 *   npx convex run migrations/009_backfill_load_documents:backfillPodFromDeliveryPhotos
 *   # then feed nextCursor back in:
 *   npx convex run migrations/009_backfill_load_documents:backfillPodFromDeliveryPhotos '{"cursor":"<nextCursor>"}'
 */
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { v } from 'convex/values';

// Typed alias for the circular self-reference. `internal` hasn't indexed
// the new migration path yet at typecheck time, so we cast through any —
// matches the pattern in migration 008.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/009_backfill_load_documents'];

export const remapExtraDocRows = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    patched: v.number(),
    nextCursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 200;
    const page = await ctx.db
      .query('loadDocuments')
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let patched = 0;
    for (const doc of page.page) {
      if (doc.type === 'EXTRA_DOC') {
        await ctx.db.patch(doc._id, { type: 'Other' });
        patched++;
      }
    }

    return {
      patched,
      nextCursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

export const backfillPodFromDeliveryPhotos = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    scanned: v.number(),
    inserted: v.number(),
    nextCursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? 100;
    const page = await ctx.db
      .query('loadStops')
      .paginate({ cursor: args.cursor ?? null, numItems: batchSize });

    let inserted = 0;

    for (const stop of page.page) {
      const photos = stop.deliveryPhotos;
      if (!photos || photos.length === 0) continue;

      const load = await ctx.db.get(stop.loadId);
      if (!load) continue;

      // Idempotency — skip photos already present as loadDocuments for
      // this load. One lookup per stop covers all N photos on it.
      const existing = await ctx.db
        .query('loadDocuments')
        .withIndex('by_load_type', (q) => q.eq('loadId', stop.loadId).eq('type', 'POD'))
        .collect();
      const existingUrls = new Set(
        existing.map((d) => d.externalUrl).filter((u): u is string => !!u),
      );

      const capturedAt = stop.checkedOutAt
        ? Date.parse(stop.checkedOutAt)
        : (stop.updatedAt ?? stop._creationTime);

      for (const photoUrl of photos) {
        if (existingUrls.has(photoUrl)) continue;

        await ctx.db.insert('loadDocuments', {
          loadId: stop.loadId,
          workosOrgId: load.workosOrgId,
          type: 'POD',
          externalUrl: photoUrl,
          uploadedBy: 'migration:009',
          capturedAt: Number.isFinite(capturedAt) ? capturedAt : stop._creationTime,
          uploadedAt: Date.now(),
          inferredStopId: stop._id,
          inferredStopSequence: stop.sequenceNumber,
          inferredContext: 'AT_STOP',
        });
        inserted++;
      }
    }

    return {
      scanned: page.page.length,
      inserted,
      nextCursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});

/**
 * Loop wrapper — runs both passes to completion in a single command so the
 * operator doesn't have to shuffle cursors. Prints per-pass totals and
 * returns the grand summary.
 *
 * Actions can't access the DB directly but CAN invoke internalMutations
 * in a loop via ctx.runMutation, which is exactly what we want here.
 */
export const runAll = internalAction({
  args: {},
  returns: v.object({
    extraDocsPatched: v.number(),
    stopsScanned: v.number(),
    podsInserted: v.number(),
    iterations: v.number(),
  }),
  handler: async (ctx) => {
    const MAX_ITERATIONS = 20_000;

    // Pass 1 — remap EXTRA_DOC → Other.
    let cursor: string | null = null;
    let extraDocsPatched = 0;
    let iters1 = 0;
    while (iters1 < MAX_ITERATIONS) {
      iters1++;
      const batch: { patched: number; nextCursor: string | null; done: boolean } =
        await ctx.runMutation(self.remapExtraDocRows, {
          cursor: cursor ?? undefined,
        });
      extraDocsPatched += batch.patched;
      if (batch.done) break;
      cursor = batch.nextCursor;
    }
    console.log(`[migration 009] remap done — patched=${extraDocsPatched}`);

    // Pass 2 — backfill POD rows from stop.deliveryPhotos.
    cursor = null;
    let stopsScanned = 0;
    let podsInserted = 0;
    let iters2 = 0;
    while (iters2 < MAX_ITERATIONS) {
      iters2++;
      const batch: {
        scanned: number;
        inserted: number;
        nextCursor: string | null;
        done: boolean;
      } = await ctx.runMutation(self.backfillPodFromDeliveryPhotos, {
        cursor: cursor ?? undefined,
      });
      stopsScanned += batch.scanned;
      podsInserted += batch.inserted;
      if (batch.done) break;
      cursor = batch.nextCursor;
    }
    console.log(
      `[migration 009] POD backfill done — scanned=${stopsScanned} inserted=${podsInserted}`,
    );

    return {
      extraDocsPatched,
      stopsScanned,
      podsInserted,
      iterations: iters1 + iters2,
    };
  },
});
