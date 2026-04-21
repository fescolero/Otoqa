import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireCallerIdentity, requireCallerOrgId } from './lib/auth';

/**
 * Web-side load documents API.
 *
 * This module serves the dispatch / settlements web UI. Driver-sourced
 * documents (POD, receipts, accident reports, etc.) go through
 * driverMobile.uploadLoadDocument + s3Upload.getLoadDocumentUploadUrl
 * instead, since those require GPS + stop-inference metadata the web
 * UI doesn't have.
 *
 * Both paths write to the same `loadDocuments` table.
 */

// Shared type union — mirrors schema.ts. `EXTRA_DOC` retained as a
// deprecated alias so pre-migration rows keep validating.
const docType = v.union(
  v.literal('POD'),
  v.literal('Receipt'),
  v.literal('Cargo'),
  v.literal('Damage'),
  v.literal('Accident'),
  v.literal('Other'),
  v.literal('EXTRA_DOC'), // DEPRECATED
);

/**
 * Generate a signed upload URL for load documents.
 * Client uploads directly to this URL, then calls create() with storageId.
 */
export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    await requireCallerOrgId(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Create a load document record after upload (web/ops caller).
 * Drivers use driverMobile.uploadLoadDocument instead.
 */
export const create = mutation({
  args: {
    loadId: v.id('loadInformation'),
    storageId: v.id('_storage'),
    type: docType,
    fileName: v.optional(v.string()),
    contentType: v.optional(v.string()),
  },
  returns: v.object({
    _id: v.id('loadDocuments'),
  }),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId: subject } = await requireCallerIdentity(ctx);

    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== callerOrgId) {
      throw new Error('Load not found');
    }

    const now = Date.now();
    const docId = await ctx.db.insert('loadDocuments', {
      loadId: args.loadId,
      type: args.type,
      storageId: args.storageId,
      fileName: args.fileName,
      contentType: args.contentType,
      uploadedAt: now,
      uploadedBy: subject,
      workosOrgId: load.workosOrgId,
    });

    return { _id: docId };
  },
});

/**
 * List documents for a load (optionally filtered by type).
 */
export const listForLoad = query({
  args: {
    loadId: v.id('loadInformation'),
    type: v.optional(docType),
  },
  returns: v.array(
    v.object({
      _id: v.id('loadDocuments'),
      loadId: v.id('loadInformation'),
      type: docType,
      storageId: v.optional(v.id('_storage')),
      externalUrl: v.optional(v.string()),
      fileName: v.optional(v.string()),
      contentType: v.optional(v.string()),
      uploadedAt: v.float64(),
      uploadedBy: v.string(),
      capturedAt: v.optional(v.float64()),
      capturedLat: v.optional(v.number()),
      capturedLng: v.optional(v.number()),
      inferredStopId: v.optional(v.id('loadStops')),
      inferredStopSequence: v.optional(v.number()),
      inferredContext: v.optional(v.string()),
      note: v.optional(v.string()),
      url: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);

    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const type = args.type;
    const docs = type
      ? await ctx.db
          .query('loadDocuments')
          .withIndex('by_load_type', (q) => q.eq('loadId', args.loadId).eq('type', type))
          .collect()
      : await ctx.db
          .query('loadDocuments')
          .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
          .collect();

    return await Promise.all(
      docs.map(async (doc) => ({
        _id: doc._id,
        loadId: doc.loadId,
        type: doc.type,
        storageId: doc.storageId,
        externalUrl: doc.externalUrl,
        fileName: doc.fileName,
        contentType: doc.contentType,
        uploadedAt: doc.uploadedAt,
        uploadedBy: doc.uploadedBy,
        capturedAt: doc.capturedAt,
        capturedLat: doc.capturedLat,
        capturedLng: doc.capturedLng,
        inferredStopId: doc.inferredStopId,
        inferredStopSequence: doc.inferredStopSequence,
        inferredContext: doc.inferredContext,
        note: doc.note,
        // Prefer Convex `_storage` URL (web uploads) — fall back to the
        // externalUrl (S3/R2) for driver-captured docs that came through
        // the presigned-URL path.
        url: doc.storageId
          ? await ctx.storage.getUrl(doc.storageId)
          : (doc.externalUrl ?? null),
      })),
    );
  },
});
