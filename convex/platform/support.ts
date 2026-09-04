import { v, ConvexError } from 'convex/values';
import { query, mutation, action, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { requirePlatformStaff, requireRecentStaffAuth } from '../lib/auth';
import { logPlatformAudit } from '../lib/platformAudit';
import { endSessionInternal } from '../driverSessions';
import { GLOBAL_FLAG_SCOPE } from '../featureFlags';
import { logAudit } from '../lib/audit';
import { OFFBOARDING_RETENTION_MS, partnershipSharesDocuments, partnershipsLinkedToOrg } from '../lib/orgLookup';
import { recomputeLinkedPartnerships } from '../entityDocuments';

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

/**
 * Correct a driver's phone number on the DRIVER row.
 *
 * `updateIdentityLinkPhone` fixes the Clerk↔org link; this fixes the record
 * the driver app actually authenticates against, which is the other half of
 * the most common driver-side support case ("my login doesn't find me"). Both
 * exist because they can genuinely disagree.
 */
export const correctDriverPhone = mutation({
  args: { driverId: v.id('drivers'), phone: v.string(), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver) throw new ConvexError('Driver not found');

    const phone = args.phone.trim();
    // Digits-only length check: the repo normalizes at match time, so store
    // what was typed but refuse something that can't be a phone number.
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      throw new ConvexError('Phone number must have between 10 and 15 digits');
    }
    if (phone === driver.phone) return null; // idempotent

    await ctx.db.patch(args.driverId, { phone, updatedAt: Date.now() });
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'driver_phone_corrected',
      targetOrgId: driver.organizationId,
      targetTable: 'drivers',
      targetId: args.driverId,
      before: JSON.stringify({ phone: driver.phone }),
      after: JSON.stringify({ phone }),
      reason: args.reason,
    });
    return null;
  },
});

// ─── Webhook delivery queue ──────────────────────────────────────────────

export const listDeadLetters = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requirePlatformStaff(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query('webhookDeliveryQueue')
      .withIndex('by_status_next', (q) => q.eq('status', 'DEAD_LETTER'))
      .take(limit);
    return rows.map((r) => ({
      _id: r._id,
      workosOrgId: r.workosOrgId,
      eventType: r.eventType,
      attempts: r.attempts,
      lastHttpStatus: r.lastHttpStatus ?? null,
      lastErrorMessage: r.lastErrorMessage ?? null,
      createdAt: r.createdAt,
    }));
  },
});

/**
 * Put dead-lettered deliveries back on the queue.
 *
 * The dead-letter alert has existed since Phase 2 with no way to act on it —
 * the only remedy was a CLI edit. Requeue resets the attempt counter and
 * schedules immediate redelivery; the partner's own idempotency key
 * (`deliveryId`) makes a duplicate safe on their side.
 *
 * Deliveries whose subscription is gone are skipped rather than resurrected,
 * and the count of both is returned so the operator sees what actually moved.
 */
export const requeueDeadLetters = mutation({
  args: {
    deliveryIds: v.optional(v.array(v.id('webhookDeliveryQueue'))),
    workosOrgId: v.optional(v.string()), // bulk: everything dead for one org
    reason: v.string(),
  },
  returns: v.object({ requeued: v.number(), skipped: v.number() }),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    if (!args.reason.trim()) throw new ConvexError('A reason is required');

    const BULK_CAP = 200;
    const candidates =
      args.deliveryIds !== undefined
        ? (await Promise.all(args.deliveryIds.slice(0, BULK_CAP).map((id) => ctx.db.get(id))))
            .filter((d): d is NonNullable<typeof d> => d !== null)
        : (
            await ctx.db
              .query('webhookDeliveryQueue')
              .withIndex('by_status_next', (q) => q.eq('status', 'DEAD_LETTER'))
              .take(BULK_CAP)
          ).filter((d) => args.workosOrgId === undefined || d.workosOrgId === args.workosOrgId);

    const now = Date.now();
    let requeued = 0;
    let skipped = 0;
    for (const delivery of candidates) {
      if (delivery.status !== 'DEAD_LETTER') {
        skipped++; // already moving — requeue is idempotent
        continue;
      }
      const subscription = await ctx.db.get(delivery.subscriptionId);
      if (!subscription) {
        skipped++; // the endpoint is gone; redelivery would fail forever
        continue;
      }
      await ctx.db.patch(delivery._id, {
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: now,
        lastErrorMessage: undefined,
      });
      requeued++;
    }

    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'webhook_deliveries_requeued',
      targetOrgId: args.workosOrgId,
      targetTable: 'webhookDeliveryQueue',
      reason: args.reason,
      metadata: JSON.stringify({ requeued, skipped }),
    });
    return { requeued, skipped };
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
    // A deleted carrier shares nothing — linked brokers' summaries change.
    await recomputeLinkedPartnerships(ctx, org._id as string);
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
    // Sharing resumes — linked brokers' summaries change back.
    await recomputeLinkedPartnerships(ctx, org._id as string);
    return null;
  },
});

// ─── Offboarding (documents-storage-spec.md §7) ──────────────────────────

/**
 * Start the 14-day offboarding window. Data stays intact; the purge job
 * deletes the org's R2 prefix and document rows at `purgeAt`. Every
 * broker linked to this carrier gets an Activity entry on the
 * partnership and a Save-a-copy window on shared documents.
 */
export const startOffboarding = mutation({
  args: { organizationId: v.id('organizations'), reason: v.string() },
  returns: v.object({ purgeAt: v.number(), notifiedPartnerships: v.number() }),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError('Organization not found');
    if (org.purgedAt) throw new ConvexError('Organization was already purged');
    const now = Date.now();
    // Idempotent: already offboarding → nothing to change and nobody to
    // re-notify (repeat calls must not spam partnership activity).
    if (org.offboardingStartedAt && org.purgeAt) {
      return { purgeAt: org.purgeAt, notifiedPartnerships: 0 };
    }
    const purgeAt = now + OFFBOARDING_RETENTION_MS;
    await ctx.db.patch(args.organizationId, {
      offboardingStartedAt: now,
      offboardingReason: args.reason,
      purgeAt,
      updatedAt: now,
    });
    // Notify linked brokers through their partnership's activity trail —
    // only links that carry shared documents (a terminated or unaccepted
    // link has nothing to save).
    let notified = 0;
    for (const p of (await partnershipsLinkedToOrg(ctx, org)).filter(partnershipSharesDocuments)) {
      await logAudit(ctx, {
        organizationId: p.brokerOrgId,
        entityType: 'carrierPartnership',
        entityId: p._id,
        entityName: p.carrierName || p.mcNumber,
        action: 'status_changed',
        performedBy: `platform:${staff.email}`,
        description: `${org.name} is leaving Otoqa. Documents they share are available until ${new Date(purgeAt).toISOString().slice(0, 10)} — save copies from the Documents tab to keep them.`,
        changesAfter: JSON.stringify({ offboarding: true, purgeAt }),
      });
      notified++;
    }
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'org_offboarding_started',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      after: JSON.stringify({ offboardingStartedAt: now, purgeAt }),
      reason: args.reason,
      metadata: JSON.stringify({ notifiedPartnerships: notified }),
    });
    return { purgeAt, notifiedPartnerships: notified };
  },
});

/** Cancel offboarding before the purge runs (the customer came back). */
export const cancelOffboarding = mutation({
  args: { organizationId: v.id('organizations'), reason: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const staff = await requireRecentStaffAuth(ctx);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new ConvexError('Organization not found');
    if (org.purgedAt) throw new ConvexError('Organization was already purged — nothing to cancel');
    if (!org.offboardingStartedAt) return null; // idempotent
    // The purge is committed the moment the retention window ends: the
    // daily job deletes the bucket prefix first, and a cancel landing
    // after that would keep rows whose bytes are gone (spec §7).
    if (org.purgeAt !== undefined && org.purgeAt <= Date.now()) {
      throw new ConvexError('The 14-day retention window has ended and the purge is committed — offboarding can no longer be cancelled');
    }
    await ctx.db.patch(args.organizationId, {
      offboardingStartedAt: undefined,
      offboardingReason: undefined,
      purgeAt: undefined,
      updatedAt: Date.now(),
    });
    for (const p of (await partnershipsLinkedToOrg(ctx, org)).filter(partnershipSharesDocuments)) {
      await logAudit(ctx, {
        organizationId: p.brokerOrgId,
        entityType: 'carrierPartnership',
        entityId: p._id,
        entityName: p.carrierName || p.mcNumber,
        action: 'status_changed',
        performedBy: `platform:${staff.email}`,
        description: `${org.name} is staying on Otoqa — offboarding cancelled; shared documents remain available.`,
        changesAfter: JSON.stringify({ offboarding: false }),
      });
    }
    await logPlatformAudit(ctx, {
      actorEmail: staff.email,
      action: 'org_offboarding_cancelled',
      targetOrgId: org.workosOrgId,
      targetTable: 'organizations',
      targetId: args.organizationId,
      before: JSON.stringify({ offboardingStartedAt: org.offboardingStartedAt, purgeAt: org.purgeAt }),
      reason: args.reason,
    });
    return null;
  },
});
