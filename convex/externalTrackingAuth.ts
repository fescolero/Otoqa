import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { RateLimiter, MINUTE } from '@convex-dev/rate-limiter';
import { components } from './_generated/api';

// ============================================
// EXTERNAL TRACKING API - AUTH HELPERS
// Queries and mutations (V8 runtime, no Node.js)
// ============================================

// ============================================
// RATE LIMITER (token bucket per partner key)
// ============================================
//
// Token bucket with sharding so high-tier keys (1000/min) don't pile up on a
// single document under OCC. Capacity = 2s burst (rate / 30) — partners doing
// catch-up polls after a brief outage shouldn't get hammered.
const rateLimiter = new RateLimiter(components.rateLimiter, {
  partnerApiLow: {
    kind: 'token bucket',
    rate: 60,
    period: MINUTE,
    capacity: 60,
    shards: 2,
  },
  partnerApiMedium: {
    kind: 'token bucket',
    rate: 300,
    period: MINUTE,
    capacity: 60,
    shards: 4,
  },
  partnerApiHigh: {
    kind: 'token bucket',
    rate: 1000,
    period: MINUTE,
    capacity: 100,
    shards: 10,
  },
});

function rateLimitNameForTier(
  tier: 'low' | 'medium' | 'high' | 'custom',
): 'partnerApiLow' | 'partnerApiMedium' | 'partnerApiHigh' {
  // 'custom' routes to 'high' for V1. If a partner needs a different ceiling,
  // size their tier to low/medium/high or introduce a new named limit.
  if (tier === 'low') return 'partnerApiLow';
  if (tier === 'medium') return 'partnerApiMedium';
  return 'partnerApiHigh';
}

/**
 * Consume one token from the partner's rate limit. Called from the
 * httpAction auth middleware. Token-bucket state lives in the component,
 * so this is O(1) instead of the previous O(N) audit-log scan.
 */
export const consumeRateLimit = internalMutation({
  args: {
    keyId: v.id('partnerApiKeys'),
    tier: v.union(
      v.literal('low'),
      v.literal('medium'),
      v.literal('high'),
      v.literal('custom'),
    ),
  },
  returns: v.object({
    ok: v.boolean(),
    retryAfter: v.number(),
    limit: v.number(),
  }),
  handler: async (ctx, args) => {
    const limitName = rateLimitNameForTier(args.tier);
    const result = await rateLimiter.limit(ctx, limitName, { key: args.keyId });
    const limit =
      limitName === 'partnerApiLow' ? 60 : limitName === 'partnerApiMedium' ? 300 : 1000;
    return {
      ok: result.ok,
      retryAfter: result.retryAfter ?? 0,
      limit,
    };
  },
});

// ============================================
// API KEY VALIDATION (called from httpAction)
// ============================================

/**
 * Validate an API key by its hash.
 * Returns the key record if valid, null if not.
 * httpAction hashes the key with Web Crypto, then calls this query.
 */
export const validateKeyByHash = internalQuery({
  args: { keyHash: v.string(), nowMs: v.number() },
  returns: v.union(
    v.object({
      keyId: v.id('partnerApiKeys'),
      workosOrgId: v.string(),
      partnerName: v.string(),
      permissions: v.array(v.string()),
      allowedLoadSources: v.optional(v.array(v.string())),
      ipAllowlist: v.optional(v.array(v.string())),
      rateLimitTier: v.union(v.literal('low'), v.literal('medium'), v.literal('high'), v.literal('custom')),
      customRateLimit: v.optional(v.number()),
      environment: v.union(v.literal('sandbox'), v.literal('production')),
      status: v.string(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query('partnerApiKeys')
      .withIndex('by_key_hash', (q) => q.eq('keyHash', args.keyHash))
      .unique();

    if (!key) return null;
    if (key.status !== 'ACTIVE') return null;
    if (key.expiresAt && key.expiresAt < args.nowMs) return null;

    return {
      keyId: key._id,
      workosOrgId: key.workosOrgId,
      partnerName: key.partnerName,
      permissions: key.permissions,
      allowedLoadSources: key.allowedLoadSources,
      ipAllowlist: key.ipAllowlist,
      rateLimitTier: key.rateLimitTier,
      customRateLimit: key.customRateLimit,
      environment: key.environment,
      status: key.status,
    };
  },
});

/**
 * Debounced lastUsedAt update (at most once per minute).
 */
export const touchKeyLastUsed = internalMutation({
  args: { keyId: v.id('partnerApiKeys') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const key = await ctx.db.get(args.keyId);
    if (!key) return null;

    const now = Date.now();
    // Only update if more than 60 seconds since last update
    if (!key.lastUsedAt || now - key.lastUsedAt > 60_000) {
      await ctx.db.patch(args.keyId, { lastUsedAt: now });
    }
    return null;
  },
});

// ============================================
// AUDIT LOGGING
// ============================================

export const writeAuditLog = internalMutation({
  args: {
    workosOrgId: v.string(),
    partnerKeyId: v.id('partnerApiKeys'),
    requestId: v.string(),
    endpoint: v.string(),
    method: v.string(),
    statusCode: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    responseTimeMs: v.optional(v.number()),
    rateLimitRemaining: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('apiAuditLog', {
      workosOrgId: args.workosOrgId,
      partnerKeyId: args.partnerKeyId,
      requestId: args.requestId,
      endpoint: args.endpoint,
      method: args.method,
      statusCode: args.statusCode,
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
      responseTimeMs: args.responseTimeMs,
      rateLimitRemaining: args.rateLimitRemaining,
      timestamp: Date.now(),
    });
    return null;
  },
});


// ============================================
// AUDIT LOG PRUNING (30-day retention)
// ============================================

export const pruneAuditLogs = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    let deleted = 0;
    const batchSize = 500;

    const oldLogs = await ctx.db
      .query('apiAuditLog')
      .order('asc')
      .take(batchSize);

    for (const log of oldLogs) {
      if (log.timestamp < cutoff) {
        await ctx.db.delete(log._id);
        deleted++;
      } else {
        break;
      }
    }

    return { deleted };
  },
});

// ============================================
// WEBHOOK DELIVERY QUEUE CLEANUP
// ============================================

export const pruneWebhookDeliveryQueue = internalMutation({
  args: {},
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx) => {
    const deliveredCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000; // 7 days
    const deadLetterCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
    let deleted = 0;
    const batchSize = 500;

    // Clean old DELIVERED items
    const deliveredItems = await ctx.db
      .query('webhookDeliveryQueue')
      .withIndex('by_status_next', (q) => q.eq('status', 'DELIVERED'))
      .take(batchSize);

    for (const item of deliveredItems) {
      if (item.createdAt < deliveredCutoff) {
        await ctx.db.delete(item._id);
        deleted++;
      }
    }

    // Clean old DEAD_LETTER items
    const deadLetterItems = await ctx.db
      .query('webhookDeliveryQueue')
      .withIndex('by_status_next', (q) => q.eq('status', 'DEAD_LETTER'))
      .take(batchSize);

    for (const item of deadLetterItems) {
      if (item.createdAt < deadLetterCutoff) {
        await ctx.db.delete(item._id);
        deleted++;
      }
    }

    return { deleted };
  },
});
