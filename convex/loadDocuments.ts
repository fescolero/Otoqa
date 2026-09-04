import { ConvexError, v } from 'convex/values';
import { internalMutation, internalQuery, mutation, query, type QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import {
  assertOrgPermission,
  assertOrgPermissionOrNotFound,
  getCallerOrgId,
  requireCallerIdentity,
  requireCallerOrgId,
} from './lib/auth';
import { logAudit } from './lib/audit';
import { isStoredContentType, keyFromExternalUrl, webLoadDocTypeValidator as webDocType } from './lib/r2';
import { resolveAuthenticatedDriver } from './driverMobile';

/**
 * Web-side load documents API.
 *
 * This module serves the dispatch / settlements web UI. Driver-sourced
 * documents (POD, receipts, accident reports, etc.) go through
 * driverMobile.uploadLoadDocument + s3Upload.getLoadDocumentUploadUrl
 * instead, since those require GPS + stop-inference metadata the web
 * UI doesn't have. Web/ops uploads go through loadDocumentsWeb
 * (presign → PUT → HEAD-verified finalize) and land here via
 * createFromWeb. Both paths write to the same `loadDocuments` table and
 * the same R2 prefix (documents-storage-spec.md §1, §9).
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
 * True when a loadDocuments row on this load already references `key`.
 * A web caller may only finalize or cancel its OWN in-flight upload —
 * never register a second row on an existing object, and never delete
 * the bytes behind a recorded document (that is `remove`, audited).
 */
async function keyAlreadyRecorded(ctx: QueryCtx, loadId: Id<'loadInformation'>, key: string): Promise<boolean> {
  const rows = await ctx.db
    .query('loadDocuments')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();
  return rows.some((r) => (r.externalKey ?? (r.externalUrl ? keyFromExternalUrl(r.externalUrl) : null)) === key);
}

/**
 * Web/ops upload — step 1 (called by loadDocumentsWeb.getUploadUrl).
 * Resolves the owning org from the load row and checks loads:edit.
 */
export const resolveLoadForWebUpload = internalQuery({
  args: { loadId: v.id('loadInformation') },
  returns: v.object({ orgId: v.string(), orderNumber: v.optional(v.string()) }),
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new ConvexError('Load not found');
    await assertOrgPermissionOrNotFound(ctx, load.workosOrgId, 'loads:edit', 'Load not found');
    return { orgId: load.workosOrgId, orderNumber: load.orderNumber };
  },
});

/**
 * Ownership check for a client-supplied object key on the web load path.
 * Parses `orgs/{orgId}/loads/{loadId}/{type}/…`, requires the caller to be
 * a loads:edit member of THAT org, requires the load to exist there, and
 * refuses a key an existing document row already references. Runs before
 * any HEAD / DELETE so a caller can neither probe nor delete objects it
 * did not just presign.
 */
export const assertWebUploadKey = internalQuery({
  args: { key: v.string() },
  returns: v.object({ loadId: v.id('loadInformation'), orgId: v.string(), type: v.string() }),
  handler: async (ctx, args) => {
    const m = /^orgs\/([^/]+)\/loads\/([^/]+)\/([^/]+)\/[^/]+$/.exec(args.key);
    if (!m) throw new ConvexError('Invalid document key');
    const [, orgId, rawLoadId, type] = m;
    const callerOrgId = await requireCallerOrgId(ctx);
    if (callerOrgId !== orgId) throw new ConvexError('Invalid document key');
    await assertOrgPermission(ctx, orgId, 'loads:edit');
    const loadId = ctx.db.normalizeId('loadInformation', rawLoadId);
    const load = loadId ? await ctx.db.get(loadId) : null;
    if (!load || !loadId || load.workosOrgId !== orgId) throw new ConvexError('Invalid document key');
    if (await keyAlreadyRecorded(ctx, loadId, args.key)) throw new ConvexError('Invalid document key');
    return { loadId, orgId, type };
  },
});

/**
 * Web/ops upload — step 3 (called by loadDocumentsWeb.finalizeUpload after
 * the object was HEAD-verified). Stores the R2 key only — never a URL
 * (documents-storage-spec.md §1). The key MUST sit under the load's own
 * prefix so a client cannot register an arbitrary object.
 */
export const createFromWeb = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    type: webDocType,
    externalKey: v.string(),
    fileName: v.string(),
    contentType: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.object({ _id: v.id('loadDocuments') }),
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new ConvexError('Load not found');
    const who = await assertOrgPermission(ctx, load.workosOrgId, 'loads:edit');
    const prefix = `orgs/${load.workosOrgId}/loads/${args.loadId}/${args.type}/`;
    if (!args.externalKey.startsWith(prefix)) throw new ConvexError('Invalid document key');
    if (await keyAlreadyRecorded(ctx, args.loadId, args.externalKey)) throw new ConvexError('Invalid document key');
    if (!isStoredContentType(args.contentType)) throw new ConvexError('Unsupported file type');

    const now = Date.now();
    const docId = await ctx.db.insert('loadDocuments', {
      loadId: args.loadId,
      workosOrgId: load.workosOrgId,
      type: args.type,
      externalKey: args.externalKey,
      fileName: args.fileName,
      contentType: args.contentType,
      note: args.note?.trim() || undefined,
      uploadedBy: who.userId,
      uploadedAt: now,
    });
    await logAudit(ctx, {
      organizationId: load.workosOrgId,
      entityType: 'load',
      entityId: args.loadId,
      entityName: load.orderNumber,
      action: 'document_uploaded',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `Added ${args.type} document${args.fileName ? ` (${args.fileName})` : ''}`,
      changesAfter: JSON.stringify({ documentId: docId, type: args.type, fileName: args.fileName }),
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
      throw new ConvexError('Document not found');
    }
    await assertOrgPermission(ctx, orgId, 'loads:edit');

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
        // Only legacy Convex-storage rows carry a directly servable URL.
        // R2-backed rows (every driver capture and every web upload since
        // spec §9) are exchanged for a short-lived signed URL at click
        // time via s3Upload.getDocumentDownloadUrl — the bucket is private
        // and `externalUrl` is a legacy field, never a display URL.
        url: doc.storageId ? await ctx.storage.getUrl(doc.storageId) : null,
      })),
    );
  },
});

/**
 * Every load document the org owns, for the export zip (spec §7).
 * settings:manage. Files are fetched via s3Upload.getDocumentDownloadUrl.
 */
export const listAllForOrgExport = query({
  args: { cursor: v.optional(v.string()) },
  returns: v.object({
    rows: v.array(
      v.object({
        documentId: v.id('loadDocuments'),
        loadId: v.id('loadInformation'),
        orderNumber: v.optional(v.string()),
        type: docType,
        fileName: v.optional(v.string()),
        contentType: v.optional(v.string()),
        uploadedAt: v.float64(),
        hasFile: v.boolean(),
      }),
    ),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    await assertOrgPermission(ctx, orgId, 'settings:manage');
    // Paged: years of driver captures are one row each, far past what a
    // single query may read. The client walks the cursor.
    const page = await ctx.db
      .query('loadDocuments')
      .withIndex('by_org', (q) => q.eq('workosOrgId', orgId))
      .paginate({ cursor: args.cursor ?? null, numItems: 500 });
    const orders = new Map<string, string | undefined>();
    const out = [];
    for (const d of page.page) {
      let orderNumber = orders.get(d.loadId);
      if (orderNumber === undefined && !orders.has(d.loadId)) {
        orderNumber = (await ctx.db.get(d.loadId))?.orderNumber;
        orders.set(d.loadId, orderNumber);
      }
      out.push({
        documentId: d._id,
        loadId: d.loadId,
        orderNumber,
        type: d.type,
        fileName: d.fileName,
        contentType: d.contentType,
        uploadedAt: d.uploadedAt,
        hasFile: !!(d.storageId || d.externalKey || d.externalUrl),
      });
    }
    return { rows: out, nextCursor: page.isDone ? null : page.continueCursor };
  },
});
