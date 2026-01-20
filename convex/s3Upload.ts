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

  console.log('[S3Upload] Creating client with:', {
    bucket,
    region,
    endpoint: endpoint || 'AWS default',
    hasCredentials: !!accessKeyId && !!secretAccessKey,
  });

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
 * Get a presigned URL specifically for POD (Proof of Delivery) photos
 */
export const getPODUploadUrl = action({
  args: {
    loadId: v.string(),
    stopId: v.string(),
    filename: v.string(),
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

    // Generate unique key for POD photo
    const timestamp = Date.now();
    const sanitizedFilename = args.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const key = `pod-photos/${args.loadId}/${args.stopId}/${timestamp}-${sanitizedFilename}`;

    console.log('[S3Upload] Generating presigned URL for key:', key);

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ContentType: 'image/jpeg',
    });

    const uploadUrl = await getSignedUrl(client, command, {
      expiresIn: 300,
    });

    console.log('[S3Upload] Generated presigned URL (first 100 chars):', uploadUrl.substring(0, 100));

    // Construct the final file URL
    let fileUrl: string;
    if (cloudflareDomain) {
      fileUrl = `https://${cloudflareDomain}/${key}`;
    } else if (r2AccountId) {
      fileUrl = `https://pub-${r2AccountId}.r2.dev/${key}`;
    } else {
      fileUrl = `https://${bucket}.s3.amazonaws.com/${key}`;
    }

    return { uploadUrl, fileUrl, key };
  },
});
