'use node';

/**
 * Load documents — web/ops upload path ('use node' half).
 * docs/documents-storage-spec.md §1 "Upload flow (web)", §9.
 *
 * Same bucket contract and prefix as driver captures
 * (orgs/{orgId}/loads/{loadId}/{type}/…), same signed-metadata presign,
 * same HEAD-verified finalize. Rows land in `loadDocuments` with a key
 * only. The driver app keeps its own contract (s3Upload +
 * driverMobile.uploadLoadDocument) — nothing here changes it.
 *
 * Unlike entity documents there is no pending row: `loadDocuments` has
 * no status column and the mobile flow already lives with the same
 * presign → PUT → record shape. A closed tab between PUT and finalize
 * leaves an object with no row; that is invisible to users and cheap.
 */

import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  declaredFileProblem,
  metadataToHeaders,
  sanitizeFilename,
  webLoadDocTypeValidator as webDocType,
} from './lib/r2';
import { buildLoadDocumentKey, deleteObjectByKey, presignPutWithMetadata } from './s3Upload';
import { verifyStoredObject } from './lib/documentActionHandlers';

export const getUploadUrl = action({
  args: {
    loadId: v.id('loadInformation'),
    type: webDocType,
    fileName: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.object({
    key: v.string(),
    uploadUrl: v.string(),
    metadataHeaders: v.record(v.string(), v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ key: string; uploadUrl: string; metadataHeaders: Record<string, string> }> => {
    const contentType = args.contentType.toLowerCase();
    const problem = declaredFileProblem(contentType, args.sizeBytes);
    if (problem) throw new ConvexError(problem);
    // Org comes from the load row (never the client); loads:edit enforced.
    const load: { orgId: string } = await ctx.runQuery(internal.loadDocuments.resolveLoadForWebUpload, {
      loadId: args.loadId,
    });
    const key = buildLoadDocumentKey(load.orgId, args.loadId, args.type, sanitizeFilename(args.fileName));
    const metadata: Record<string, string> = {
      'org-id': load.orgId,
      'load-id': args.loadId,
      'doc-type': args.type,
      'uploaded-via': 'web',
    };
    const uploadUrl = await presignPutWithMetadata({ key, contentType, metadata });
    return { key, uploadUrl, metadataHeaders: metadataToHeaders(metadata) };
  },
});

export const finalizeUpload = action({
  args: {
    loadId: v.id('loadInformation'),
    type: webDocType,
    key: v.string(),
    fileName: v.string(),
    note: v.optional(v.string()),
  },
  returns: v.object({ documentId: v.id('loadDocuments') }),
  handler: async (ctx, args): Promise<{ documentId: Id<'loadDocuments'> }> => {
    // Ownership first: the key must be under a load the caller's org owns,
    // match the load/type being recorded, and not already back a recorded
    // document. No storage call before this.
    const owned: { loadId: Id<'loadInformation'>; orgId: string; type: string } = await ctx.runQuery(
      internal.loadDocuments.assertWebUploadKey,
      { key: args.key },
    );
    if (owned.loadId !== args.loadId || owned.type !== args.type) throw new ConvexError('Invalid document key');

    // Same verification policy as entity documents (documentActionHandlers).
    const check = await verifyStoredObject(args.key);
    if (!check.ok) throw new ConvexError(check.message);
    const created: { _id: Id<'loadDocuments'> } = await ctx.runMutation(internal.loadDocuments.createFromWeb, {
      loadId: args.loadId,
      type: args.type,
      externalKey: args.key,
      fileName: sanitizeFilename(args.fileName),
      contentType: check.contentType,
      note: args.note,
    });
    return { documentId: created._id };
  },
});

/** Client cancelled between presign and finalize — drop the object. */
export const cancelUpload = action({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // Same rule as finalize — an unauthenticated or cross-org caller must
    // not be able to delete anyone's object, and nobody may delete the
    // bytes behind a recorded document this way (that is loadDocuments.remove).
    await ctx.runQuery(internal.loadDocuments.assertWebUploadKey, { key: args.key });
    try {
      await deleteObjectByKey(args.key);
    } catch (e) {
      console.warn('[loadDocumentsWeb] cancel: delete failed', e);
    }
    return null;
  },
});
