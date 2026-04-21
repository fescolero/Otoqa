'use node';

import { v } from 'convex/values';
import { action } from './_generated/server';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ============================================
// S3/R2 UPLOAD ACTION
// Generate presigned URLs for direct mobile uploads
// Supports both AWS S3 and Cloudflare R2
// ============================================

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
    const cloudflareDomain = process.env.CLOUDFLARE_DOMAIN;

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

    // Construct the final file URL
    let fileUrl: string;
    if (cloudflareDomain) {
      fileUrl = `https://${cloudflareDomain}/${key}`;
    } else if (r2AccountId) {
      // R2 public URL (if bucket is public)
      fileUrl = `https://pub-${r2AccountId}.r2.dev/${key}`;
    } else {
      fileUrl = `https://${bucket}.s3.amazonaws.com/${key}`;
    }

    return { uploadUrl, fileUrl, key };
  },
});

/**
 * Presigned upload URL for unified load documents (driver-captured).
 *
 * Keys are grouped by document type so R2 lifecycle rules + ops tooling
 * can slice by kind:
 *   load-documents/{loadId}/{type}/{ts}-{filename}
 *
 * Custom metadata is baked into the presigned PUT so every R2 object
 * carries loadId, driverId, docType, capturedAt, and (when available)
 * GPS + accuracy. This lets ops search the bucket directly — `aws s3api
 * list-objects-v2` + the R2 dashboard filter by these without needing
 * to hit Convex. Keys use kebab-case because S3 lowercases all user
 * metadata keys and strips leading `x-amz-meta-` on read.
 *
 * Returns the same shape as getPODUploadUrl so mobile's S3 uploader
 * (lib/s3-upload.ts) can reuse the PUT flow — the client must echo
 * the exact same metadata headers on PUT or the presigned signature
 * fails. Callers receive `metadataHeaders` to forward verbatim.
 *
 * The driver app should call this instead of getPODUploadUrl for any
 * document the driver is capturing — POD included. getPODUploadUrl is
 * kept alive for the dual-write transition and will be removed once the
 * Load Details UI fully cuts over to uploadLoadDocument.
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
    const cloudflareDomain = process.env.CLOUDFLARE_DOMAIN;

    const timestamp = Date.now();
    const sanitizedFilename = args.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `load-documents/${args.loadId}/${args.type}/${timestamp}-${sanitizedFilename}`;

    // Build the metadata map — all values must be strings; skip empties
    // so S3 doesn't store "undefined" literals. Stick to kebab-case
    // keys to avoid server-side normalization surprises.
    const metadata: Record<string, string> = {
      'load-id': args.loadId,
      'doc-type': args.type,
      'uploaded-via': 'driver-mobile',
    };
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

    let fileUrl: string;
    if (cloudflareDomain) {
      fileUrl = `https://${cloudflareDomain}/${key}`;
    } else if (r2AccountId) {
      fileUrl = `https://pub-${r2AccountId}.r2.dev/${key}`;
    } else {
      fileUrl = `https://${bucket}.s3.amazonaws.com/${key}`;
    }

    return { uploadUrl, fileUrl, key, metadataHeaders };
  },
});

/**
 * Get a presigned URL specifically for POD (Proof of Delivery) photos.
 *
 * Same metadata pattern as getLoadDocumentUploadUrl — loadId, stopId,
 * driverId, capturedAt, GPS are baked into the PUT so POD-on-checkout
 * objects in the pod-photos/ prefix are searchable from R2 directly.
 * GPS is trusted here (check-out already captured it in
 * checkOutFromStop args); caller forwards from useCheckIn.
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
    const cloudflareDomain = process.env.CLOUDFLARE_DOMAIN;

    // Generate unique key for POD photo
    const timestamp = Date.now();
    const sanitizedFilename = args.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `pod-photos/${args.loadId}/${args.stopId}/${timestamp}-${sanitizedFilename}`;

    // #region agent log
    console.log('[DEBUG-ec49a3] getPODUploadUrl called:', JSON.stringify({ loadId: args.loadId, stopId: args.stopId, filename: args.filename }));
    // #endregion

    const metadata: Record<string, string> = {
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

    // Presigned URL generated — not logging to avoid credential exposure

    // Construct the final file URL
    let fileUrl: string;
    if (cloudflareDomain) {
      fileUrl = `https://${cloudflareDomain}/${key}`;
    } else if (r2AccountId) {
      fileUrl = `https://pub-${r2AccountId}.r2.dev/${key}`;
    } else {
      fileUrl = `https://${bucket}.s3.amazonaws.com/${key}`;
    }

    return { uploadUrl, fileUrl, key, metadataHeaders };
  },
});
