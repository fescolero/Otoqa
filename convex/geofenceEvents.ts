import { v } from 'convex/values';
import { query } from './_generated/server';
import { requireCallerOrgId } from './lib/auth';

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
