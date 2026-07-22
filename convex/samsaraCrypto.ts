'use node';

import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import crypto from 'crypto';

// ============================================
// SAMSARA API TOKEN ENCRYPTION
// Same AES-256-GCM pattern as externalTrackingAuthCrypto.ts, sharing the
// WEBHOOK_ENCRYPTION_KEY env var so we don't fan out key management.
// Ciphertext format: "iv:authTag:ciphertext" (hex segments).
// ============================================

function getEncryptionKey(): Buffer {
  const keyHex = process.env.WEBHOOK_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length < 64) {
    throw new Error(
      'WEBHOOK_ENCRYPTION_KEY environment variable must be set (64-char hex string = 32 bytes)',
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export const encryptSamsaraToken = internalAction({
  args: { rawToken: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(args.rawToken, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  },
});

export const decryptSamsaraToken = internalAction({
  args: { encryptedToken: v.string() },
  returns: v.string(),
  handler: async (_ctx, args) => {
    const key = getEncryptionKey();
    const [ivHex, authTagHex, ciphertext] = args.encryptedToken.split(':');
    if (!ivHex || !authTagHex || !ciphertext) {
      throw new Error('Malformed encrypted Samsara token (expected iv:authTag:ciphertext)');
    }
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  },
});
