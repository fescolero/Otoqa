'use node';

/**
 * Organization documents — the org's OWN compliance file (COI, W-9,
 * operating authority…), documents-storage-spec.md §6.1–6.2. Stored under
 * orgs/{orgId}/company/. When the org is a carrier linked to brokers, the
 * documents whose type is shared by default (and not withheld per
 * document) appear read-only on those brokers' partnership pages.
 *
 * `entityId` is the caller's own WorkOS org id; the access rule refuses
 * anything else.
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
    orgId: v.string(),
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
    presignEntityUpload(ctx, 'organization', { ...args, entityId: args.orgId }),
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
