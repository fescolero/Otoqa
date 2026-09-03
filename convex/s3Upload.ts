'use node';

import { ConvexError, v } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { keyFromExternalUrl } from './lib/r2';
import type { Id } from './_generated/dataModel';

// ============================================
// S3/R2 UPLOAD ACTION
// Generate presigned URLs for direct mobile uploads
// Supports both AWS S3 and Cloudflare R2
// ============================================
//
// Bucket layout (see docs/documents-storage-spec.md §1 for the contract):
//
//   orgs/{workosOrgId}/loads/{loadId}/{docType}/{ts}-{rand}-{filename}
//   orgs/{workosOrgId}/drivers/{driverId}/{typeKey}/{docId}-{filename}
//   orgs/{workosOrgId}/carriers/{partnershipId}/{typeKey}/{docId}-{filename}
//   orgs/{workosOrgId}/company/{typeKey}/{docId}-{filename}
//
// The org segment comes from the owning row server-side (never from the
// client), so a per-customer export or deletion is a single prefix
// operation. Legacy prefixes `pod-photos/` and `load-documents/` are
// read-only history — no new objects land there.
//
// This file owns the S3 client and the load-document actions the mobile
// app calls. Entity documents (drivers today; carriers/organizations in
// phase 2) get thin per-entity action files that import the low-level
// helpers exported below — one contract, no generic presign action.

// Exported for the presign regression test (s3Upload.presign.test.ts) —
// the SDK's checksum defaults broke every R2 upload once; the test pins
// the presigned-URL shape so a dependency bump can't silently do it again.
export function createS3Client() {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION || 'auto';
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  const r2AccountId = process.env.R2_ACCOUNT_ID; // For Cloudflare R2

  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new ConvexError('S3/R2 configuration not found. Please set S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY environment variables.');
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
      // CRITICAL for R2 + AWS SDK >= 3.729: the SDK's flexible-checksums
      // default (WHEN_SUPPORTED) bakes an `x-amz-checksum-crc32` of the
      // EMPTY body into every presigned PUT (the presigner never sees
      // the file), so R2 rejects every real upload with a checksum
      // mismatch. WHEN_REQUIRED disables the implicit checksum — this
      // is Cloudflare's documented R2 compatibility setting.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
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
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_') || 'photo.jpg';
  const loadSegment = loadId || 'unknown';
  return `orgs/${orgSegment}/loads/${loadSegment}/${docType}/${timestamp}-${randomSuffix}-${sanitizedFilename}`;
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

// ─── Low-level helpers shared by every document action ──────────────────
// Kept here (the only 'use node' module that owns the client) so the R2
// quirks — checksum defaults, signed metadata headers — are fixed once.

export const PRESIGNED_PUT_TTL_SECONDS = 300;
export const PRESIGNED_GET_TTL_SECONDS = 900;

/**
 * Presign a PUT whose `x-amz-meta-*` headers are SIGNED (not hoisted to
 * the query string). The client must echo `metadataToHeaders(metadata)`
 * verbatim on PUT or R2 answers 403. See s3Upload.presign.test.ts.
 */
export async function presignPutWithMetadata(args: {
  key: string;
  contentType: string;
  metadata: Record<string, string>;
}): Promise<string> {
  const { client, bucket } = createS3Client();
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: args.key,
    ContentType: args.contentType,
    Metadata: args.metadata,
  });
  const unhoistableHeaders = new Set(Object.keys(args.metadata).map((k) => `x-amz-meta-${k}`));
  return getSignedUrl(client, command, {
    expiresIn: PRESIGNED_PUT_TTL_SECONDS,
    unhoistableHeaders,
  });
}

/**
 * Presign a GET. Pass `downloadAs` to force `Content-Disposition:
 * attachment` so a file is saved rather than rendered (spec §1 "Reads").
 */
export async function presignGet(args: {
  key: string;
  downloadAs?: string;
}): Promise<{ url: string; expiresAt: number }> {
  const { client, bucket } = createS3Client();
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: args.key,
    ...(args.downloadAs
      ? { ResponseContentDisposition: `attachment; filename="${args.downloadAs.replace(/"/g, '')}"` }
      : {}),
  });
  const url = await getSignedUrl(client, command, { expiresIn: PRESIGNED_GET_TTL_SECONDS });
  return { url, expiresAt: Date.now() + PRESIGNED_GET_TTL_SECONDS * 1000 };
}

/** HEAD an object. Returns null when it does not exist. */
export async function headObject(
  key: string,
): Promise<{ contentLength: number; contentType: string | undefined } | null> {
  const { client, bucket } = createS3Client();
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return { contentLength: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (name === 'NotFound' || name === 'NoSuchKey' || status === 404) return null;
    throw err;
  }
}

/** Delete an object; idempotent on S3/R2. */
export async function deleteObjectByKey(key: string): Promise<void> {
  const { client, bucket } = createS3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

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
      throw new ConvexError('Not authenticated');
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

    // Keep the x-amz-meta-* headers in the SIGNED headers instead of
    // letting the presigner hoist them into the query string. The mobile
    // client echoes them as request headers on PUT (metadataHeaders
    // below) — if they're hoisted, the echoed headers are unsigned
    // x-amz-* headers, which S3/R2 rejects. Signing them restores the
    // original contract: client must send them verbatim or gets a 403.
    const unhoistableHeaders = new Set(
      Object.keys(metadata).map((k) => `x-amz-meta-${k}`),
    );

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: 300,
      unhoistableHeaders,
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
      throw new ConvexError('Document not found');
    }

    if (doc.storageId) {
      const url = await ctx.storage.getUrl(doc.storageId);
      // Convex storage URLs don't carry a fixed expiry we control.
      return { url, expiresAt: null };
    }

    const key =
      doc.externalKey ?? (doc.externalUrl ? keyFromExternalUrl(doc.externalUrl) : null);
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
    await deleteObjectByKey(args.key);
    console.log('[S3Upload] Deleted object:', args.key);
    return null;
  },
});
