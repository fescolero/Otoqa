import { v } from 'convex/values';
import { query, mutation, internalMutation, QueryCtx, MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import { requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { resolveAuthenticatedDriver } from './driverMobile';

/**
 * Driver Session System — Phase 1 foundation.
 *
 * A driverSession represents a driver's work shift. It's created on manual
 * "Start Shift" after a truck QR scan, and ends on manual stop, handoff,
 * dispatch override, or the auto-timeout safety-net cron.
 *
 * Session metadata is intentionally lean — no per-ping state lives here so
 * dispatcher dashboard subscriptions don't invalidate on every GPS write.
 * See convex/loadTrackingState.ts for the geofence frontier doc.
 */

const endReasonValidator = v.union(
  v.literal('driver_manual'),
  v.literal('dispatch_override'),
  v.literal('auto_timeout'),
  v.literal('next_session_opened'),
  v.literal('handoff_complete')
);

const adminEndReasonValidator = v.union(
  v.literal('emergency'),
  v.literal('unreachable_driver'),
  v.literal('phone_issues')
);

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/**
 * Find the caller's active session row, or null if none. Enforces driver auth.
 */
async function getCallerActiveSession(
  ctx: QueryCtx | MutationCtx,
  driver: Doc<'drivers'>
): Promise<Doc<'driverSessions'> | null> {
  return ctx.db
    .query('driverSessions')
    .withIndex('by_driver_status', (q) => q.eq('driverId', driver._id).eq('status', 'active'))
    .first();
}

/**
 * End a session row and end any of its driver's still-active legs. Also
 * writes an audit row for dispatcher attention when legs were still open.
 *
 * Caller is expected to have already done org/auth checks.
 */
async function endSessionInternal(
  ctx: MutationCtx,
  session: Doc<'driverSessions'>,
  args: {
    endReason: Doc<'driverSessions'>['endReason'];
    endedAt?: number;
    endedByUserId?: string;
    endedByReasonCode?: Doc<'driverSessions'>['endedByReasonCode'];
  }
): Promise<void> {
  const endedAt = args.endedAt ?? Date.now();
  const totalActiveMinutes = Math.round((endedAt - session.startedAt) / 60000);

  // Find any of the driver's currently-active legs and close them out.
  const activeLegs = await ctx.db
    .query('dispatchLegs')
    .withIndex('by_driver', (q) => q.eq('driverId', session.driverId).eq('status', 'ACTIVE'))
    .collect();

  const affectedLegIds: Id<'dispatchLegs'>[] = [];
  for (const leg of activeLegs) {
    await ctx.db.patch(leg._id, {
      status: 'COMPLETED',
      endedAt,
      endReason: 'session_ended',
      updatedAt: endedAt,
    });
    affectedLegIds.push(leg._id);
  }

  await ctx.db.patch(session._id, {
    endedAt,
    status: 'completed',
    endReason: args.endReason,
    endedByUserId: args.endedByUserId,
    endedByReasonCode: args.endedByReasonCode,
    totalActiveMinutes,
  });

  // Clear the driver's current truck pairing on session end. This forces
  // a fresh QR scan to start the next shift — the driver might be on a
  // different unit tomorrow, and we never want to silently bind a stale
  // truck to a new session. Pair this with the verify.tsx routing rule
  // that sends drivers to /switch-truck when there's no active session,
  // and the loop is closed: end shift → currentTruckId cleared → next
  // sign-in (or "Start shift" tap) routes to scanner → fresh binding.
  //
  // Note: this also disables the bootstrap-grace path in
  // getOrCreateActiveSession (it requires currentTruckId), which is the
  // correct behavior — that path is for "checked in without tapping
  // Start", not for "session ended hours ago, do it again automatically".
  await ctx.db.patch(session.driverId, {
    currentTruckId: undefined,
    updatedAt: endedAt,
  });

  if (affectedLegIds.length > 0 && args.endReason !== 'driver_manual') {
    await ctx.db.insert('sessionEndedWithActiveLoad', {
      sessionId: session._id,
      driverId: session.driverId,
      organizationId: session.organizationId,
      endedAt,
      endReason: args.endReason ?? 'unknown',
      affectedLegIds,
    });
  }
}

// ============================================================================
// PUBLIC MUTATIONS (driver-facing)
// ============================================================================

/**
 * Start a work shift. Driver scans a truck QR, confirms on the Start Shift
 * pop-up, and this mutation runs. Closes any pre-existing active session
 * for the driver (idempotent — covers the "forgot to end yesterday" case).
 */
export const startSession = mutation({
  args: {
    driverId: v.id('drivers'),
    truckId: v.id('trucks'),
  },
  returns: v.id('driverSessions'),
  handler: async (ctx, args) => {
    const driver = await resolveAuthenticatedDriver(ctx, args.driverId);

    const truck = await ctx.db.get(args.truckId);
    if (!truck || truck.isDeleted) {
      throw new Error('Truck not found');
    }
    if (truck.organizationId !== driver.organizationId) {
      throw new Error('Truck does not belong to your organization');
    }

    const now = Date.now();

    // Close any pre-existing active session. This is the "forgot to end shift"
    // path — we don't penalize the driver, we just silently close the old one.
    const existing = await getCallerActiveSession(ctx, driver);
    if (existing) {
      await endSessionInternal(ctx, existing, {
        endReason: 'next_session_opened',
        endedAt: now,
      });
    }

    const sessionId = await ctx.db.insert('driverSessions', {
      driverId: driver._id,
      truckId: args.truckId,
      organizationId: driver.organizationId,
      startedAt: now,
      status: 'active',
    });

    // Denormalize current truck on the driver for list views.
    if (driver.currentTruckId !== args.truckId) {
      await ctx.db.patch(driver._id, { currentTruckId: args.truckId, updatedAt: now });
    }

    return sessionId;
  },
});

/**
 * End the caller's active session. If they have ACTIVE legs, the legs are
 * closed with endReason=session_ended and an audit row is written.
 *
 * Mobile is expected to guard this with a confirmation dialog when active
 * legs exist ("contact dispatch for a handoff"); this mutation itself does
 * not block, so a determined user can still end their shift.
 */
export const endSession = mutation({
  args: {
    sessionId: v.id('driverSessions'),
    endReason: v.union(v.literal('driver_manual')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const driver = await resolveAuthenticatedDriver(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error('Session not found');
    if (session.driverId !== driver._id) throw new Error('Not your session');
    if (session.status !== 'active') return null; // idempotent

    await endSessionInternal(ctx, session, { endReason: args.endReason });
    return null;
  },
});

/**
 * Stamp the timestamp when the mobile UI displays a soft-cap warning to
 * the driver (10h amber, 14h red). The session doc is the canonical
 * record; the dispatcher "active sessions" dashboard surfaces these flags
 * as visual cues (Phase 6). Idempotent — only stamps if currently null.
 *
 * No push notification is sent today. When push infra exists, this is
 * the natural place to enqueue it (driver crossing 14h is the trigger).
 */
export const markSoftCapHit = mutation({
  args: {
    sessionId: v.id('driverSessions'),
    cap: v.union(v.literal('10h'), v.literal('14h')),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const driver = await resolveAuthenticatedDriver(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) return null; // session may have ended already; no-op
    if (session.driverId !== driver._id) throw new Error('Not your session');
    if (session.status !== 'active') return null;

    const now = Date.now();
    if (args.cap === '10h' && !session.softCap10hAt) {
      await ctx.db.patch(args.sessionId, { softCap10hAt: now });
    } else if (args.cap === '14h' && !session.softCap14hAt) {
      await ctx.db.patch(args.sessionId, { softCap14hAt: now });
    }
    return null;
  },
});

/**
 * Bootstrap-grace entry point: returns the caller's active session, or
 * creates one if none exists. Used by check-in flows when the driver
 * checks into a stop without having tapped "Start Shift" — we recover
 * silently so they don't get blocked.
 *
 * Requires the driver to have a currentTruckId (from a prior QR scan).
 * Returning without one forces the driver through the normal Start Shift
 * path so a truck is bound to every session.
 */
export const getOrCreateActiveSession = mutation({
  args: {
    driverId: v.id('drivers'),
  },
  returns: v.object({
    sessionId: v.id('driverSessions'),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const driver = await resolveAuthenticatedDriver(ctx, args.driverId);

    const existing = await getCallerActiveSession(ctx, driver);
    if (existing) {
      return { sessionId: existing._id, created: false };
    }

    if (!driver.currentTruckId) {
      throw new Error('Scan your truck before checking in');
    }
    const truck = await ctx.db.get(driver.currentTruckId);
    if (!truck || truck.isDeleted || truck.organizationId !== driver.organizationId) {
      throw new Error('Current truck is unavailable — rescan your truck');
    }

    const now = Date.now();
    const sessionId = await ctx.db.insert('driverSessions', {
      driverId: driver._id,
      truckId: driver.currentTruckId,
      organizationId: driver.organizationId,
      startedAt: now,
      status: 'active',
    });
    return { sessionId, created: true };
  },
});

// ============================================================================
// PUBLIC QUERIES
// ============================================================================

/**
 * Return the caller's currently-active session, or null if none.
 */
export const getActiveSession = query({
  args: {
    driverId: v.optional(v.id('drivers')),
  },
  returns: v.union(
    v.object({
      _id: v.id('driverSessions'),
      _creationTime: v.number(),
      driverId: v.id('drivers'),
      truckId: v.id('trucks'),
      organizationId: v.string(),
      startedAt: v.number(),
      status: v.union(v.literal('active'), v.literal('completed')),
      softCap10hAt: v.optional(v.number()),
      softCap14hAt: v.optional(v.number()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return null;
    }
    const session = await getCallerActiveSession(ctx, driver);
    if (!session) return null;
    return {
      _id: session._id,
      _creationTime: session._creationTime,
      driverId: session.driverId,
      truckId: session.truckId,
      organizationId: session.organizationId,
      startedAt: session.startedAt,
      status: session.status,
      softCap10hAt: session.softCap10hAt,
      softCap14hAt: session.softCap14hAt,
    };
  },
});

/**
 * Per-driver shift history for the dispatcher's driver-detail Sessions tab.
 * Returns recent sessions (active + completed) for one driver, newest first.
 * Auth: caller must be a dispatcher in the driver's org.
 */
export const listForDriver = query({
  args: {
    driverId: v.id('drivers'),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) return [];

    const limit = Math.min(args.limit ?? 50, 200);
    const sessions = await ctx.db
      .query('driverSessions')
      .withIndex('by_driver_status', (q) => q.eq('driverId', args.driverId))
      .order('desc')
      .take(limit);

    // Enrich with truck unit + leg count so the table can render without
    // a per-row follow-up query. Leg count is bounded (typically 1–5 per
    // shift) so the read amplification is small.
    return Promise.all(
      sessions.map(async (session) => {
        const truck = await ctx.db.get(session.truckId);
        // Count legs that belonged to this session via the sessionId stamp.
        // This catches legs first-worked in the session — multi-day legs
        // worked across sessions count for the session that started them.
        const legs = await ctx.db
          .query('dispatchLegs')
          .withIndex('by_driver', (q) => q.eq('driverId', session.driverId))
          .collect();
        const legCount = legs.filter((l) => l.sessionId === session._id).length;

        return {
          _id: session._id,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          status: session.status,
          endReason: session.endReason,
          endedByReasonCode: session.endedByReasonCode,
          totalActiveMinutes: session.totalActiveMinutes,
          softCap10hAt: session.softCap10hAt,
          softCap14hAt: session.softCap14hAt,
          truckUnitId: truck?.unitId ?? null,
          legCount,
        };
      })
    );
  },
});

/**
 * Dispatcher "who's on shift right now" feed. Used by the active-sessions
 * dashboard reactive lane. GPS ping writes do NOT invalidate this query —
 * it only reads driverSessions, which is written ~5 times per shift.
 */
export const listActiveForOrg = query({
  args: {},
  handler: async (ctx) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const sessions = await ctx.db
      .query('driverSessions')
      .withIndex('by_org_active', (q) =>
        q.eq('organizationId', callerOrgId).eq('status', 'active')
      )
      .collect();

    // Enrich with driver + truck names for display. The dispatcher dashboard
    // reads "last ping N min ago" via the separate getSessionFreshness query.
    return Promise.all(
      sessions.map(async (session) => {
        const [driver, truck] = await Promise.all([
          ctx.db.get(session.driverId),
          ctx.db.get(session.truckId),
        ]);
        return {
          _id: session._id,
          driverId: session.driverId,
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : null,
          truckId: session.truckId,
          truckUnitId: truck?.unitId ?? null,
          startedAt: session.startedAt,
          softCap10hAt: session.softCap10hAt,
          softCap14hAt: session.softCap14hAt,
        };
      })
    );
  },
});

/**
 * Polled query for dispatcher "last ping N min ago" freshness indicator.
 *
 * Invoked one-shot from the client (NOT via useQuery) every 60 seconds so
 * GPS ping writes don't cascade reactive invalidations across the dashboard.
 * Reads at most N index-backed rows where N = active sessions in the org.
 */
export const getSessionFreshness = query({
  args: {},
  handler: async (ctx) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const sessions = await ctx.db
      .query('driverSessions')
      .withIndex('by_org_active', (q) =>
        q.eq('organizationId', callerOrgId).eq('status', 'active')
      )
      .collect();

    const result: Record<string, number | null> = {};
    for (const session of sessions) {
      const latest = await ctx.db
        .query('driverLocations')
        .withIndex('by_session_time', (q) => q.eq('sessionId', session._id))
        .order('desc')
        .first();
      result[session._id] = latest?.recordedAt ?? null;
    }
    return result;
  },
});

// ============================================================================
// DISPATCHER MUTATIONS
// ============================================================================

/**
 * Force-end a driver's session from the dispatcher UI. Used when the driver
 * can't (lost phone, emergency, unreachable). Reason is an enum — no free text.
 */
export const adminEndSession = mutation({
  args: {
    sessionId: v.id('driverSessions'),
    reason: adminEndReasonValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const caller = await requireCallerIdentity(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session) throw new Error('Session not found');
    if (session.organizationId !== caller.orgId) {
      throw new Error('Not authorized for this session');
    }
    if (session.status !== 'active') return null; // idempotent

    await endSessionInternal(ctx, session, {
      endReason: 'dispatch_override',
      endedByUserId: caller.userId,
      endedByReasonCode: args.reason,
    });
    return null;
  },
});

// ============================================================================
// INTERNAL MUTATIONS (scheduler, other modules)
// ============================================================================

/**
 * Called by the auto-timeout cron when a session has been active for too
 * long. No auth — this runs under the scheduler's identity.
 */
export const endSessionAutoTimeout = internalMutation({
  args: {
    sessionId: v.id('driverSessions'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== 'active') return null;
    await endSessionInternal(ctx, session, { endReason: 'auto_timeout' });
    return null;
  },
});

/**
 * Daily safety-net sweep. Ends any session that's been active for more than
 * 18 hours — covers app crashes, dead phones, drivers who forgot to End
 * Shift. Soft-cap banners (10h/14h) appear in the mobile UI well before
 * this fires, so reaching the auto-timeout threshold is genuinely abnormal.
 *
 * Uses the by_status_started index for an efficient range scan: we read
 * only sessions with status='active' AND startedAt < cutoff. Schedules
 * per-session terminations via the scheduler (1000-per-mutation limit
 * is plenty for typical session volume; if we ever scale past that we'll
 * paginate this sweep).
 */
const SESSION_AUTO_TIMEOUT_MS = 18 * 60 * 60 * 1000;

export const sweepStaleSessionsForAutoTimeout = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - SESSION_AUTO_TIMEOUT_MS;
    const stale = await ctx.db
      .query('driverSessions')
      .withIndex('by_status_started', (q) =>
        q.eq('status', 'active').lt('startedAt', cutoff)
      )
      .collect();

    for (const session of stale) {
      await ctx.scheduler.runAfter(0, internal.driverSessions.endSessionAutoTimeout, {
        sessionId: session._id,
      });
    }

    if (stale.length > 0) {
      console.log(
        `[driverSessions.sweepStaleSessions] Scheduled ${stale.length} auto-timeout endings`
      );
    }
    return { scheduled: stale.length };
  },
});

/**
 * Called by dispatchLegs.handoffLoad when the from-driver has no other
 * active legs. Ends their session with handoff_complete. No auth — caller
 * (the handoff mutation) has already authorized.
 */
export const endSessionForHandoff = internalMutation({
  args: {
    sessionId: v.id('driverSessions'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status !== 'active') return null;
    await endSessionInternal(ctx, session, { endReason: 'handoff_complete' });
    return null;
  },
});
