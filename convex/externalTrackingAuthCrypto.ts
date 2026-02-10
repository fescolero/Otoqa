'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import crypto from 'crypto';

// ============================================
// EXTERNAL TRACKING API - NODE.JS CRYPTO OPERATIONS
// "use node" required for crypto.randomBytes, createHash, createHmac, AES
// ============================================

// ============================================
// API KEY GENERATION
// ============================================

/**
 * Generate a new API key with crypto-safe randomness.
 * Returns the raw key (shown once) and the hash (stored).
 */
export const generateApiKey = internalAction({
  args: {
    environment: v.union(v.literal('sandbox'), v.literal('production')),
  },
  returns: v.object({
    rawKey: v.string(),
    keyPrefix: v.string(),
    keyHash: v.string(),
  }),
  handler: async (_ctx, args) => {
    const prefix = args.environment === 'sandbox' ? 'otq_test_' : 'otq_live_';
    const randomBytes = crypto.randomBytes(32);
    const randomPart = randomBytes.toString('base64url'); // 43 chars
    const rawKey = `${prefix}${randomPart}`;
    const keyPrefix = rawKey.substring(0, 12);
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    return { rawKey, keyPrefix, keyHash };
  },
});

// ============================================
// WEBHOOK SECRET ENCRYPTION / DECRYPTION
// ============================================

function getEncryptionKey(): Buffer {
  const keyHex = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length < 64) {
    throw new Error(
      'WEBHOOK_ENCRYPTION_KEY environment variable must be set (64-char hex string = 32 bytes)'
    );
  }
  return Buffer.from(keyHex, 'hex');
}

/**
 * Generate a webhook signing secret and return both raw + encrypted.
 */
export const generateWebhookSecret = internalAction({
  args: {},
  returns: v.object({
    rawSecret: v.string(),
    encryptedSecret: v.string(),
  }),
  handler: async () => {
    const rawSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(rawSecret, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    // Format: iv:authTag:ciphertext
    const encryptedSecret = `${iv.toString('hex')}:${authTag}:${encrypted}`;
    return { rawSecret, encryptedSecret };
  },
});

/**
 * Decrypt a webhook signing secret.
 */
function decryptWebhookSecret(encryptedSecret: string): string {
  const key = getEncryptionKey();
  const [ivHex, authTagHex, ciphertext] = encryptedSecret.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Sign a webhook payload: HMAC-SHA256(secret, timestamp.body)
 */
export const signWebhookPayload = internalAction({
  args: {
    encryptedSecret: v.string(),
    timestamp: v.string(),
    body: v.string(),
  },
  returns: v.string(), // "t=<timestamp>,v1=<hex_signature>"
  handler: async (_ctx, args) => {
    const secret = decryptWebhookSecret(args.encryptedSecret);
    const signedPayload = `${args.timestamp}.${args.body}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(signedPayload)
      .digest('hex');
    return `t=${args.timestamp},v1=${signature}`;
  },
});
