import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';

/**
 * Universal audit logging utility for tracking all actions across the project
 * Supports multi-tenant isolation via WorkOS organization IDs
 */

// Helper function to create an audit log entry (internal use only)
export const logAction = internalMutation({
  args: {
    // Required fields
    organizationId: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    action: v.string(),
    performedBy: v.string(),

    // Optional fields
    entityName: v.optional(v.string()),
    description: v.optional(v.string()),
    performedByName: v.optional(v.string()),
    performedByEmail: v.optional(v.string()),
    changesBefore: v.optional(v.string()),
    changesAfter: v.optional(v.string()),
    changedFields: v.optional(v.array(v.string())),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert('auditLog', {
      ...args,
      timestamp: Date.now(),
    });
  },
});

// Get audit logs for a specific entity
export const getEntityAuditLog = query({
  args: {
    entityType: v.string(),
    entityId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 50;

    const logs = await ctx.db
      .query('auditLog')
      .withIndex('by_entity', (q) => q.eq('entityType', args.entityType).eq('entityId', args.entityId))
      .order('desc')
      .take(limit);

    return logs;
  },
});

// Get audit logs for an organization
export const getOrganizationAuditLog = query({
  args: {
    organizationId: v.string(),
    limit: v.optional(v.number()),
    entityType: v.optional(v.string()),
    action: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 100;

    // Filter by entity type if provided
    if (args.entityType !== undefined) {
      const logs = await ctx.db
        .query('auditLog')
        .withIndex('by_entity_type', (q) => q.eq('organizationId', args.organizationId).eq('entityType', args.entityType!))
        .order('desc')
        .take(limit);
      return logs;
    }

    // Filter by action if provided
    if (args.action !== undefined) {
      const logs = await ctx.db
        .query('auditLog')
        .withIndex('by_action', (q) => q.eq('organizationId', args.organizationId).eq('action', args.action!))
        .order('desc')
        .take(limit);
      return logs;
    }

    // Get all logs for organization
    const logs = await ctx.db
      .query('auditLog')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .order('desc')
      .take(limit);

    return logs;
  },
});

// Get audit logs for a specific user
export const getUserAuditLog = query({
  args: {
    organizationId: v.string(),
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 50;

    const logs = await ctx.db
      .query('auditLog')
      .withIndex('by_user', (q) => q.eq('organizationId', args.organizationId).eq('performedBy', args.userId))
      .order('desc')
      .take(limit);

    return logs;
  },
});

// Get recent activity summary
export const getRecentActivity = query({
  args: {
    organizationId: v.string(),
    hours: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const hoursAgo = args.hours || 24;
    const cutoffTime = Date.now() - hoursAgo * 60 * 60 * 1000;

    const logs = await ctx.db
      .query('auditLog')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .order('desc')
      .filter((q) => q.gte(q.field('timestamp'), cutoffTime))
      .take(100);

    return logs;
  },
});
