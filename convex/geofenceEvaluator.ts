import { v } from 'convex/values';
import { internalMutation, MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import {
  calculateDistanceMeters,
  OUTER_RING_METERS,
  INNER_RING_METERS,
  DEPARTURE_RING_METERS,
  GEOFENCE_MAX_ACCURACY_METERS,
} from './lib/geo';
import { pointInPolygon } from './lib/polygonGeo';
import { logSystemEvent } from './lib/systemEvents';
import {
  nextArrivalTarget,
  buildArrivalWatch,
  buildDepartureWatch,
} from './loadTrackingState';

/**
 * How long after a GPS-detected arrival/departure the driver gets to tap
 * check-in/check-out before the auto-advance fallback records the stop's
 * progress for them (tapGraceCheck below). Short enough that clients see
 * live load state; long enough that the fallback is useless as a crutch
 * at the dock — the tap remains the driver's job.
 */
export const TAP_GRACE_MS = 20 * 60 * 1000;

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

  // Lazy one-shot stop read for the auto-advance paths below. Only fire
  // events reach it, so the per-ping fast path stays read-free.
  let stopsCache: Doc<'loadStops'>[] | undefined;
  const loadStops = async () => {
    stopsCache ??= await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', state.loadId))
      .collect();
    return stopsCache;
  };

  // Departure watch armed by THIS call's arrival (applied after the
  // departure section so its bookkeeping on the OLD watch can't clobber
  // it — an arrival at the next stop supersedes the previous stop's
  // unfired exit watch, exactly like a manual check-in does).
  let armedOnArrival: Doc<'loadTrackingState'>['departureWatch'];

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

    // A learned facility polygon replaces the arrival circle: ARRIVED means
    // "on the property as observed", not "within r of the pin". Falls back
    // to the radius when no polygon was snapshotted.
    const arrivalRadius = state.currentStopArrivalRadiusMeters ?? INNER_RING_METERS;
    const arrived =
      state.currentStopPolygon && state.currentStopPolygon.length >= 3
        ? pointInPolygon({ lat: args.ping.latitude, lng: args.ping.longitude }, state.currentStopPolygon)
        : distance < arrivalRadius;
    if (arrived && !state.arrivedFired) {
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

      // ---- Auto-advance, arrival half: arm the exit watch now instead of
      // waiting for a check-in tap, so a tap-less trip still gets its
      // DEPARTED. A later manual check-in re-arms with the tap timestamp
      // (more conservative armedAt) — the normal flow is unchanged. Also
      // start the tap grace clock: if the driver hasn't checked in when it
      // expires, tapGraceCheck records the arrival for the load and logs a
      // missed-tap review item to the platform console.
      const arrivedStop = (await loadStops()).find(
        (s) => s.sequenceNumber === state.currentStopSequenceNumber
      );
      if (arrivedStop) {
        armedOnArrival = await buildDepartureWatch(ctx, arrivedStop, args.ping.recordedAt);
        // A pre-trip row is now a live trip — stop the pre-trip lazy-arm
        // hook from re-aiming or deleting it.
        if (state.preTrip) patch.preTrip = undefined;
        if (arrivedStop.checkedInAt === undefined) {
          await ctx.scheduler.runAfter(TAP_GRACE_MS, internal.geofenceEvaluator.tapGraceCheck, {
            stopId: arrivedStop._id,
            kind: 'checkin',
            detectedAt: args.ping.recordedAt,
          });
        }
      }
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

    // Polygon departure mirrors polygon arrival: outside the expanded exit
    // polygon (hysteresis pre-baked at snapshot time) instead of beyond the
    // exit radius.
    const exitRadius = watch.exitRadiusMeters ?? DEPARTURE_RING_METERS;
    const outside =
      watch.exitPolygon && watch.exitPolygon.length >= 3
        ? !pointInPolygon({ lat: args.ping.latitude, lng: args.ping.longitude }, watch.exitPolygon)
        : distance > exitRadius;
    if (outside) {
      if (watch.candidateAt === undefined) {
        // First ping outside the exit ring — remember when AND where. The
        // eventual DEPARTED is stamped with this fix so the map pin sits
        // exactly where the truck crossed out.
        patch.departureWatch = {
          ...watch,
          candidateAt: args.ping.recordedAt,
          candidateLat: args.ping.latitude,
          candidateLng: args.ping.longitude,
          candidateAccuracy: args.ping.accuracy,
        };
      } else if (args.ping.recordedAt > watch.candidateAt) {
        // Second, newer outside ping — departure confirmed. Event carries
        // the candidate fix (position + time move together); pre-upgrade
        // rows without candidate coords fall back to the confirming ping.
        const evLat = watch.candidateLat ?? args.ping.latitude;
        const evLng = watch.candidateLng ?? args.ping.longitude;
        await insertEventOnce(ctx, state, eventSessionId, {
          stopSequenceNumber: watch.stopSequenceNumber,
          eventType: 'DEPARTED',
          triggeredAt: watch.candidateAt,
          latitude: evLat,
          longitude: evLng,
          distanceMeters: calculateDistanceMeters(evLat, evLng, watch.lat, watch.lng),
          accuracy: watch.candidateLat !== undefined ? watch.candidateAccuracy : args.ping.accuracy,
        });

        // Tap grace clock for the departed stop: the truck has confirmed
        // its exit, so a missing checkout is now a missed tap, not a
        // driver still at the dock.
        const departedStop = (await loadStops()).find(
          (s) => s.sequenceNumber === watch.stopSequenceNumber
        );
        if (departedStop && departedStop.checkedOutAt === undefined) {
          await ctx.scheduler.runAfter(TAP_GRACE_MS, internal.geofenceEvaluator.tapGraceCheck, {
            stopId: departedStop._id,
            kind: 'checkout',
            detectedAt: watch.candidateAt,
          });
        }

        // The load is complete and its last departure just resolved —
        // the row has no further purpose.
        if (state.loadCompleted) {
          await ctx.db.delete(state._id);
          return null;
        }
        patch.departureWatch = undefined;

        // ---- Auto-advance, departure half: if the arrival watch never
        // moved past the departed stop (no check-in tap advanced it), aim
        // it at the next unvisited stop so the rest of a tap-less trip
        // keeps detecting. When a tap already advanced it (the normal
        // flow), this is skipped.
        if (
          state.currentStopSequenceNumber !== undefined &&
          state.currentStopSequenceNumber <= watch.stopSequenceNumber
        ) {
          Object.assign(
            patch,
            await buildArrivalWatch(
              ctx,
              nextArrivalTarget(await loadStops(), watch.stopSequenceNumber)
            )
          );
          if (state.preTrip) patch.preTrip = undefined;
        }
      }
    } else if (
      watch.candidateAt !== undefined &&
      args.ping.recordedAt > watch.candidateAt
    ) {
      // A newer ping back inside the ring — the excursion was jitter, not a
      // departure. (An older ping proves nothing about the candidate.)
      patch.departureWatch = {
        ...watch,
        candidateAt: undefined,
        candidateLat: undefined,
        candidateLng: undefined,
        candidateAccuracy: undefined,
      };
    }
  }

  // The arrival-armed exit watch wins over any bookkeeping the departure
  // section did on the superseded watch (see armedOnArrival above).
  if (armedOnArrival !== undefined) {
    patch.departureWatch = armedOnArrival;
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

/**
 * Tap grace check — the auto-advance fallback's second half. Scheduled
 * TAP_GRACE_MS after a GPS-detected arrival/departure whose stop had no
 * matching tap yet. If the driver still hasn't tapped when it fires:
 *
 *   - stamp the GPS-attributed fallback timestamp (autoArrivedAt /
 *     autoDepartedAt — NEVER the manual checkedInAt/checkedOutAt fields,
 *     which stay the driver's own record);
 *   - advance the stop's status so dispatch and clients see live load
 *     progress instead of a stuck stop;
 *   - log a missed-tap review item to the platform console (driver
 *     coaching signal — reinforce training, don't fail the client).
 *
 * Deliberately NOT done here: activating/completing dispatch legs,
 * completing the load, or anything the driver's own workflow gates (POD,
 * pay). The driver's app never auto-completes — from their seat the
 * geofence does nothing for them.
 */
export async function runTapGraceCheck(
  ctx: MutationCtx,
  args: {
    stopId: Id<'loadStops'>;
    kind: 'checkin' | 'checkout';
    detectedAt: number;
  }
): Promise<null> {
  const stop = await ctx.db.get(args.stopId);
  if (!stop || stop.status === 'Canceled') return null;

  if (args.kind === 'checkin') {
    // Driver tapped in the meantime, or an earlier grace check already
    // recorded this arrival — nothing to do.
    if (stop.checkedInAt !== undefined || stop.autoArrivedAt !== undefined) return null;

    const advanceStatus =
      stop.status === undefined || stop.status === 'Pending' || stop.status === 'Delayed';
    await ctx.db.patch(stop._id, {
      autoArrivedAt: args.detectedAt,
      ...(advanceStatus ? { status: 'In Transit' as const } : {}),
      updatedAt: Date.now(),
    });
    await logSystemEvent(ctx, {
      severity: 'warn',
      source: 'geofence',
      code: 'geofence.missed_checkin',
      message:
        `Geofence detected arrival at stop ${stop.sequenceNumber} of load ${stop.internalId} ` +
        `but the driver did not check in within ${TAP_GRACE_MS / 60_000} minutes — ` +
        'stop progress recorded from GPS (driver coaching needed)',
      orgId: stop.workosOrgId,
      context: {
        stopId: stop._id,
        loadId: stop.loadId,
        loadInternalId: stop.internalId,
        detectedAt: args.detectedAt,
      },
    });
  } else {
    if (stop.checkedOutAt !== undefined || stop.autoDepartedAt !== undefined) return null;

    const advanceStatus =
      stop.status === undefined ||
      stop.status === 'Pending' ||
      stop.status === 'Delayed' ||
      stop.status === 'In Transit';
    await ctx.db.patch(stop._id, {
      autoDepartedAt: args.detectedAt,
      ...(advanceStatus ? { status: 'Completed' as const } : {}),
      updatedAt: Date.now(),
    });
    // A fully passive stop (no check-in either) already produced a
    // missed_checkin review item — one coaching signal per stop is enough.
    if (stop.checkedInAt !== undefined) {
      await logSystemEvent(ctx, {
        severity: 'warn',
        source: 'geofence',
        code: 'geofence.missed_checkout',
        message:
          `Geofence confirmed departure from stop ${stop.sequenceNumber} of load ${stop.internalId} ` +
          `but the driver did not check out within ${TAP_GRACE_MS / 60_000} minutes — ` +
          'stop completion recorded from GPS (driver coaching needed)',
        orgId: stop.workosOrgId,
        context: {
          stopId: stop._id,
          loadId: stop.loadId,
          loadInternalId: stop.internalId,
          detectedAt: args.detectedAt,
        },
      });
    }
  }
  return null;
}

export const tapGraceCheck = internalMutation({
  args: {
    stopId: v.id('loadStops'),
    kind: v.union(v.literal('checkin'), v.literal('checkout')),
    detectedAt: v.number(),
  },
  returns: v.null(),
  handler: (ctx, args) => runTapGraceCheck(ctx, args),
});
