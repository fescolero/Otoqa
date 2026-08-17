import { v } from 'convex/values';
import { internalMutation, query, MutationCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { requireCallerOrgId } from './lib/auth';
import {
  calculateDistanceMeters,
  exitRadiusFor,
  GEOFENCE_MAX_ACCURACY_METERS,
  YARD_DEFAULT_RADIUS_METERS,
} from './lib/geo';

/**
 * Session-level yard geofence — the shift-scoped counterpart of the load
 * evaluator. Every GPS batch's latest ping per session is checked against
 * the org's yard/parking fences (yardLocations); crossing in fires ARRIVED,
 * crossing out fires DEPARTED, appended to sessionGeofenceEvents. Powers
 * "left the yard 6:02 AM / back 5:41 PM" on the Active Sessions map.
 *
 * Detection is deliberately stateless (no per-session watch rows): the
 * last event per (session, yard) IS the state, and events must alternate —
 * an ARRIVED can only follow a DEPARTED (or nothing), and vice versa.
 * Flap resistance comes from hysteresis alone (exit ring = 1.5× entry
 * ring): with a ≥50 m minimum radius the gap is ≥25 m, wider than the
 * accuracy gate lets jitter reach. Unlike load departures there's no
 * two-ping debounce — yard events feed shift narratives, not detention
 * math, and one honest boundary crossing per sync cycle is the right
 * granularity.
 *
 * Guards shared with the load evaluator: only the newest ping per batch is
 * evaluated; accuracy worse than GEOFENCE_MAX_ACCURACY_METERS is ignored;
 * a ping not newer than the last recorded event for the pair is ignored
 * (offline backlogs can't rewrite history).
 */

export async function evaluateYards(
  ctx: MutationCtx,
  args: {
    sessionId: Id<'driverSessions'>;
    driverId: Id<'drivers'>;
    organizationId: string;
    ping: { latitude: number; longitude: number; recordedAt: number; accuracy?: number };
  }
): Promise<null> {
  const { ping } = args;
  if (ping.accuracy !== undefined && ping.accuracy > GEOFENCE_MAX_ACCURACY_METERS) return null;

  const yards = await ctx.db
    .query('yardLocations')
    .withIndex('by_org', (q) => q.eq('workosOrgId', args.organizationId).eq('isDeleted', false))
    .take(100);

  for (const yard of yards) {
    const entryRadius =
      yard.radiusMeters && yard.radiusMeters > 0 ? yard.radiusMeters : YARD_DEFAULT_RADIUS_METERS;
    const exitRadius = exitRadiusFor(entryRadius);
    const distance = calculateDistanceMeters(
      ping.latitude,
      ping.longitude,
      yard.latitude,
      yard.longitude
    );

    // Between the rings (hysteresis band): no state change possible.
    const inside = distance < entryRadius;
    const outside = distance > exitRadius;
    if (!inside && !outside) continue;

    const last = await ctx.db
      .query('sessionGeofenceEvents')
      .withIndex('by_session_yard', (q) =>
        q.eq('sessionId', args.sessionId).eq('yardId', yard._id)
      )
      .order('desc')
      .first();
    if (last && ping.recordedAt <= last.triggeredAt) continue;

    const eventType = inside
      ? last === null || last.eventType === 'DEPARTED'
        ? 'ARRIVED'
        : undefined
      : last?.eventType === 'ARRIVED'
        ? 'DEPARTED'
        : undefined;
    if (!eventType) continue;

    await ctx.db.insert('sessionGeofenceEvents', {
      sessionId: args.sessionId,
      driverId: args.driverId,
      organizationId: args.organizationId,
      yardId: yard._id,
      eventType,
      triggeredAt: ping.recordedAt,
      latitude: ping.latitude,
      longitude: ping.longitude,
      distanceMeters: distance,
      accuracy: ping.accuracy,
    });
  }

  return null;
}

export const evaluateSessionYards = internalMutation({
  args: {
    sessionId: v.id('driverSessions'),
    driverId: v.id('drivers'),
    organizationId: v.string(),
    ping: v.object({
      latitude: v.float64(),
      longitude: v.float64(),
      recordedAt: v.float64(),
      accuracy: v.optional(v.float64()),
    }),
  },
  returns: v.null(),
  handler: (ctx, args) => evaluateYards(ctx, args),
});

/**
 * Yard triggers for one session, oldest first, joined with yard names for
 * display. Powers the session-level geofence pins on the Active Sessions
 * map (shown when no trip is focused).
 */
export const listForSession = query({
  args: { sessionId: v.id('driverSessions') },
  returns: v.array(
    v.object({
      _id: v.id('sessionGeofenceEvents'),
      eventType: v.union(v.literal('ARRIVED'), v.literal('DEPARTED')),
      triggeredAt: v.number(),
      latitude: v.number(),
      longitude: v.number(),
      distanceMeters: v.number(),
      accuracy: v.union(v.number(), v.null()),
      yardId: v.id('yardLocations'),
      yardName: v.string(),
      yardType: v.union(v.literal('YARD'), v.literal('PARKING')),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== callerOrgId) return [];

    const events = await ctx.db
      .query('sessionGeofenceEvents')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    const yardCache = new Map<string, Doc<'yardLocations'> | null>();
    const out = [];
    for (const e of events) {
      const key = e.yardId as string;
      if (!yardCache.has(key)) yardCache.set(key, await ctx.db.get(e.yardId));
      const yard = yardCache.get(key);
      out.push({
        _id: e._id,
        eventType: e.eventType,
        triggeredAt: e.triggeredAt,
        latitude: e.latitude,
        longitude: e.longitude,
        distanceMeters: e.distanceMeters,
        accuracy: e.accuracy ?? null,
        yardId: e.yardId,
        yardName: yard?.name ?? 'Unknown yard',
        yardType: yard?.locationType ?? 'YARD',
      });
    }
    return out;
  },
});
