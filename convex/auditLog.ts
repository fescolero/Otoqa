import { v } from 'convex/values';
import { query } from './_generated/server';
import { requireCallerOrgId } from './lib/auth';
import { queryByOrg } from './_helpers/queryByOrg';
import { auditEntityTypeValidator, auditActionValidator } from './lib/audit';

/**
 * Universal audit log read API.
 * Supports multi-tenant isolation via WorkOS organization IDs.
 *
 * Writes go through `logAudit` in `lib/audit.ts` (a plain helper that inserts
 * inside the calling mutation's transaction — no extra function invocation).
 *
 * All read queries derive the caller's org from the authenticated identity
 * via `requireCallerOrgId` — clients cannot supply an `organizationId` arg.
 */

// Get audit logs for a specific entity (scoped to caller's org)
export const getEntityAuditLog = query({
  args: {
    entityType: auditEntityTypeValidator,
    entityId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const limit = args.limit || 50;

    return await ctx.db
      .query('auditLog')
      .withIndex('by_org_entity', (q) =>
        q.eq('organizationId', callerOrgId).eq('entityType', args.entityType).eq('entityId', args.entityId),
      )
      .order('desc')
      .take(limit);
  },
});

// Get audit logs for the caller's organization
export const getOrganizationAuditLog = query({
  args: {
    limit: v.optional(v.number()),
    entityType: v.optional(auditEntityTypeValidator),
    action: v.optional(auditActionValidator),
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

    // Range on the index key (organizationId, timestamp) — a post-hoc
    // .filter() here would scan the org's entire history when fewer than
    // 100 rows fall inside the window.
    const logs = await ctx.db
      .query('auditLog')
      .withIndex('by_organization', (q) => q.eq('organizationId', callerOrgId).gte('timestamp', cutoffTime))
      .order('desc')
      .take(100);

    return logs;
  },
});
