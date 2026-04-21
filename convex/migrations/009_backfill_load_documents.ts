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
 */
import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';

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
