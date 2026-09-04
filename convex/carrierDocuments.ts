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

import { ConvexError, v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { buildEntityDocumentMetadata } from './lib/r2';
import { copyObject, headObject } from './s3Upload';
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
  args: { docId: v.id('entityDocuments') },
  returns: v.object({ url: v.string(), downloadUrl: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args): Promise<{ url: string; downloadUrl: string; expiresAt: number }> =>
    signedDownloadUrl(ctx, args.docId),
});

/**
 * Save a copy (documents-storage-spec.md §7): during a linked carrier's
 * offboarding window, copy one of its shared company documents into the
 * broker's own partnership records — server-side CopyObject into the
 * broker's prefix, then the normal HEAD-verified activation. Afterwards
 * the broker-owned row keeps the type satisfied when the carrier's copy
 * is purged.
 */
export const saveSharedCopy = action({
  args: {
    partnershipId: v.id('carrierPartnerships'),
    sharedDocId: v.id('entityDocuments'),
    issueDate: v.optional(v.string()),
    expirationDate: v.optional(v.string()),
  },
  returns: v.object({ docId: v.id('entityDocuments') }),
  handler: async (ctx, args): Promise<{ docId: Id<'entityDocuments'> }> => {
    const src: {
      srcKey: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      issueDate?: string;
      expirationDate?: string;
      partnerTypeKey: string;
      carrierName: string;
    } = await ctx.runQuery(internal.entityDocuments.getSharedForCopy, {
      partnershipId: args.partnershipId,
      sharedDocId: args.sharedDocId,
      issueDate: args.issueDate,
      expirationDate: args.expirationDate,
    });

    const pending: { docId: Id<'entityDocuments'>; key: string; orgId: string; contentType: string } =
      await ctx.runMutation(internal.entityDocuments.createPending, {
        entity: 'carrier',
        entityId: args.partnershipId,
        typeKey: src.partnerTypeKey,
        fileName: src.fileName,
        contentType: src.contentType,
        sizeBytes: src.sizeBytes,
      });

    try {
      await copyObject({
        srcKey: src.srcKey,
        dstKey: pending.key,
        contentType: pending.contentType,
        metadata: buildEntityDocumentMetadata({
          orgId: pending.orgId,
          entity: 'carrier',
          entityId: args.partnershipId,
          typeKey: src.partnerTypeKey,
          docId: pending.docId,
          uploadedVia: 'web',
        }),
      });
      const head = await headObject(pending.key);
      if (!head) throw new ConvexError('Copy did not land in storage');
      await ctx.runMutation(internal.entityDocuments.finalize, {
        docId: pending.docId,
        verified: { contentType: (head.contentType ?? pending.contentType).toLowerCase(), sizeBytes: head.contentLength },
        issueDate: src.issueDate,
        expirationDate: src.expirationDate,
        note: `Saved copy from ${src.carrierName} before they left the platform`,
      });
    } catch (e) {
      // Same discard-then-delete as a cancelled upload: drop the pending
      // row and the object the copy may already have written.
      await cancelEntityUpload(ctx, pending.docId).catch(() => undefined);
      throw e;
    }
    return { docId: pending.docId };
  },
});
