import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { calculateDistanceMeters, OUTER_RING_METERS, INNER_RING_METERS } from './lib/geo';

/**
 * Geofence Evaluator — Phase 2.
 *
 * Runs after each GPS batch insert (scheduled by driverLocations) when the
 * driver has an ACTIVE leg. Reads the per-load tracking state, computes
 * distance to the current frontier stop, and fires APPROACHING (outer ring)
 * or ARRIVED (inner ring) events exactly once per (load, stop, event).
 *
 * Why frontier state lives in loadTrackingState (not the session doc):
 *   Session docs are read by dispatcher dashboards and mobile home. Writing
 *   to them on every ping would cascade reactive-query invalidations.
 *   loadTrackingState is narrow-read (evaluator + per-load detail only), so
 *   ping-rate writes don't touch subscribed queries.
 *
 * Why only the latest ping: earlier pings in a batch are historical. They'd
 * just waste reads — the frontier flags make subsequent checks a no-op anyway.
 */
export const evaluateLatestPing = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    ping: v.object({
      latitude: v.float64(),
      longitude: v.float64(),
      recordedAt: v.float64(),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const state = await ctx.db
      .query('loadTrackingState')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .first();

    // No state = driver hasn't checked into any stop yet. Pre-check-in pings
    // are valid telemetry (they go to driverLocations) but don't fire events.
    if (!state) return null;

    const distance = calculateDistanceMeters(
      args.ping.latitude,
      args.ping.longitude,
      state.currentStopLat,
      state.currentStopLng
    );

    const now = Date.now();
    let approachingFired = state.approachingFired;
    let arrivedFired = state.arrivedFired;

    // APPROACHING: 5-mile outer ring. Fires once per stop.
    if (distance < OUTER_RING_METERS && !approachingFired) {
      await ctx.db.insert('geofenceEvents', {
        sessionId: state.sessionId,
        loadId: state.loadId,
        stopSequenceNumber: state.currentStopSequenceNumber,
        driverId: state.driverId,
        organizationId: state.organizationId,
        eventType: 'APPROACHING',
        triggeredAt: args.ping.recordedAt,
        latitude: args.ping.latitude,
        longitude: args.ping.longitude,
        distanceMeters: distance,
      });
      approachingFired = true;
    }

    // ARRIVED: 0.5-mile inner ring. Fires once per stop.
    if (distance < INNER_RING_METERS && !arrivedFired) {
      await ctx.db.insert('geofenceEvents', {
        sessionId: state.sessionId,
        loadId: state.loadId,
        stopSequenceNumber: state.currentStopSequenceNumber,
        driverId: state.driverId,
        organizationId: state.organizationId,
        eventType: 'ARRIVED',
        triggeredAt: args.ping.recordedAt,
        latitude: args.ping.latitude,
        longitude: args.ping.longitude,
        distanceMeters: distance,
      });
      arrivedFired = true;
    }

    // Only patch if a flag actually flipped. This keeps loadTrackingState
    // writes rare — at most two per stop per session.
    if (approachingFired !== state.approachingFired || arrivedFired !== state.arrivedFired) {
      await ctx.db.patch(state._id, {
        approachingFired,
        arrivedFired,
        updatedAt: now,
      });
    }

    return null;
  },
});
