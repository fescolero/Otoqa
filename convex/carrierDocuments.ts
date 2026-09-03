'use node';

/**
 * Carrier-partnership documents — the broker's own records about a
 * carrier (documents-storage-spec.md §6.1). Owned by the broker org,
 * stored under orgs/{brokerOrgId}/carriers/{partnershipId}/.
 *
 * Shared documents the carrier org publishes are READ through
 * entityDocuments.listForEntity and downloaded via getDownloadUrl below
 * (the access rule allows a linked broker to read a shared organization
 * document); they are never uploaded from here.
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
    partnershipId: v.id('carrierPartnerships'),
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
    presignEntityUpload(ctx, 'carrier', { ...args, entityId: args.partnershipId }),
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
  args: { docId: v.id('entityDocuments'), download: v.optional(v.boolean()) },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ url: string; expiresAt: number }> =>
    signedDownloadUrl(ctx, args.docId, args.download),
});
