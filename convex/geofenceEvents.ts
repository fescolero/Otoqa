import { v } from 'convex/values';
import { query } from './_generated/server';
import { requireCallerOrgId } from './lib/auth';
import { Id } from './_generated/dataModel';
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
 * Detection-vs-tap timeline per stop for one load — the same pairing the
 * load-detail stops table shows (GPS-detected arrival next to the manual
 * check-in), packaged for surfaces that don't already hold the stop rows
 * (the sessions activity panel's trip cards). Two bounded reads: stops and
 * events for the load, joined in memory.
 */
export const stopTimelineForLoad = query({
  args: { loadId: v.id('loadInformation') },
  returns: v.array(
    v.object({
      sequenceNumber: v.number(),
      checkedInAt: v.union(v.string(), v.null()),
      checkedOutAt: v.union(v.string(), v.null()),
      arrivedAt: v.union(v.number(), v.null()),
      departedAt: v.union(v.number(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const [stops, events] = await Promise.all([
      ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect(),
      ctx.db
        .query('geofenceEvents')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect(),
    ]);

    const arrived = new Map<number, number>();
    const departed = new Map<number, number>();
    for (const e of events) {
      if (e.eventType === 'ARRIVED') arrived.set(e.stopSequenceNumber, e.triggeredAt);
      if (e.eventType === 'DEPARTED') departed.set(e.stopSequenceNumber, e.triggeredAt);
    }

    return stops
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
      .map((s) => ({
        sequenceNumber: s.sequenceNumber,
        checkedInAt: s.checkedInAt ?? null,
        checkedOutAt: s.checkedOutAt ?? null,
        arrivedAt: arrived.get(s.sequenceNumber) ?? null,
        departedAt: departed.get(s.sequenceNumber) ?? null,
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
      // Stop pin — lets consumers without their own stop list (the
      // sessions map) draw the fence without a second query.
      latitude: v.number(),
      longitude: v.number(),
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
        latitude: stop.latitude,
        longitude: stop.longitude,
        arrivalRadiusMeters: fence.radiusMeters ?? INNER_RING_METERS,
        exitRadiusMeters: exitRadiusFor(fence.radiusMeters),
        overridden: fence.radiusMeters !== undefined,
        polygon: fence.polygon,
      });
    }
    return out;
  },
});

const latLngValidator = v.object({ lat: v.number(), lng: v.number() });

/**
 * The fences that are ARMED RIGHT NOW for one session — read straight from
 * the loadTrackingState watches, so the map shows exactly what the
 * evaluator is evaluating: the arrival fence advances stop by stop, and a
 * departure fence disappears the moment the exit confirms. Fences sharing
 * a location (drop of one load = pickup of the next, shuttle runs) are
 * merged into one entry with combined labels, so the map never draws
 * duplicate rings on the same spot.
 */
export const activeFencesForSession = query({
  args: { sessionId: v.id('driverSessions') },
  returns: v.array(
    v.object({
      key: v.string(),
      hasArrival: v.boolean(),
      hasDeparture: v.boolean(),
      latitude: v.number(),
      longitude: v.number(),
      arrivalRadiusMeters: v.union(v.number(), v.null()),
      exitRadiusMeters: v.number(),
      polygon: v.union(v.array(latLngValidator), v.null()),
      exitPolygon: v.union(v.array(latLngValidator), v.null()),
      labels: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== callerOrgId) return [];

    const rows = await ctx.db
      .query('loadTrackingState')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    type Fence = {
      key: string;
      hasArrival: boolean;
      hasDeparture: boolean;
      latitude: number;
      longitude: number;
      arrivalRadiusMeters: number | null;
      exitRadiusMeters: number;
      polygon: { lat: number; lng: number }[] | null;
      exitPolygon: { lat: number; lng: number }[] | null;
      labels: string[];
    };
    const byPlace = new Map<string, Fence>();
    const merge = (fence: Fence) => {
      const existing = byPlace.get(fence.key);
      if (!existing) {
        byPlace.set(fence.key, fence);
        return;
      }
      existing.hasArrival = existing.hasArrival || fence.hasArrival;
      existing.hasDeparture = existing.hasDeparture || fence.hasDeparture;
      existing.arrivalRadiusMeters = existing.arrivalRadiusMeters ?? fence.arrivalRadiusMeters;
      existing.exitRadiusMeters = Math.max(existing.exitRadiusMeters, fence.exitRadiusMeters);
      existing.polygon = existing.polygon ?? fence.polygon;
      existing.exitPolygon = existing.exitPolygon ?? fence.exitPolygon;
      for (const label of fence.labels) {
        if (!existing.labels.includes(label)) existing.labels.push(label);
      }
    };
    // ~11 m grid: fences within it are "the same place" visually.
    const placeKey = (lat: number, lng: number) => `${lat.toFixed(4)}|${lng.toFixed(4)}`;

    const loadNameCache = new Map<string, string>();
    const loadName = async (loadId: Id<'loadInformation'>) => {
      const k = loadId as string;
      if (!loadNameCache.has(k)) {
        const load = await ctx.db.get(loadId);
        loadNameCache.set(k, load ? (load.orderNumber ?? load.internalId) : 'load');
      }
      return loadNameCache.get(k)!;
    };

    for (const row of rows) {
      const name = await loadName(row.loadId);
      if (row.currentStopLat !== undefined && row.currentStopLng !== undefined) {
        const radius = row.currentStopArrivalRadiusMeters ?? INNER_RING_METERS;
        merge({
          key: placeKey(row.currentStopLat, row.currentStopLng),
          hasArrival: true,
          hasDeparture: false,
          latitude: row.currentStopLat,
          longitude: row.currentStopLng,
          arrivalRadiusMeters: radius,
          exitRadiusMeters: exitRadiusFor(row.currentStopArrivalRadiusMeters),
          polygon:
            row.currentStopPolygon && row.currentStopPolygon.length >= 3
              ? row.currentStopPolygon
              : null,
          exitPolygon: null,
          labels: [`#${name} · Stop ${row.currentStopSequenceNumber}`],
        });
      }
      const watch = row.departureWatch;
      if (watch) {
        merge({
          key: placeKey(watch.lat, watch.lng),
          hasArrival: false,
          hasDeparture: true,
          latitude: watch.lat,
          longitude: watch.lng,
          arrivalRadiusMeters: null,
          exitRadiusMeters: watch.exitRadiusMeters ?? exitRadiusFor(undefined),
          polygon: null,
          exitPolygon:
            watch.exitPolygon && watch.exitPolygon.length >= 3 ? watch.exitPolygon : null,
          labels: [`#${name} · Stop ${watch.stopSequenceNumber} exit`],
        });
      }
    }

    return [...byPlace.values()];
  },
});
