'use node';

/**
 * Driver documents — the 'use node' half (R2 presign / HEAD / signed GET).
 * docs/documents-storage-spec.md §1 "Upload flow (web)".
 *
 * Thin by design: every rule (access, catalog, dates, mirrors, summary,
 * audit) lives in entityDocuments.ts and runs with the caller's identity
 * via ctx.runMutation / ctx.runQuery. This file only talks to the bucket.
 *
 * Explicit return annotations on every handler break the generated-API
 * type cycle (same reason s3Upload.ts annotates).
 */

import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  MAX_DOCUMENT_BYTES,
  buildEntityDocumentMetadata,
  isStoredContentType,
  metadataToHeaders,
} from './lib/r2';
import { deleteObjectByKey, headObject, presignGet, presignPutWithMetadata } from './s3Upload';

/**
 * Step 1: presign. Inserts the pending row (which yields the doc id the
 * key is built from) and returns the PUT URL plus the signed metadata
 * headers the browser must echo verbatim.
 */
export const getUploadUrl = action({
  args: {
    driverId: v.id('drivers'),
    typeKey: v.string(),
    fileName: v.string(),
    contentType: v.string(),
    sizeBytes: v.number(),
  },
  returns: v.object({
    docId: v.id('entityDocuments'),
    uploadUrl: v.string(),
    metadataHeaders: v.record(v.string(), v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ docId: Id<'entityDocuments'>; uploadUrl: string; metadataHeaders: Record<string, string> }> => {
    const pending: { docId: Id<'entityDocuments'>; key: string; orgId: string; contentType: string } =
      await ctx.runMutation(internal.entityDocuments.createPending, {
        entity: 'driver',
        entityId: args.driverId,
        typeKey: args.typeKey,
        fileName: args.fileName,
        contentType: args.contentType,
        sizeBytes: args.sizeBytes,
      });

    const metadata = buildEntityDocumentMetadata({
      orgId: pending.orgId,
      entity: 'driver',
      entityId: args.driverId,
      typeKey: args.typeKey,
      docId: pending.docId,
      uploadedVia: 'web',
    });
    const uploadUrl = await presignPutWithMetadata({
      key: pending.key,
      contentType: pending.contentType,
      metadata,
    });
    return { docId: pending.docId, uploadUrl, metadataHeaders: metadataToHeaders(metadata) };
  },
});

/**
 * Step 3: finalize. Verifies the object R2 actually holds (size + type),
 * discarding it on any mismatch, then activates the row with the
 * user-entered dates.
 */
export const finalizeUpload = action({
  args: {
    docId: v.id('entityDocuments'),
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args): Promise<{ status: string }> => {
    const pending: { status: string; key?: string; declaredContentType?: string } | null =
      await ctx.runQuery(internal.entityDocuments.getPendingForFinalize, { docId: args.docId });
    if (!pending) throw new ConvexError('Not found');
    if (pending.status === 'active') return { status: 'active' };
    if (pending.status !== 'pending' || !pending.key) {
      throw new ConvexError('Upload is no longer pending');
    }

    const head = await headObject(pending.key);
    if (!head) throw new ConvexError('Upload not found in storage. Please try again.');

    const contentType = (head.contentType ?? pending.declaredContentType ?? '').toLowerCase();
    const tooBig = head.contentLength > MAX_DOCUMENT_BYTES;
    const badType = !isStoredContentType(contentType);
    if (tooBig || badType) {
      await deleteObjectByKey(pending.key);
      await ctx.runMutation(internal.entityDocuments.discardPending, { docId: args.docId });
      throw new ConvexError(
        tooBig ? 'File is too large (25 MB max).' : 'Unsupported file type. Upload a PDF, JPEG, PNG, or WebP.',
      );
    }

    const result: { status: string } = await ctx.runMutation(internal.entityDocuments.finalize, {
      docId: args.docId,
      verified: { contentType, sizeBytes: head.contentLength },
      issueDate: args.issueDate,
      expirationDate: args.expirationDate,
      note: args.note,
    });
    return result;
  },
});

/** Client cancelled between presign and finalize. */
export const cancelUpload = action({
  args: { docId: v.id('entityDocuments') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const dropped: { key?: string } | null = await ctx.runMutation(
      internal.entityDocuments.discardPending,
      { docId: args.docId },
    );
    if (dropped?.key) {
      try {
        await deleteObjectByKey(dropped.key);
      } catch (e) {
        // Object may never have been written; the sweep is the backstop.
        console.warn('[driverDocuments] cancel: delete failed', e);
      }
    }
    return null;
  },
});

/**
 * Short-lived signed GET. `download: true` forces attachment disposition
 * so the file is saved rather than rendered.
 */
export const getDownloadUrl = action({
  args: { docId: v.id('entityDocuments'), download: v.optional(v.boolean()) },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ url: string; expiresAt: number }> => {
    const doc: { key: string; fileName?: string; contentType?: string } | null = await ctx.runQuery(
      internal.entityDocuments.getForAccess,
      { docId: args.docId },
    );
    if (!doc) throw new ConvexError('Document not found');
    return presignGet({ key: doc.key, downloadAs: args.download ? doc.fileName ?? 'document' : undefined });
  },
});
