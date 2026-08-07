import { v } from 'convex/values';
import { query } from './_generated/server';
import { requireCallerOrgId } from './lib/auth';
import { facilityFence } from './loadTrackingState';
import { INNER_RING_METERS, exitRadiusFor } from './lib/geo';

/**
 * Read API over the geofenceEvents log (written by geofenceEvaluator and
 * the backfill tool — see those files for the event semantics).
 */

/**
 * All geofence events for one load, oldest first. Powers the map layer in
 * LiveRouteMap: each event carries the exact GPS fix that triggered it, so
 * pins land where the truck actually was when the ring fired.
 *
 * Bounded: ≤3 events per stop via the by_load index. Auth mirrors
 * driverLocations.getRouteHistoryForLoad — org mismatch returns [] rather
 * than throwing.
 */
export const listForLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  returns: v.array(
    v.object({
      _id: v.id('geofenceEvents'),
      eventType: v.union(v.literal('APPROACHING'), v.literal('ARRIVED'), v.literal('DEPARTED')),
      stopSequenceNumber: v.number(),
      triggeredAt: v.number(),
      latitude: v.number(),
      longitude: v.number(),
      distanceMeters: v.number(),
      accuracy: v.union(v.number(), v.null()),
      backfilled: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const events = await ctx.db
      .query('geofenceEvents')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    return events.map((e) => ({
      _id: e._id,
      eventType: e.eventType,
      stopSequenceNumber: e.stopSequenceNumber,
      triggeredAt: e.triggeredAt,
      latitude: e.latitude,
      longitude: e.longitude,
      distanceMeters: e.distanceMeters,
      accuracy: e.accuracy ?? null,
      backfilled: e.backfilled ?? false,
    }));
  },
});

/**
 * Effective geofence ring radii per stop for one load, honoring the linked
 * facility's radiusMeters override (the same value manual check-in
 * enforcement uses). The map draws the real boundaries from this instead of
 * assuming the global defaults. Bounded: one facility read per stop.
 */
export const ringsForLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  returns: v.array(
    v.object({
      stopId: v.id('loadStops'),
      sequenceNumber: v.number(),
      arrivalRadiusMeters: v.number(),
      exitRadiusMeters: v.number(),
      overridden: v.boolean(),
      // Learned facility polygon — when present the map draws the fence's
      // real shape instead of the arrival circle.
      polygon: v.optional(v.array(v.object({ lat: v.number(), lng: v.number() }))),
    }),
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const out = [];
    for (const stop of stops) {
      if (stop.latitude === undefined || stop.longitude === undefined) continue;
      const fence = await facilityFence(ctx, stop);
      out.push({
        stopId: stop._id,
        sequenceNumber: stop.sequenceNumber,
        arrivalRadiusMeters: fence.radiusMeters ?? INNER_RING_METERS,
        exitRadiusMeters: exitRadiusFor(fence.radiusMeters),
        overridden: fence.radiusMeters !== undefined,
        polygon: fence.polygon,
      });
    }
    return out;
  },
});
