import { v } from 'convex/values';
import { action, mutation, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';

// ============================================
// PARTNER API KEY MANAGEMENT
// CRUD operations for API keys (UI-facing)
// ============================================

/**
 * Create a new partner API key.
 * Uses action (not mutation) because it calls the crypto node action.
 * Returns the raw key (shown once only) and the key ID.
 */
export const createKey = action({
  args: {
    workosOrgId: v.string(),
    partnerName: v.string(),
    permissions: v.array(v.string()),
    rateLimitTier: v.union(v.literal('low'), v.literal('medium'), v.literal('high'), v.literal('custom')),
    customRateLimit: v.optional(v.number()),
    environment: v.union(v.literal('sandbox'), v.literal('production')),
    allowedLoadSources: v.optional(v.array(v.string())),
    ipAllowlist: v.optional(v.array(v.string())),
    expiresAt: v.optional(v.number()),
  },
  returns: v.object({
    keyId: v.id('partnerApiKeys'),
    rawKey: v.string(),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    // Generate key via node action
    const keyGenResult: { rawKey: string; keyPrefix: string; keyHash: string } =
      await ctx.runAction(
        internal.externalTrackingAuthCrypto.generateApiKey,
        { environment: args.environment }
      );
    const { rawKey, keyPrefix, keyHash } = keyGenResult;

    // Save to database via internal mutation
    const keyId: Id<'partnerApiKeys'> = await ctx.runMutation(
      internal.externalTrackingPartnerKeys.insertKey,
      {
        workosOrgId: args.workosOrgId,
        partnerName: args.partnerName,
        keyPrefix,
        keyHash,
        permissions: args.permissions,
        allowedLoadSources: args.allowedLoadSources,
        ipAllowlist: args.ipAllowlist,
        rateLimitTier: args.rateLimitTier,
        customRateLimit: args.customRateLimit,
        environment: args.environment,
        expiresAt: args.expiresAt,
        createdBy: identity.subject,
      }
    );

    return { keyId, rawKey };
  },
});

/**
 * Internal mutation to insert a partner API key (called from action).
 */
export const insertKey = internalMutation({
  args: {
    workosOrgId: v.string(),
    partnerName: v.string(),
    keyPrefix: v.string(),
    keyHash: v.string(),
    permissions: v.array(v.string()),
    allowedLoadSources: v.optional(v.array(v.string())),
    ipAllowlist: v.optional(v.array(v.string())),
    rateLimitTier: v.union(v.literal('low'), v.literal('medium'), v.literal('high'), v.literal('custom')),
    customRateLimit: v.optional(v.number()),
    environment: v.union(v.literal('sandbox'), v.literal('production')),
    expiresAt: v.optional(v.number()),
    createdBy: v.string(),
  },
  returns: v.id('partnerApiKeys'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('partnerApiKeys', {
      workosOrgId: args.workosOrgId,
      partnerName: args.partnerName,
      keyPrefix: args.keyPrefix,
      keyHash: args.keyHash,
      permissions: args.permissions,
      allowedLoadSources: args.allowedLoadSources,
      ipAllowlist: args.ipAllowlist,
      rateLimitTier: args.rateLimitTier,
      customRateLimit: args.customRateLimit,
      environment: args.environment,
      status: 'ACTIVE',
      expiresAt: args.expiresAt,
      createdBy: args.createdBy,
      createdAt: Date.now(),
    });
  },
});

/**
 * List API keys for the current org (masked).
 */
export const listKeys = query({
  args: { workosOrgId: v.string() },
  returns: v.array(v.object({
    _id: v.id('partnerApiKeys'),
    partnerName: v.string(),
    keyPrefix: v.string(),
    permissions: v.array(v.string()),
    rateLimitTier: v.string(),
    environment: v.string(),
    status: v.string(),
    lastUsedAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
  })),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const keys = await ctx.db
      .query('partnerApiKeys')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    return keys.map((k) => ({
      _id: k._id,
      partnerName: k.partnerName,
      keyPrefix: k.keyPrefix,
      permissions: k.permissions,
      rateLimitTier: k.rateLimitTier,
      environment: k.environment,
      status: k.status,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
    }));
  },
});

/**
 * Revoke an API key.
 */
export const revokeKey = mutation({
  args: {
    workosOrgId: v.string(),
    keyId: v.id('partnerApiKeys'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const key = await ctx.db.get(args.keyId);
    if (!key) throw new Error('Key not found');
    if (key.workosOrgId !== args.workosOrgId) throw new Error('Unauthorized');

    await ctx.db.patch(args.keyId, {
      status: 'REVOKED',
      revokedAt: Date.now(),
      revokedBy: identity.subject,
    });

    // Also disable any webhook subscriptions using this key
    const subscriptions = await ctx.db
      .query('webhookSubscriptions')
      .withIndex('by_partner_key', (q) => q.eq('partnerKeyId', args.keyId))
      .collect();

    for (const sub of subscriptions) {
      if (sub.status !== 'DISABLED') {
        await ctx.db.patch(sub._id, { status: 'DISABLED', updatedAt: Date.now() });
      }
    }

    return null;
  },
});

/**
 * Get audit logs for the current org.
 */
export const getAuditLogs = query({
  args: {
    workosOrgId: v.string(),
    limit: v.optional(v.number()),
    partnerKeyId: v.optional(v.id('partnerApiKeys')),
  },
  returns: v.array(v.object({
    _id: v.id('apiAuditLog'),
    requestId: v.string(),
    endpoint: v.string(),
    method: v.string(),
    statusCode: v.number(),
    ipAddress: v.optional(v.string()),
    responseTimeMs: v.optional(v.number()),
    timestamp: v.number(),
    partnerKeyId: v.id('partnerApiKeys'),
  })),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const maxLimit = Math.min(args.limit ?? 50, 200);

    let logs;
    if (args.partnerKeyId) {
      logs = await ctx.db
        .query('apiAuditLog')
        .withIndex('by_key_time', (q) => q.eq('partnerKeyId', args.partnerKeyId!))
        .order('desc')
        .take(maxLimit);
    } else {
      logs = await ctx.db
        .query('apiAuditLog')
        .withIndex('by_org_time', (q) => q.eq('workosOrgId', args.workosOrgId))
        .order('desc')
        .take(maxLimit);
    }

    return logs.map((l) => ({
      _id: l._id,
      requestId: l.requestId,
      endpoint: l.endpoint,
      method: l.method,
      statusCode: l.statusCode,
      ipAddress: l.ipAddress,
      responseTimeMs: l.responseTimeMs,
      timestamp: l.timestamp,
      partnerKeyId: l.partnerKeyId,
    }));
  },
});
