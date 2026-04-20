// @ts-nocheck
// TypeScript inference hits depth limits with 50+ table schema.
// Schema is validated at deploy time by Convex runtime.
import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { Id, Doc } from './_generated/dataModel';
import { requireCallerOrgId, requireCallerIdentity } from './lib/auth';

// ============================================
// DRIVER SESSIONS
// Session lifecycle: start (QR scan) → active → end (geofence/manual/auto)
// ============================================

/**
 * Start a new driver session by scanning a truck QR code.
 * Closes any existing active session for this driver first.
 * Called from mobile app after QR scan.
 */
export const startSession = mutation({
  args: {
    driverId: v.id('drivers'),
    truckId: v.id('trucks'),
  },
  returns: v.object({
    sessionId: v.id('driverSessions'),
    previousSessionClosed: v.boolean(),
    truck: v.object({
      _id: v.id('trucks'),
      unitId: v.string(),
      make: v.optional(v.string()),
      model: v.optional(v.string()),
    }),
  }),
  handler: async (ctx, args) => {
    // Validate driver exists and is not deleted
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted) {
      throw new Error('Driver not found');
    }

    // Validate truck exists, is active, and belongs to same org
    const truck = await ctx.db.get(args.truckId);
    if (!truck || truck.isDeleted) {
      throw new Error('Truck not found');
    }
    if (truck.status !== 'Active') {
      throw new Error(`Truck is currently ${truck.status.toLowerCase()}`);
    }
    if (truck.organizationId !== driver.organizationId) {
      throw new Error('Truck belongs to a different organization');
    }

    const now = Date.now();
    let previousSessionClosed = false;

    // Close any existing active session for this driver
    const activeSession = await ctx.db
      .query('driverSessions')
      .withIndex('by_driver_status', (q) =>
        q.eq('driverId', args.driverId).eq('status', 'active')
      )
      .first();

    if (activeSession) {
      // Backfill endedAt to the last GPS ping in that session
      const lastPing = await ctx.db
        .query('sessionLocations')
        .withIndex('by_session', (q) => q.eq('sessionId', activeSession._id))
        .order('desc')
        .first();

      await ctx.db.patch(activeSession._id, {
        status: 'completed',
        endedAt: lastPing?.recordedAt ?? now,
        endReason: 'next_session_opened',
      });
      previousSessionClosed = true;
    }

    // Update driver's current truck
    await ctx.db.patch(args.driverId, {
      currentTruckId: args.truckId,
      updatedAt: now,
    });

    // Create new session
    const sessionId = await ctx.db.insert('driverSessions', {
      driverId: args.driverId,
      truckId: args.truckId,
      organizationId: driver.organizationId,
      startedAt: now,
      status: 'active',
    });

    return {
      sessionId,
      previousSessionClosed,
      truck: {
        _id: truck._id,
        unitId: truck.unitId,
        make: truck.make,
        model: truck.model,
      },
    };
  },
});

/**
 * End an active driver session.
 * Called from mobile app (manual), geofence evaluator (auto), or cron (timeout).
 */
export const endSession = mutation({
  args: {
    sessionId: v.id('driverSessions'),
    endReason: v.union(
      v.literal('geofence_yard'),
      v.literal('geofence_parking'),
      v.literal('driver_manual'),
      v.literal('next_session_opened'),
      v.literal('auto_timeout')
    ),
  },
  returns: v.object({ success: v.boolean() }),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session) {
      throw new Error('Session not found');
    }
    if (session.status === 'completed') {
      return { success: true }; // Already ended, idempotent
    }

    await ctx.db.patch(args.sessionId, {
      status: 'completed',
      endedAt: Date.now(),
      endReason: args.endReason,
    });

    return { success: true };
  },
});

/**
 * Internal version of endSession for use by geofence evaluator and cron jobs.
 */
export const endSessionInternal = internalMutation({
  args: {
    sessionId: v.id('driverSessions'),
    endReason: v.union(
      v.literal('geofence_yard'),
      v.literal('geofence_parking'),
      v.literal('next_session_opened'),
      v.literal('auto_timeout')
    ),
    endedAt: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status === 'completed') return null;

    await ctx.db.patch(args.sessionId, {
      status: 'completed',
      endedAt: args.endedAt ?? Date.now(),
      endReason: args.endReason,
    });
    return null;
  },
});

/**
 * Get the active session for a driver (if any).
 * Used by mobile app to determine if session start screen should be shown.
 */
export const getActiveSession = query({
  args: {
    driverId: v.id('drivers'),
  },
  returns: v.union(
    v.object({
      _id: v.id('driverSessions'),
      truckId: v.id('trucks'),
      startedAt: v.number(),
      truckUnitId: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query('driverSessions')
      .withIndex('by_driver_status', (q) =>
        q.eq('driverId', args.driverId).eq('status', 'active')
      )
      .first();

    if (!session) return null;

    const truck = await ctx.db.get(session.truckId);

    return {
      _id: session._id,
      truckId: session.truckId,
      startedAt: session.startedAt,
      truckUnitId: truck?.unitId,
    };
  },
});

/**
 * Get session history for a driver within a date range.
 * Used by admin dashboard for session monitoring.
 */
export const getSessionHistory = query({
  args: {
    driverId: v.id('drivers'),
    since: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id('driverSessions'),
      truckId: v.id('trucks'),
      startedAt: v.number(),
      endedAt: v.optional(v.number()),
      endReason: v.optional(v.string()),
      status: v.string(),
      truckUnitId: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const sessions = await ctx.db
      .query('driverSessions')
      .withIndex('by_driver_status', (q) => q.eq('driverId', args.driverId))
      .order('desc')
      .take(args.limit ?? 20);

    const results = [];
    for (const session of sessions) {
      if (args.since && session.startedAt < args.since) continue;
      const truck = await ctx.db.get(session.truckId);
      results.push({
        _id: session._id,
        truckId: session.truckId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        endReason: session.endReason,
        status: session.status,
        truckUnitId: truck?.unitId,
      });
    }
    return results;
  },
});

/**
 * Auto-close sessions that have been active for more than 18 hours.
 * Called by daily cron job as a safety net.
 */
export const autoCloseStaleSessionsCron = internalMutation({
  args: {},
  returns: v.object({ closed: v.number() }),
  handler: async (ctx) => {
    const cutoff = Date.now() - 18 * 60 * 60 * 1000; // 18 hours ago
    let closed = 0;

    // Query all active sessions — filter by startedAt in application
    const activeSessions = await ctx.db
      .query('driverSessions')
      .filter((q) => q.eq(q.field('status'), 'active'))
      .collect();

    for (const session of activeSessions) {
      if (session.startedAt < cutoff) {
        // Backfill endedAt to last ping
        const lastPing = await ctx.db
          .query('sessionLocations')
          .withIndex('by_session', (q) => q.eq('sessionId', session._id))
          .order('desc')
          .first();

        await ctx.db.patch(session._id, {
          status: 'completed',
          endedAt: lastPing?.recordedAt ?? Date.now(),
          endReason: 'auto_timeout',
        });
        closed++;
      }
    }

    return { closed };
  },
});

/**
 * Auto-close a session if no new load was assigned within the timeout window.
 * Scheduled by checkOutFromStop after the last delivery is completed.
 */
export const autoCloseIfNoNewLoad = internalMutation({
  args: {
    sessionId: v.id('driverSessions'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.status === 'completed') return null;

    // Check if the driver has any active loads (In Transit status)
    const driver = await ctx.db.get(session.driverId);
    if (!driver) {
      // Driver deleted — close session
      await ctx.db.patch(args.sessionId, {
        status: 'completed',
        endedAt: Date.now(),
        endReason: 'auto_timeout',
      });
      return null;
    }

    // Check for any loads assigned to this driver with active tracking
    const activeLoad = await ctx.db
      .query('loadInformation')
      .withIndex('by_primary_driver_status', (q) =>
        q.eq('primaryDriverId', session.driverId).eq('trackingStatus', 'In Transit')
      )
      .first();

    if (!activeLoad) {
      // No active loads — auto-close
      const lastPing = await ctx.db
        .query('sessionLocations')
        .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
        .order('desc')
        .first();

      await ctx.db.patch(args.sessionId, {
        status: 'completed',
        endedAt: lastPing?.recordedAt ?? Date.now(),
        endReason: 'auto_timeout',
      });
    }

    return null;
  },
});
