import { v } from 'convex/values';
import { internalQuery, mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { getCallerOrgId, requireCallerIdentity, requireCallerOrgId } from './lib/auth';
import { keyFromExternalUrl } from './lib/r2';
import { resolveAuthenticatedDriver } from './driverMobile';

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
 * Resolve a client-supplied loadId string to its owning org.
 *
 * Used by the s3Upload presign actions to build the org-prefixed object
 * key — the org MUST come from the load row, never from the client.
 * Returns null for unparseable/unknown ids (the action falls back to the
 * 'unassigned' segment rather than blocking a driver upload).
 */
export const resolveLoadOrg = internalQuery({
  args: {
    loadId: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    const loadId = ctx.db.normalizeId('loadInformation', args.loadId);
    if (!loadId) return null;
    const load = await ctx.db.get(loadId);
    return load?.workosOrgId ?? null;
  },
});

/**
 * Fetch a document row for the signed-GET action, enforcing access:
 * org members (WorkOS identity) must match the doc's org; drivers
 * (Clerk identity) must be assigned to the doc's load. Returns null on
 * any auth/scope miss so the action fails closed.
 */
export const getDocForAccess = internalQuery({
  args: {
    documentId: v.id('loadDocuments'),
  },
  returns: v.union(
    v.object({
      storageId: v.optional(v.id('_storage')),
      externalKey: v.optional(v.string()),
      externalUrl: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const doc = await ctx.db.get(args.documentId);
    if (!doc) return null;

    const orgId = await getCallerOrgId(ctx);

    if (orgId) {
      if (doc.workosOrgId !== orgId) return null;
    } else {
      // No org claim → driver-app caller. Same assignment rules as
      // driverMobile.getLoadDocuments.
      let driver;
      try {
        driver = await resolveAuthenticatedDriver(ctx);
      } catch {
        return null;
      }
      const load = await ctx.db.get(doc.loadId);
      if (!load) return null;
      let hasAccess = load.primaryDriverId === driver._id;
      if (!hasAccess) {
        const carrierAssignment = await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_load', (q) => q.eq('loadId', doc.loadId))
          .first();
        hasAccess = carrierAssignment?.assignedDriverId === driver._id;
      }
      if (!hasAccess) return null;
    }

    return {
      storageId: doc.storageId,
      externalKey: doc.externalKey,
      externalUrl: doc.externalUrl,
    };
  },
});

/**
 * Delete a load document: removes the Convex row, the underlying bytes
 * (Convex storage or R2 via a scheduled DeleteObject), and any legacy
 * stop.deliveryPhotos reference that points at the same object.
 *
 * Ops/web only — drivers can't delete evidence from the app. Row goes
 * first so a crash mid-way leaves at worst an orphaned object (invisible
 * to users, sweepable), never a live row pointing at deleted bytes.
 */
export const remove = mutation({
  args: {
    documentId: v.id('loadDocuments'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId } = await requireCallerIdentity(ctx);

    const doc = await ctx.db.get(args.documentId);
    if (!doc || doc.workosOrgId !== orgId) {
      throw new Error('Document not found');
    }

    await ctx.db.delete(args.documentId);

    if (doc.storageId) {
      await ctx.storage.delete(doc.storageId);
    }

    const r2Key = doc.externalKey ?? (doc.externalUrl ? keyFromExternalUrl(doc.externalUrl) : null);
    if (r2Key) {
      await ctx.scheduler.runAfter(0, internal.s3Upload.deleteObject, { key: r2Key });
    }

    // POD rows are dual-written into stop.deliveryPhotos (legacy web UI
    // reads it) — scrub the dangling URL so the load detail page doesn't
    // render a broken image.
    if (doc.externalUrl) {
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', doc.loadId))
        .collect();
      for (const stop of stops) {
        if (stop.deliveryPhotos?.includes(doc.externalUrl)) {
          await ctx.db.patch(stop._id, {
            deliveryPhotos: stop.deliveryPhotos.filter((url) => url !== doc.externalUrl),
          });
        }
      }
    }

    return null;
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
      externalKey: v.optional(v.string()),
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
        externalKey: doc.externalKey,
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
        // the presigned-URL path. The externalUrl fallback only renders
        // while the R2 bucket is public; once it's flipped private,
        // consumers must exchange the row for a short-lived URL via
        // s3Upload.getDocumentDownloadUrl instead.
        url: doc.storageId
          ? await ctx.storage.getUrl(doc.storageId)
          : (doc.externalUrl ?? null),
      })),
    );
  },
});
