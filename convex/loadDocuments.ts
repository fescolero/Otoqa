import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

/**
 * Generate a signed upload URL for load documents.
 * Client uploads directly to this URL, then calls create() with storageId.
 */
export const generateUploadUrl = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Unauthenticated');
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Create a load document record after upload.
 */
export const create = mutation({
  args: {
    loadId: v.id('loadInformation'),
    storageId: v.id('_storage'),
    type: v.literal('EXTRA_DOC'),
    fileName: v.optional(v.string()),
    contentType: v.optional(v.string()),
  },
  returns: v.object({
    _id: v.id('loadDocuments'),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Unauthenticated');

    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

    const now = Date.now();
    const docId = await ctx.db.insert('loadDocuments', {
      loadId: args.loadId,
      type: args.type,
      storageId: args.storageId,
      fileName: args.fileName,
      contentType: args.contentType,
      uploadedAt: now,
      uploadedBy: identity.subject,
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
    type: v.optional(v.literal('EXTRA_DOC')),
  },
  returns: v.array(
    v.object({
      _id: v.id('loadDocuments'),
      loadId: v.id('loadInformation'),
      type: v.literal('EXTRA_DOC'),
      storageId: v.id('_storage'),
      fileName: v.optional(v.string()),
      contentType: v.optional(v.string()),
      uploadedAt: v.float64(),
      uploadedBy: v.string(),
      url: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

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
        fileName: doc.fileName,
        contentType: doc.contentType,
        uploadedAt: doc.uploadedAt,
        uploadedBy: doc.uploadedBy,
        url: await ctx.storage.getUrl(doc.storageId),
      }))
    );
  },
});
