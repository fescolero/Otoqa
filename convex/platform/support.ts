import { v, ConvexError } from 'convex/values';
import { query, mutation, action, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { requirePlatformStaff, requireRecentStaffAuth } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';
import { endSessionInternal } from '../driverSessions';
import { GLOBAL_FLAG_SCOPE } from '../featureFlags';

/**
 * Platform console — support operations (Phase 2). Staff-only, and every
 * write lands in platformAuditLog. Destructive actions additionally
 * require step-up (recent sign-in — requireRecentStaffAuth) and a reason.
 *
 * The namespace contract from platform/access.ts applies: tenant helpers
 * are never used here, and cross-org authority exists only behind the
 * staff gate.
 */

// ─── Sessions ────────────────────────────────────────────────────────────

export const listActiveSessions = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const sessions = await ctx.db
      .query('driverSessions')
      .withIndex('by_org_active', (q) =>
        q.eq('organizationId', args.workosOrgId).eq('status', 'active'),
      )
      .take(100);
    return await Promise.all(
      sessions.map(async (s) => {
        const driver = await ctx.db.get(s.driverId);
        return {
          _id: s._id,
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : 'unknown',
          startedAt: s.startedAt,
          lastPingAt: s.lastPingAt ?? null,
        };
      }),
    );
  },
});

export const forceEndSession = mutation({
  args: {
    sessionId: v.id('driverSessions'),
    reasonCode: v.union(
      v.literal('emergency'),
      v.literal('unreachable_driver'),
      v.literal('phone_issues'),
    ),
    reason: v.string(), // free-text, required for the audit trail
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new ConvexError('Session not found');
    if (session.status !== 'active') return null; // idempotent

    await endSessionInternal(ctx, session, {
      endReason: 'dispatch_override',
      endedByUserId: `platform:${staff.email}`,
      endedByReasonCode: args.reasonCode,
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'session_force_ended',
      targetOrgId: session.organizationId,
      targetTable: 'driverSessions',
      targetId: args.sessionId,
      reason: args.reason,
      metadata: JSON.stringify({ reasonCode: args.reasonCode }),
    });
    return null;
  },
});

export const listUnackedSessionEndAlerts = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const rows = await ctx.db
      .query('sessionEndedWithActiveLoad')
      .withIndex('by_org_unacked', (q) =>
        q.eq('organizationId', args.workosOrgId).eq('acknowledgedAt', undefined),
      )
      .take(50);
    return await Promise.all(
      rows.map(async (r) => {
        const driver = await ctx.db.get(r.driverId);
        return {
          _id: r._id,
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : 'unknown',
          endedAt: r.endedAt,
          endReason: r.endReason,
          affectedLegs: r.affectedLegIds.length,
        };
      }),
    );
  },
});

export const ackSessionEndAlert = mutation({
  args: { id: v.id('sessionEndedWithActiveLoad') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    const row = await ctx.db.get(args.id);
    if (!row) throw new ConvexError('Not found');
    if (row.acknowledgedAt !== undefined) return null; // idempotent
    await ctx.db.patch(args.id, {
      acknowledgedAt: Date.now(),
      acknowledgedBy: `platform:${staff.email}`,
    });
    return null;
  },
});

// ─── Feature flags ───────────────────────────────────────────────────────

async function upsertFlag(
  ctx: Parameters<typeof logPlatformAudit>[0],
  scope: string,
  key: string,
  value: string | null,
  updatedBy: string,
): Promise<{ before: string | null }> {
  const existing = await ctx.db
    .query('featureFlags')
    .withIndex('by_org_key', (q) => q.eq('workosOrgId', scope).eq('key', key))
    .first();
  const before = existing?.value ?? null;
  if (value === null) {
    if (existing) await ctx.db.delete(existing._id);
  } else if (existing) {
    await ctx.db.patch(existing._id, { value, updatedAt: Date.now(), updatedBy });
  } else {
    await ctx.db.insert('featureFlags', {
      workosOrgId: scope,
      key,
      value,
      updatedAt: Date.now(),
      updatedBy,
    });
  }
  return { before };
}

export const setOrgFlag = mutation({
  args: {
    workosOrgId: v.string(),
    key: v.string(),
    // null deletes the override (falls back to global/default)
    value: v.union(v.string(), v.null()),
    reason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requirePlatformStaff(ctx);
    if (args.workosOrgId === GLOBAL_FLAG_SCOPE) {
      throw new ConvexError('Use setGlobalFlag for the global scope');
    }
    const { before } = await upsertFlag(
      ctx,
      args.workosOrgId,
      args.key,
      args.value,
      `platform:${staff.email}`,
    );
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'flag_set_org',
      targetOrgId: args.workosOrgId,
      targetTable: 'featureFlags',
      targetId: args.key,
      before: JSON.stringify(before),
      after: JSON.stringify(args.value),
      reason: args.reason,
    });
    return null;
  },
});

export const setGlobalFlag = mutation({
  args: {
    key: v.string(),
    value: v.union(v.string(), v.null()),
    reason: v.string(), // required — global flags hit every org
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const { before } = await upsertFlag(
      ctx,
      GLOBAL_FLAG_SCOPE,
      args.key,
      args.value,
      `platform:${staff.email}`,
    );
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'flag_set_global',
      targetTable: 'featureFlags',
      targetId: args.key,
      before: JSON.stringify(before),
      after: JSON.stringify(args.value),
      reason: args.reason,
    });
    return null;
  },
});

export const listGlobalFlags = query({
  args: {},
  handler: async (ctx) => {
    await requirePlatformStaff(ctx);
    return await ctx.db
      .query('featureFlags')
      .withIndex('by_org', (q) => q.eq('workosOrgId', GLOBAL_FLAG_SCOPE))
      .collect();
  },
});

// ─── Identity links ──────────────────────────────────────────────────────

export const updateIdentityLinkPhone = mutation({
  args: {
    linkId: v.id('userIdentityLinks'),
    phone: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const link = await ctx.db.get(args.linkId);
    if (!link) throw new ConvexError('Identity link not found');
    await ctx.db.patch(args.linkId, { phone: args.phone, updatedAt: Date.now() });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'identity_link_updated',
      targetTable: 'userIdentityLinks',
      targetId: args.linkId,
      before: JSON.stringify({ phone: link.phone }),
      after: JSON.stringify({ phone: args.phone }),
      reason: args.reason,
    });
    return null;
  },
});

export const deleteIdentityLink = mutation({
  args: { linkId: v.id('userIdentityLinks'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const link = await ctx.db.get(args.linkId);
    if (!link) throw new ConvexError('Identity link not found');
    await ctx.db.delete(args.linkId);
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'identity_link_updated',
      targetTable: 'userIdentityLinks',
      targetId: args.linkId,
      before: JSON.stringify({
        clerkUserId: link.clerkUserId,
        phone: link.phone,
        role: link.role,
      }),
      after: JSON.stringify(null),
      reason: args.reason,
    });
    return null;
  },
});

// ─── Clerk resync ────────────────────────────────────────────────────────

export const listDriversForOrg = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .take(100);
    return drivers.map((d) => ({
      _id: d._id,
      name: `${d.firstName} ${d.lastName}`,
      phone: d.phone,
      employmentStatus: d.employmentStatus,
      clerkUserId: d.clerkUserId ?? null,
      clerkSyncStatus: d.clerkSyncStatus ?? null,
    }));
  },
});

export const resyncDriverClerk = action({
  args: { driverId: v.id('drivers'), reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const result: { success: boolean; clerkUserId?: string; error?: string } =
      await ctx.runAction(internal.clerkSync.syncSingleDriverToClerk, {
        driverId: args.driverId,
      });
    await ctx.runMutation(internal.platform.support.recordActionAudit, {
      actorEmail: staff.email,
      action: 'clerk_resync_triggered',
      targetTable: 'drivers',
      targetId: args.driverId,
      reason: args.reason,
      metadata: JSON.stringify(result),
    });
    return result;
  },
});

/** Audit writer for platform ACTIONS (actions can't write the DB directly). */
export const recordActionAudit = internalMutation({
  args: {
    actorEmail: v.string(),
    action: v.union(v.literal('clerk_resync_triggered')),
    targetTable: v.optional(v.string()),
    targetId: v.optional(v.string()),
    reason: v.optional(v.string()),
    metadata: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await logPlatformAudit(ctx, args);
    return null;
  },
});

// ─── Organization lifecycle ──────────────────────────────────────────────

export const softDeleteOrg = mutation({
  args: { organizationId: v.id('organizations'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError('Organization not found');
    if (org.isDeleted) return null; // idempotent
    await ctx.db.patch(args.organizationId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: `platform:${staff.email}`,
      deletionReason: args.reason,
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'org_soft_deleted',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      before: JSON.stringify({ isDeleted: false }),
      after: JSON.stringify({ isDeleted: true }),
      reason: args.reason,
    });
    return null;
  },
});

export const restoreOrg = mutation({
  args: { organizationId: v.id('organizations'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError('Organization not found');
    if (!org.isDeleted) return null; // idempotent
    await ctx.db.patch(args.organizationId, {
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      deletionReason: undefined,
      updatedAt: Date.now(),
    });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'org_restored',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      before: JSON.stringify({ isDeleted: true }),
      after: JSON.stringify({ isDeleted: false }),
      reason: args.reason,
    });
    return null;
  },
});
