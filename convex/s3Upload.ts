'use node';

import { v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Id } from './_generated/dataModel';

// ============================================
// S3/R2 UPLOAD ACTION
// Generate presigned URLs for direct mobile uploads
// Supports both AWS S3 and Cloudflare R2
// ============================================
//
// Bucket layout (see docs/r2-storage.md for the full contract):
//
//   orgs/{workosOrgId}/loads/{loadId}/{docType}/{ts}-{rand}-{filename}
//
// The org segment comes from the load row server-side (never from the
// client), so a per-customer export or deletion is a single prefix
// operation. Legacy prefixes `pod-photos/` and `load-documents/` are
// read-only history — no new objects land there.

function createS3Client() {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || 'auto';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const r2AccountId = process.env.R2_ACCOUNT_ID; // For Cloudflare R2

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error('S3/R2 configuration not found. Please set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.');
  }

  // Determine endpoint - use R2 if account ID is provided
  const endpoint = r2AccountId
    ? `https://${r2AccountId}.r2.cloudflarestorage.com`
    : undefined; // Use default AWS endpoint

  // Log config without sensitive details
  console.log('[S3Upload] Creating client for region:', region);

  return {
    client: new S3Client({
      region,
      endpoint,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      // R2 requires this for presigned URLs
      forcePathStyle: !!r2AccountId,
    }),
    bucket,
    r2AccountId,
  };
}

/**
 * Build the canonical object key for a driver-captured load document.
 *
 * `orgSegment` is the load's workosOrgId, or 'unassigned' when the load
 * couldn't be resolved (a driver mid-checkout must never be blocked on a
 * bucket-layout concern — 'unassigned' objects are rare and easy to
 * audit). The random suffix guards against two captures landing in the
 * same millisecond.
 */
function buildDocumentKey(
  orgSegment: string,
  loadId: string,
  docType: string,
  filename: string,
): string {
  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 8);
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
  return `orgs/${orgSegment}/loads/${loadId}/${docType}/${timestamp}-${randomSuffix}-${sanitizedFilename}`;
}

function buildFileUrl(key: string, r2AccountId: string | undefined, bucket: string): string {
  const cloudflareDomain = process.env.CLOUDFLARE_DOMAIN;
  if (cloudflareDomain) {
    return `https://${cloudflareDomain}/${key}`;
  } else if (r2AccountId) {
    // R2 public URL (if bucket is public)
    return `https://pub-${r2AccountId}.r2.dev/${key}`;
  }
  return `https://${bucket}.s3.amazonaws.com/${key}`;
}

/**
 * Resolve the org segment for a client-supplied loadId string. Returns
 * 'unassigned' when the id doesn't resolve to a load — never trusts a
 * client-supplied org value.
 */
async function resolveOrgSegment(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  loadId: string,
): Promise<string> {
  const org = await ctx.runQuery(internal.loadDocuments.resolveLoadOrg, { loadId });
  return org ?? 'unassigned';
}

/**
 * Generate a presigned URL for uploading a file directly to S3/R2
 */
export const getUploadUrl = action({
  args: {
    filename: v.string(),
    contentType: v.string(),
    folder: v.optional(v.string()),
  },
  returns: v.object({
    uploadUrl: v.string(),
    fileUrl: v.string(),
    key: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('Not authenticated');
    }

    const { client, bucket, r2AccountId } = createS3Client();

    // Generate unique key for the file
    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const sanitizedFilename = args.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const folder = args.folder || 'uploads';
    const key = `${folder}/${timestamp}-${randomSuffix}-${sanitizedFilename}`;

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: args.contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: 300,
    });

    const fileUrl = buildFileUrl(key, r2AccountId, bucket);

    return { uploadUrl, fileUrl, key };
  },
});

/**
 * Presigned upload URL for unified load documents (driver-captured).
 *
 * Keys are grouped org-first so per-customer export/deletion is a single
 * prefix operation, then by document type so R2 lifecycle rules + ops
 * tooling can slice by kind:
 *   orgs/{workosOrgId}/loads/{loadId}/{type}/{ts}-{rand}-{filename}
 *
 * Custom metadata is baked into the presigned PUT so every R2 object
 * carries org, loadId, driverId, docType, capturedAt, and (when
 * available) GPS + accuracy. This lets ops search the bucket directly —
 * `aws s3api list-objects-v2` + the R2 dashboard filter by these without
 * needing to hit Convex. Keys use kebab-case because S3 lowercases all
 * user metadata keys and strips leading `x-amz-meta-` on read.
 *
 * The client must echo the exact same metadata headers on PUT or the
 * presigned signature fails. Callers receive `metadataHeaders` to
 * forward verbatim, and should persist the returned `key` on the Convex
 * row (externalKey) — that's what signed GETs and deletion operate on.
 *
 * This is the single presign path for every driver-captured document,
 * POD-on-checkout included (pass `stopId` there so the object metadata
 * records which stop the POD closes out).
 */
export const getLoadDocumentUploadUrl = action({
  args: {
    loadId: v.string(),
    type: v.union(
      v.literal('POD'),
      v.literal('Receipt'),
      v.literal('Cargo'),
      v.literal('Damage'),
      v.literal('Accident'),
      v.literal('Other'),
    ),
    filename: v.string(),
    contentType: v.optional(v.string()),
    // POD-on-checkout only: which stop this document closes out. Lands
    // on the R2 object as `stop-id` metadata.
    stopId: v.optional(v.string()),
    // Optional metadata embedded in the R2 object. Drivers in a dead
    // zone can omit GPS and the object still uploads — just without
    // location stamped on the binary (the Convex row still carries
    // whatever was known at queue time).
    driverId: v.optional(v.string()),
    capturedAt: v.optional(v.number()),
    capturedLat: v.optional(v.number()),
    capturedLng: v.optional(v.number()),
    gpsAccuracyM: v.optional(v.number()),
    // Accident-type only: the structured "what happened" chip (Collision
    // / Trailer damage / ...). Lands on the R2 object as `accident-kind`
    // metadata so ops can filter the bucket for a specific incident
    // type without hitting Convex. Free-text description continues to
    // live in the loadDocuments row's `note` column — metadata is only
    // for short structured values.
    accidentKind: v.optional(v.string()),
  },
  returns: v.object({
    uploadUrl: v.string(),
    fileUrl: v.string(),
    key: v.string(),
    // Metadata the client MUST send as request headers on PUT so the
    // presigned signature matches. Object: header name → value.
    metadataHeaders: v.record(v.string(), v.string()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('Not authenticated');
    }

    const { client, bucket, r2AccountId } = createS3Client();

    // Org comes from the load row, never from the client — the key's
    // org prefix is what per-customer export/deletion trusts.
    const orgSegment = await resolveOrgSegment(ctx, args.loadId);
    const key = buildDocumentKey(orgSegment, args.loadId, args.type, args.filename);

    // Build the metadata map — all values must be strings; skip empties
    // so S3 doesn't store "undefined" literals. Stick to kebab-case
    // keys to avoid server-side normalization surprises.
    const metadata: Record<string, string> = {
      'org-id': orgSegment,
      'load-id': args.loadId,
      'doc-type': args.type,
      'uploaded-via': 'driver-mobile',
    };
    if (args.stopId) metadata['stop-id'] = args.stopId;
    if (args.driverId) metadata['driver-id'] = args.driverId;
    if (args.capturedAt) metadata['captured-at'] = String(args.capturedAt);
    if (typeof args.capturedLat === 'number')
      metadata['captured-lat'] = args.capturedLat.toFixed(6);
    if (typeof args.capturedLng === 'number')
      metadata['captured-lng'] = args.capturedLng.toFixed(6);
    if (typeof args.gpsAccuracyM === 'number')
      metadata['gps-accuracy-m'] = args.gpsAccuracyM.toFixed(1);
    // accident-kind is only meaningful on Accident-typed objects; the
    // client guards that at the call site. Values are short, whitespace
    // is trimmed, and we don't enforce an enum here in case a future
    // AccidentSheet adds chips without a corresponding server deploy.
    if (args.accidentKind) {
      metadata['accident-kind'] = args.accidentKind.trim();
    }

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: args.contentType ?? 'image/jpeg',
      Metadata: metadata,
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: 300,
    });

    // Translate the metadata map into the header names the client must
    // send back on PUT. S3 requires each key to be prefixed with
    // `x-amz-meta-` when transmitted.
    const metadataHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) {
      metadataHeaders[`x-amz-meta-${k}`] = v;
    }

    const fileUrl = buildFileUrl(key, r2AccountId, bucket);

    return { uploadUrl, fileUrl, key, metadataHeaders };
  },
});

/**
 * DEPRECATED — POD presigns now go through getLoadDocumentUploadUrl with
 * type 'POD' + stopId. Kept alive only so driver-app builds still in the
 * field keep working; it produces the same org-prefixed key layout as
 * the unified path so even legacy clients stop writing to `pod-photos/`.
 * Remove once mobile adoption of the unified path is complete.
 */
export const getPODUploadUrl = action({
  args: {
    loadId: v.string(),
    stopId: v.string(),
    filename: v.string(),
    driverId: v.optional(v.string()),
    capturedAt: v.optional(v.number()),
    capturedLat: v.optional(v.number()),
    capturedLng: v.optional(v.number()),
  },
  returns: v.object({
    uploadUrl: v.string(),
    fileUrl: v.string(),
    key: v.string(),
    metadataHeaders: v.record(v.string(), v.string()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('Not authenticated');
    }

    const { client, bucket, r2AccountId } = createS3Client();

    const orgSegment = await resolveOrgSegment(ctx, args.loadId);
    const key = buildDocumentKey(orgSegment, args.loadId, 'POD', args.filename);

    const metadata: Record<string, string> = {
      'org-id': orgSegment,
      'load-id': args.loadId,
      'stop-id': args.stopId,
      'doc-type': 'POD',
      'uploaded-via': 'driver-mobile',
    };
    if (args.driverId) metadata['driver-id'] = args.driverId;
    if (args.capturedAt) metadata['captured-at'] = String(args.capturedAt);
    if (typeof args.capturedLat === 'number')
      metadata['captured-lat'] = args.capturedLat.toFixed(6);
    if (typeof args.capturedLng === 'number')
      metadata['captured-lng'] = args.capturedLng.toFixed(6);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'image/jpeg',
      Metadata: metadata,
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: 300,
    });

    const metadataHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(metadata)) {
      metadataHeaders[`x-amz-meta-${k}`] = v;
    }

    const fileUrl = buildFileUrl(key, r2AccountId, bucket);

    return { uploadUrl, fileUrl, key, metadataHeaders };
  },
});

/**
 * Short-lived signed GET URL for a load document stored in R2.
 *
 * This is the read path that lets the bucket stay private: consumers
 * (web ops UI, driver app) exchange a documentId for a URL that expires
 * in 15 minutes instead of embedding permanent public URLs. Access
 * control lives in the internal query — org members and the assigned
 * driver only.
 *
 * Works for every row shape: Convex-storage docs return the storage URL,
 * key-bearing R2 docs get a presigned GET, and legacy URL-only rows fall
 * back to a presigned GET on the key derived from the URL's pathname
 * (correct for both r2.dev and custom-domain URLs, and harmless while
 * the bucket is still public).
 */
export const getDocumentDownloadUrl = action({
  args: {
    documentId: v.id('loadDocuments'),
  },
  returns: v.object({
    url: v.union(v.string(), v.null()),
    expiresAt: v.union(v.number(), v.null()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ url: string | null; expiresAt: number | null }> => {
    // Auth + org/driver scoping happens inside the internal query, which
    // sees the same caller identity as this action. Explicit annotations
    // (here and on `doc`) break the s3Upload ↔ loadDocuments
    // generated-API type cycle.
    const doc: {
      storageId?: Id<'_storage'>;
      externalKey?: string;
      externalUrl?: string;
    } | null = await ctx.runQuery(internal.loadDocuments.getDocForAccess, {
      documentId: args.documentId,
    });
    if (!doc) {
      throw new Error('Document not found');
    }

    if (doc.storageId) {
      const url = await ctx.storage.getUrl(doc.storageId);
      // Convex storage URLs don't carry a fixed expiry we control.
      return { url, expiresAt: null };
    }

    const key =
      doc.externalKey ??
      (doc.externalUrl ? decodeURIComponent(new URL(doc.externalUrl).pathname.slice(1)) : null);
    if (!key) {
      return { url: null, expiresAt: null };
    }

    const { client, bucket } = createS3Client();
    const expiresIn = 900; // 15 minutes
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn },
    );
    return { url, expiresAt: Date.now() + expiresIn * 1000 };
  },
});

/**
 * Delete a single object from R2/S3. Internal-only — scheduled by
 * loadDocuments.remove after the Convex row is gone, so a crash between
 * the two leaves at worst an orphaned object (safe), never a dangling
 * row pointing at deleted bytes.
 *
 * DeleteObject is idempotent on S3/R2 (deleting a missing key succeeds),
 * so scheduler retries are harmless.
 */
export const deleteObject = internalAction({
  args: {
    key: v.string(),
  },
  returns: v.null(),
  handler: async (_ctx, args) => {
    const { client, bucket } = createS3Client();
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: args.key }));
    console.log('[S3Upload] Deleted object:', args.key);
    return null;
  },
});
