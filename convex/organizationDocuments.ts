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

import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { presignGet } from './s3Upload';
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

/**
 * Signed GET for the org-wide export (ExportAllDocumentsButton): any
 * document the caller's org owns, under settings:manage alone — the
 * per-entity view permissions are not required to export the whole file.
 */
export const getExportDownloadUrl = action({
  args: { docId: v.id('entityDocuments') },
  returns: v.object({ downloadUrl: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ downloadUrl: string; expiresAt: number }> => {
    const doc: { key: string; fileName?: string } | null = await ctx.runQuery(internal.entityDocuments.getForExport, {
      docId: args.docId,
    });
    if (!doc) throw new ConvexError('Document not found');
    const signed = await presignGet({ key: doc.key, downloadAs: doc.fileName ?? 'document' });
    return { downloadUrl: signed.url, expiresAt: signed.expiresAt };
  },
});
