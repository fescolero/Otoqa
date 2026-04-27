import { v } from 'convex/values';
import { query, internalMutation } from './_generated/server';
import { requireCallerOrgId } from './lib/auth';
import { queryByOrg } from './_helpers/queryByOrg';

/**
 * Universal audit logging utility for tracking all actions across the project
 * Supports multi-tenant isolation via WorkOS organization IDs.
 *
 * All read queries derive the caller's org from the authenticated identity
 * via `requireCallerOrgId` — clients cannot supply an `organizationId` arg.
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

// Get audit logs for a specific entity (scoped to caller's org)
export const getEntityAuditLog = query({
  args: {
    entityType: v.string(),
    entityId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const limit = args.limit || 50;

    // by_entity index is not org-scoped, so filter results to the caller's org.
    // Over-fetch a small buffer to reduce the chance of returning fewer rows
    // than requested after the org filter.
    const raw = await ctx.db
      .query('auditLog')
      .withIndex('by_entity', (q) => q.eq('entityType', args.entityType).eq('entityId', args.entityId))
      .order('desc')
      .take(limit * 4);

    return raw.filter((log) => log.organizationId === callerOrgId).slice(0, limit);
  },
});

// Get audit logs for the caller's organization
export const getOrganizationAuditLog = query({
  args: {
    limit: v.optional(v.number()),
    entityType: v.optional(v.string()),
    action: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const limit = args.limit || 100;

    // Filter by entity type if provided
    if (args.entityType !== undefined) {
      const logs = await ctx.db
        .query('auditLog')
        .withIndex('by_entity_type', (q) => q.eq('organizationId', callerOrgId).eq('entityType', args.entityType!))
        .order('desc')
        .take(limit);
      return logs;
    }

    // Filter by action if provided
    if (args.action !== undefined) {
      const logs = await ctx.db
        .query('auditLog')
        .withIndex('by_action', (q) => q.eq('organizationId', callerOrgId).eq('action', args.action!))
        .order('desc')
        .take(limit);
      return logs;
    }

    // Get all logs for organization
    const logs = await queryByOrg(ctx, 'auditLog', callerOrgId)
      .order('desc')
      .take(limit);

    return logs;
  },
});

// Get audit logs for a specific user within the caller's org
export const getUserAuditLog = query({
  args: {
    userId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const limit = args.limit || 50;

    const logs = await ctx.db
      .query('auditLog')
      .withIndex('by_user', (q) => q.eq('organizationId', callerOrgId).eq('performedBy', args.userId))
      .order('desc')
      .take(limit);

    return logs;
  },
});

// Get recent activity summary for the caller's org
export const getRecentActivity = query({
  args: {
    hours: v.optional(v.number()),
    nowMs: v.number(),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const hoursAgo = args.hours || 24;
    const cutoffTime = args.nowMs - hoursAgo * 60 * 60 * 1000;

    const logs = await queryByOrg(ctx, 'auditLog', callerOrgId)
      .order('desc')
      .filter((q) => q.gte(q.field('timestamp'), cutoffTime))
      .take(100);

    return logs;
  },
});
