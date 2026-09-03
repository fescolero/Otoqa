/**
 * Shared bodies for the per-entity 'use node' document actions
 * (driverDocuments / carrierDocuments / organizationDocuments).
 *
 * Node-runtime only: imports the S3 helpers. Each entity file stays a
 * thin wrapper that fixes `entity` and its own argument shape — one
 * bucket contract, no generic presign action (documents-storage-spec.md
 * §10). Every rule (access, catalog, dates, mirrors, summary, audit)
 * lives in entityDocuments.ts and runs via ctx.runMutation / runQuery
 * with the caller's identity.
 */

import { ConvexError } from 'convex/values';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import type { DocumentEntity } from './documentTypeDefaults';
import {
  MAX_DOCUMENT_BYTES,
  buildEntityDocumentMetadata,
  isStoredContentType,
  metadataToHeaders,
} from './r2';
import { deleteObjectByKey, headObject, presignGet, presignPutWithMetadata } from '../s3Upload';

export interface PresignArgs {
  entityId: string;
  typeKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface PresignResult {
  docId: Id<'entityDocuments'>;
  uploadUrl: string;
  metadataHeaders: Record<string, string>;
}

/** Step 1: insert the pending row, presign the PUT. */
export async function presignEntityUpload(
  ctx: ActionCtx,
  entity: DocumentEntity,
  args: PresignArgs,
): Promise<PresignResult> {
  const pending: { docId: Id<'entityDocuments'>; key: string; orgId: string; contentType: string } =
    await ctx.runMutation(internal.entityDocuments.createPending, {
      entity,
      entityId: args.entityId,
      typeKey: args.typeKey,
      fileName: args.fileName,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
    });

  const metadata = buildEntityDocumentMetadata({
    orgId: pending.orgId,
    entity,
    entityId: args.entityId,
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
}

export interface FinalizeArgs {
  docId: Id<'entityDocuments'>;
  issueDate?: string;
  expirationDate?: string;
  note?: string;
}

/** Step 3: verify the object R2 holds, then activate. */
export async function finalizeEntityUpload(ctx: ActionCtx, args: FinalizeArgs): Promise<{ status: string }> {
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
}

/** Client cancelled between presign and finalize. */
export async function cancelEntityUpload(ctx: ActionCtx, docId: Id<'entityDocuments'>): Promise<null> {
  const dropped: { key?: string } | null = await ctx.runMutation(internal.entityDocuments.discardPending, {
    docId,
  });
  if (dropped?.key) {
    try {
      await deleteObjectByKey(dropped.key);
    } catch (e) {
      // Object may never have been written; the sweep is the backstop.
      console.warn('[documents] cancel: delete failed', e);
    }
  }
  return null;
}

/** Short-lived signed GET; `download` forces attachment disposition. */
export async function signedDownloadUrl(
  ctx: ActionCtx,
  docId: Id<'entityDocuments'>,
  download?: boolean,
): Promise<{ url: string; expiresAt: number }> {
  const doc: { key: string; fileName?: string; contentType?: string } | null = await ctx.runQuery(
    internal.entityDocuments.getForAccess,
    { docId },
  );
  if (!doc) throw new ConvexError('Document not found');
  return presignGet({ key: doc.key, downloadAs: download ? doc.fileName ?? 'document' : undefined });
}
