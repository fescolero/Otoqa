import { v } from 'convex/values';
import { internalMutation, MutationCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import {
  calculateDistanceMeters,
  OUTER_RING_METERS,
  INNER_RING_METERS,
  DEPARTURE_RING_METERS,
  GEOFENCE_MAX_ACCURACY_METERS,
} from './lib/geo';

/**
 * Geofence Evaluator — Phases 2–3.
 *
 * Runs after each GPS batch insert (scheduled by driverLocations). Reads the
 * per-load tracking state and evaluates its two watches:
 *
 *   Arrival watch (currentStop*): distance to the next unarrived stop fires
 *   APPROACHING (outer ring, ~5 mi) and ARRIVED (inner ring, ~0.5 mi)
 *   exactly once per (load, stop, event), gated by the *Fired flags.
 *
 *   Departure watch (departureWatch): the most recently checked-in stop is
 *   watched for a confirmed exit. A ping beyond DEPARTURE_RING_METERS
 *   (~0.75 mi — deliberately wider than the arrival ring for hysteresis)
 *   marks a candidate; the next, strictly newer outside ping confirms and
 *   fires DEPARTED with the *candidate's* timestamp, so the debounce doesn't
 *   shave minutes off dwell/detention clocks. A newer ping back inside the
 *   ring resets the candidate. Two guards keep offline backlogs honest:
 *   pings recorded at/before the watch's armedAt (the check-in time) are
 *   historical en-route fixes and are ignored entirely, and a stale inside
 *   ping older than the current candidate cannot reset it. Low-accuracy
 *   pings (> GEOFENCE_MAX_ACCURACY_METERS) are ignored for departure
 *   decisions. Timestamp granularity is the mobile sync cadence: only the
 *   latest ping per batch is evaluated, so the recorded exit time is the
 *   first post-exit *synced* fix, not the physical boundary crossing.
 *
 * Events are deduped against by_load_stop_event before insert, so frontier
 * re-inits (handoffs, repeated check-ins) can't double-fire an event type
 * for a stop. Events attribute to the session of the triggering ping (the
 * shift whose GPS produced them), falling back to the row's sessionId for
 * legacy loadId-only pings. geofenceEvents is append-only — the audit-grade
 * "detected" record next to the driver's manual check-in/out taps.
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

/**
 * Insert an event unless one of this type already exists for the stop.
 * The dedup read only happens on fire attempts (≤3 per stop), never on the
 * per-ping fast path.
 */
async function insertEventOnce(
  ctx: MutationCtx,
  state: Doc<'loadTrackingState'>,
  sessionId: Id<'driverSessions'>,
  args: {
    stopSequenceNumber: number;
    eventType: 'APPROACHING' | 'ARRIVED' | 'DEPARTED';
    triggeredAt: number;
    latitude: number;
    longitude: number;
    distanceMeters: number;
    accuracy?: number;
  }
): Promise<void> {
  const existing = await ctx.db
    .query('geofenceEvents')
    .withIndex('by_load_stop_event', (q) =>
      q
        .eq('loadId', state.loadId)
        .eq('stopSequenceNumber', args.stopSequenceNumber)
        .eq('eventType', args.eventType)
    )
    .first();
  if (existing) return;

  await ctx.db.insert('geofenceEvents', {
    sessionId,
    loadId: state.loadId,
    driverId: state.driverId,
    organizationId: state.organizationId,
    ...args,
  });
}

type GeofencePing = {
  latitude: number;
  longitude: number;
  recordedAt: number;
  accuracy?: number;
};

/**
 * Core evaluation, exported as a plain function so tests can drive it
 * directly through convex-test's ctx (the internalMutation below is a thin
 * scheduling wrapper). `sessionId` is the session of the triggering ping;
 * events attribute to it (falls back to the row's sessionId when absent).
 */
export async function evaluatePing(
  ctx: MutationCtx,
  args: {
    loadId: Id<'loadInformation'>;
    sessionId?: Id<'driverSessions'>;
    ping: GeofencePing;
  }
): Promise<null> {
  const state = await ctx.db
    .query('loadTrackingState')
    .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
    .first();

  // No state = driver hasn't checked into any stop yet. Pre-check-in pings
  // are valid telemetry (they go to driverLocations) but don't fire events.
  if (!state) return null;

  const eventSessionId = args.sessionId ?? state.sessionId;
  const patch: Partial<Doc<'loadTrackingState'>> = {};

  // ---- Arrival watch: APPROACHING / ARRIVED toward the next stop ----
  if (state.currentStopLat !== undefined && state.currentStopLng !== undefined) {
    const distance = calculateDistanceMeters(
      args.ping.latitude,
      args.ping.longitude,
      state.currentStopLat,
      state.currentStopLng
    );

    if (distance < OUTER_RING_METERS && !state.approachingFired) {
      await insertEventOnce(ctx, state, eventSessionId, {
        stopSequenceNumber: state.currentStopSequenceNumber!,
        eventType: 'APPROACHING',
        triggeredAt: args.ping.recordedAt,
        latitude: args.ping.latitude,
        longitude: args.ping.longitude,
        distanceMeters: distance,
        accuracy: args.ping.accuracy,
      });
      patch.approachingFired = true;
    }

    if (distance < INNER_RING_METERS && !state.arrivedFired) {
      await insertEventOnce(ctx, state, eventSessionId, {
        stopSequenceNumber: state.currentStopSequenceNumber!,
        eventType: 'ARRIVED',
        triggeredAt: args.ping.recordedAt,
        latitude: args.ping.latitude,
        longitude: args.ping.longitude,
        distanceMeters: distance,
        accuracy: args.ping.accuracy,
      });
      patch.arrivedFired = true;
    }
  }

  // ---- Departure watch: confirmed exit from the checked-in stop ----
  const watch = state.departureWatch;
  const accuracyOk =
    args.ping.accuracy === undefined || args.ping.accuracy <= GEOFENCE_MAX_ACCURACY_METERS;
  // Pings recorded at/before check-in are offline-backlog en-route fixes;
  // letting them through would fire DEPARTED with a pre-arrival timestamp.
  if (watch !== undefined && accuracyOk && args.ping.recordedAt > watch.armedAt) {
    const distance = calculateDistanceMeters(
      args.ping.latitude,
      args.ping.longitude,
      watch.lat,
      watch.lng
    );

    if (distance > DEPARTURE_RING_METERS) {
      if (watch.candidateAt === undefined) {
        // First ping outside the exit ring — remember when.
        patch.departureWatch = { ...watch, candidateAt: args.ping.recordedAt };
      } else if (args.ping.recordedAt > watch.candidateAt) {
        // Second, newer outside ping — departure confirmed.
        await insertEventOnce(ctx, state, eventSessionId, {
          stopSequenceNumber: watch.stopSequenceNumber,
          eventType: 'DEPARTED',
          triggeredAt: watch.candidateAt,
          latitude: args.ping.latitude,
          longitude: args.ping.longitude,
          distanceMeters: distance,
          accuracy: args.ping.accuracy,
        });

        // The load is complete and its last departure just resolved —
        // the row has no further purpose.
        if (state.loadCompleted) {
          await ctx.db.delete(state._id);
          return null;
        }
        patch.departureWatch = undefined;
      }
    } else if (watch.candidateAt !== undefined && args.ping.recordedAt > watch.candidateAt) {
      // A newer ping back inside the ring — the excursion was jitter, not a
      // departure. (An older ping proves nothing about the candidate.)
      patch.departureWatch = { ...watch, candidateAt: undefined };
    }
  }

  // Only write when something actually changed, keeping loadTrackingState
  // writes rare relative to ping volume.
  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(state._id, { ...patch, updatedAt: Date.now() });
  }

  return null;
}

export const evaluateLatestPing = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    sessionId: v.optional(v.id('driverSessions')),
    ping: v.object({
      latitude: v.float64(),
      longitude: v.float64(),
      recordedAt: v.float64(),
      accuracy: v.optional(v.float64()),
    }),
  },
  returns: v.null(),
  handler: evaluatePing,
});
