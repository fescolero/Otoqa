'use node';

/**
 * Driver documents — the 'use node' half (R2 presign / HEAD / signed GET).
 * docs/documents-storage-spec.md §1 "Upload flow (web)".
 *
 * Thin by design: bodies live in lib/documentActionHandlers.ts; every
 * rule lives in entityDocuments.ts and runs with the caller's identity.
 * Explicit return annotations break the generated-API type cycle.
 */

import { v } from 'convex/values';
import { action } from './_generated/server';
import type { Id } from './_generated/dataModel';
import {
  cancelEntityUpload,
  finalizeEntityUpload,
  presignEntityUpload,
  signedDownloadUrl,
} from './lib/documentActionHandlers';

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
  ): Promise<{ docId: Id<'entityDocuments'>; uploadUrl: string; metadataHeaders: Record<string, string> }> =>
    presignEntityUpload(ctx, 'driver', { ...args, entityId: args.driverId }),
});

export const finalizeUpload = action({
  args: {
    docId: v.id('entityDocuments'),
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.object({ status: v.string() }),
  handler: async (ctx, args): Promise<{ status: string }> => finalizeEntityUpload(ctx, args),
});

export const cancelUpload = action({
  args: { docId: v.id('entityDocuments') },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => cancelEntityUpload(ctx, args.docId),
});

export const getDownloadUrl = action({
  args: { docId: v.id('entityDocuments') },
  returns: v.object({ url: v.string(), downloadUrl: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ url: string; downloadUrl: string; expiresAt: number }> =>
    signedDownloadUrl(ctx, args.docId),
});
