import { QueryCtx, MutationCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { exitRadiusFor, EXIT_RADIUS_RATIO, INNER_RING_METERS } from './lib/geo';
import { expandPolygon } from './lib/polygonGeo';
import { pendingLegsForShift } from './lib/legTracking';

/**
 * loadTrackingState — per-load geofence frontier.
 *
 * Exactly one row per load while it's being driven. Created on first
 * check-in; advanced on each subsequent check-in; transferred on handoff.
 * On last-stop checkout the row is deleted — unless a departure watch is
 * still pending, in which case it's kept (loadCompleted=true) purely so the
 * driver's actual facility exit gets timestamped, then deleted by the
 * evaluator (or session-end cleanup / same-driver rollover, see below).
 *
 * The row carries two independent watches for the geofence evaluator:
 *   - Arrival watch (currentStop*): the next unarrived stop. APPROACHING /
 *     ARRIVED fire against it, gated by the *Fired flags.
 *   - Departure watch (departureWatch): the most recently checked-in stop,
 *     watched for a confirmed exit (DEPARTED). Its armedAt/candidateAt
 *     fields drive the offline-backlog and GPS-jitter debounce guards.
 *
 * This table is deliberately hot and narrow: only the geofence evaluator,
 * check-in/out mutations, and handoff mutations write to it. Dispatcher
 * dashboards do NOT subscribe to it, so per-ping writes don't cascade
 * reactive-query invalidations.
 *
 * These are plain helpers (not mutations) so callers compose them inside
 * their own transaction; callers own the auth checks that gate them.
 */

export async function getByLoadId(
  ctx: QueryCtx | MutationCtx,
  loadId: Id<'loadInformation'>
): Promise<Doc<'loadTrackingState'> | null> {
  return ctx.db
    .query('loadTrackingState')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .first();
}

/**
 * The stop's facility ARRIVED-radius override (facilities.radiusMeters),
 * or undefined for the INNER_RING_METERS default. Shared by the check-in
 * snapshot above and the map's ring query.
 */
export async function facilityArrivalRadius(
  ctx: QueryCtx | MutationCtx,
  stop: Pick<Doc<'loadStops'>, 'facilityId'> | undefined
): Promise<number | undefined> {
  return (await facilityFence(ctx, stop)).radiusMeters;
}

/**
 * The stop's full facility fence: radius override AND learned polygon
 * (when the refinement cron has built one). The polygon replaces the
 * arrival circle in the evaluator; the radius remains the fallback and
 * the exit-ratio base.
 */
export async function facilityFence(
  ctx: QueryCtx | MutationCtx,
  stop: Pick<Doc<'loadStops'>, 'facilityId'> | undefined
): Promise<{ radiusMeters?: number; polygon?: { lat: number; lng: number }[] }> {
  if (!stop?.facilityId) return {};
  const facility = await ctx.db.get(stop.facilityId);
  if (!facility || facility.isDeleted) return {};
  return {
    radiusMeters:
      facility.radiusMeters && facility.radiusMeters > 0 ? facility.radiusMeters : undefined,
    polygon:
      facility.geofencePolygon && facility.geofencePolygon.length >= 3
        ? facility.geofencePolygon
        : undefined,
  };
}

async function getActiveSessionForDriver(
  ctx: QueryCtx | MutationCtx,
  driverId: Id<'drivers'>
): Promise<Doc<'driverSessions'> | null> {
  return ctx.db
    .query('driverSessions')
    .withIndex('by_driver_status', (q) => q.eq('driverId', driverId).eq('status', 'active'))
    .first();
}

// ---------------------------------------------------------------------------
// Watch builders — the three primitives every frontier writer composes.
// Check-in, pre-trip arming, and the evaluator's auto-advance all target
// stops and snapshot fences the same way; these are the single home for
// that logic.
// ---------------------------------------------------------------------------

/**
 * The next stop a geofence arrival watch should aim at: lowest-sequence
 * stop (after `afterSequence`, when given) that is not a detour, not
 * canceled, not already checked in, and has coordinates. Undefined when
 * nothing qualifies (end of trip).
 */
export function nextArrivalTarget(
  stops: Doc<'loadStops'>[],
  afterSequence?: number
): Doc<'loadStops'> | undefined {
  return stops
    .filter(
      (s) =>
        (afterSequence === undefined || s.sequenceNumber > afterSequence) &&
        s.stopType !== 'DETOUR' &&
        s.status !== 'Canceled' &&
        s.checkedInAt === undefined &&
        s.latitude !== undefined &&
        s.longitude !== undefined
    )
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];
}

/**
 * Arrival-watch fields aimed at `target` (cleared fields when undefined —
 * nothing left to approach). Snapshots the target's facility fence so the
 * evaluator stays read-free per ping.
 */
export async function buildArrivalWatch(
  ctx: QueryCtx | MutationCtx,
  target: Doc<'loadStops'> | undefined
): Promise<{
  currentStopSequenceNumber: number | undefined;
  currentStopLat: number | undefined;
  currentStopLng: number | undefined;
  currentStopArrivalRadiusMeters: number | undefined;
  currentStopPolygon: { lat: number; lng: number }[] | undefined;
  approachingFired: boolean;
  arrivedFired: boolean;
}> {
  const fence = target ? await facilityFence(ctx, target) : {};
  return {
    currentStopSequenceNumber: target?.sequenceNumber,
    currentStopLat: target?.latitude,
    currentStopLng: target?.longitude,
    currentStopArrivalRadiusMeters: fence.radiusMeters,
    currentStopPolygon: fence.polygon,
    approachingFired: false,
    arrivedFired: false,
  };
}

/**
 * Departure-watch object for `stop`, freshly armed at `armedAt`, with the
 * exit boundary snapshotted from the stop's facility fence. Polygon
 * hysteresis mirrors the circle's: the exit boundary is the arrival
 * polygon pushed out by the same delta the exit ring adds to the arrival
 * ring (ratio − 1 × radius, defaulting the radius base). Undefined for a
 * coordinate-less stop (possible on detours) — the watch clears rather
 * than staying aimed at the previous stop.
 */
export async function buildDepartureWatch(
  ctx: QueryCtx | MutationCtx,
  stop: Doc<'loadStops'>,
  armedAt: number
): Promise<NonNullable<Doc<'loadTrackingState'>['departureWatch']> | undefined> {
  if (stop.latitude === undefined || stop.longitude === undefined) return undefined;
  const fence = await facilityFence(ctx, stop);
  const exitPolygon = fence.polygon
    ? expandPolygon(
        fence.polygon,
        (EXIT_RADIUS_RATIO - 1) * (fence.radiusMeters ?? INNER_RING_METERS),
      )
    : undefined;
  return {
    stopSequenceNumber: stop.sequenceNumber,
    lat: stop.latitude,
    lng: stop.longitude,
    armedAt,
    exitRadiusMeters: exitRadiusFor(fence.radiusMeters),
    exitPolygon,
  };
}

/**
 * Advance the frontier for a check-in at `stop` (creates the row on the
 * load's first check-in):
 *   - arrival watch → the next unvisited, non-detour, non-canceled stop
 *     with coordinates after this one (absent when this was the final
 *     stop);
 *   - departure watch → the checked-in stop itself (when it has
 *     coordinates), freshly armed;
 *   - sessionId/driverId re-stamped, so events after a handoff attribute to
 *     the relay driver's session;
 *   - loadCompleted cleared — a post-completion re-check-in (possible via
 *     the legacy primaryDriverId access path) revives the row as a normal
 *     mid-load frontier instead of leaving it flagged for deletion.
 *
 * Facility fences (the same values the manual check-in geofence honors)
 * are snapshotted onto the watches by the builders above. Snapshot-at-
 * check-in keeps the evaluator read-free per ping and makes each leg's
 * thresholds stable even if a dispatcher retunes the facility mid-drive.
 */
export async function setFrontierOnCheckIn(
  ctx: MutationCtx,
  args: {
    stop: Doc<'loadStops'>;
    sessionId: Id<'driverSessions'>;
    driverId: Id<'drivers'>;
    organizationId: string;
    now: number;
  }
): Promise<void> {
  const { stop } = args;

  const siblingStops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
    .collect();

  const [arrivalWatch, departureWatch] = await Promise.all([
    buildArrivalWatch(ctx, nextArrivalTarget(siblingStops, stop.sequenceNumber)),
    buildDepartureWatch(ctx, stop, args.now),
  ]);

  const watches = {
    ...arrivalWatch,
    departureWatch,
    loadCompleted: undefined,
    // A pre-trip row (armed at session start toward stop 1) graduates to a
    // normal mid-load frontier on first check-in.
    preTrip: undefined,
    updatedAt: args.now,
  };

  const existing = await getByLoadId(ctx, stop.loadId);
  if (existing) {
    await ctx.db.patch(existing._id, {
      sessionId: args.sessionId,
      driverId: args.driverId,
      ...watches,
    });
  } else {
    await ctx.db.insert('loadTrackingState', {
      loadId: stop.loadId,
      sessionId: args.sessionId,
      driverId: args.driverId,
      organizationId: args.organizationId,
      ...watches,
    });
  }
}


/**
 * Pre-trip arming — the session starts the tracking, not the first
 * check-in. Called lazily from ingestBatch whenever a session-only
 * (SESSION_ROUTE) batch lands for an active session: on shift the driver
 * pings without a loadId until their first check-in, which previously
 * meant no fence existed and stop 1 never got a GPS-detected arrival.
 *
 * This arms an arrival-only watch (no departure watch) at the first
 * unvisited stop of the driver's NEXT pending leg. Scope rules keep each
 * load's dataset its own:
 *   - Only ONE pre-trip watch at a time — the next leg by plannedStartAt
 *     within the shift window. Other queued loads get nothing until they
 *     become next, so a fence can't fire for a load the driver isn't
 *     heading to.
 *   - The raw session pings stay session-scoped in driverLocations; a
 *     load's route history remains only the pings stamped with its own
 *     loadId (ACTIVE-leg validated). The only thing recorded against the
 *     load pre-trip is the fence-crossing fix at the load's own facility.
 *   - Mid-load rows (no preTrip flag) are never touched here — check-in /
 *     checkout / handoff flows own them.
 *
 * Self-healing: pre-trip rows whose load is no longer the driver's next
 * (reassigned, canceled, or the driver went ACTIVE on another leg) are
 * deleted on the next session batch, and a pre-trip row left bound to a
 * previous session is re-bound when the same load is next again.
 */
export async function armPreTripWatchForDriver(
  ctx: MutationCtx,
  session: Doc<'driverSessions'>,
  now: number
): Promise<void> {
  const [activeLeg, pendingLegs, sessionRows] = await Promise.all([
    ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', session.driverId).eq('status', 'ACTIVE'))
      .first(),
    ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', session.driverId).eq('status', 'PENDING'))
      .collect(),
    ctx.db
      .query('loadTrackingState')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect(),
  ]);

  // A driver actively on a leg has a real frontier (or is about to create
  // one at check-in); pre-trip watches only exist between loads. The
  // shared shift-window pick guarantees the fence arms for the same load
  // the driver sees at the top of their mobile up-next queue.
  const nextLeg: Doc<'dispatchLegs'> | undefined = activeLeg
    ? undefined
    : pendingLegsForShift(pendingLegs, session.startedAt)[0];

  // Drop stale pre-trip rows: anything armed for a load that is no longer
  // the driver's next. Mid-load and loadCompleted rows are left alone.
  for (const row of sessionRows) {
    if (row.preTrip && row.loadId !== nextLeg?.loadId) {
      await ctx.db.delete(row._id);
    }
  }
  if (!nextLeg) return;
  const nextLoadId = nextLeg.loadId;

  // First unvisited, coordinate-bearing stop of the next leg's load.
  const stops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', nextLoadId))
    .collect();
  const target = nextArrivalTarget(stops);
  if (!target) return;

  const existing = await getByLoadId(ctx, nextLoadId);
  // A non-pre-trip row means the load already has a real frontier (e.g.
  // another driver mid-load before a handoff) — never clobber it.
  if (existing && !existing.preTrip) return;

  // No-op when the existing pre-trip row already points at this session,
  // driver, and stop — this runs on every session-only batch, and writes
  // here must stay rare relative to ping volume.
  if (
    existing &&
    existing.sessionId === session._id &&
    existing.driverId === session.driverId &&
    existing.currentStopSequenceNumber === target.sequenceNumber
  ) {
    return;
  }

  const watch = {
    sessionId: session._id,
    driverId: session.driverId,
    ...(await buildArrivalWatch(ctx, target)),
    departureWatch: undefined,
    loadCompleted: undefined,
    preTrip: true,
    updatedAt: now,
  };

  if (existing) {
    await ctx.db.patch(existing._id, watch);
  } else {
    await ctx.db.insert('loadTrackingState', {
      loadId: nextLeg.loadId,
      organizationId: session.organizationId,
      ...watch,
    });
  }
}

/**
 * Release the frontier when the load's last stop is checked out. Historical
 * geofenceEvents stay — only the current-pointer state is affected. If a
 * departure watch is still pending (the truck is normally still inside the
 * fence when the driver taps checkout), the row survives with
 * loadCompleted=true so the final DEPARTED can still fire; the evaluator
 * deletes it once the exit confirms.
 *
 * currentSessionId (the driver's active session at checkout time, when one
 * exists) re-binds the kept row: check-in may have happened under an
 * earlier session (overnight dwell + auto-timeout), and the by_session
 * lookups in ingestBatch and session-end cleanup only see the session the
 * row points at.
 */
export async function releaseFrontierOnLoadComplete(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  now: number,
  currentSessionId?: Id<'driverSessions'>
): Promise<void> {
  const state = await getByLoadId(ctx, loadId);
  if (!state) return;

  if (state.departureWatch !== undefined) {
    await ctx.db.patch(state._id, {
      loadCompleted: true,
      ...(currentSessionId ? { sessionId: currentSessionId } : {}),
      currentStopSequenceNumber: undefined,
      currentStopLat: undefined,
      currentStopLng: undefined,
      updatedAt: now,
    });
  } else {
    await ctx.db.delete(state._id);
  }
}

/**
 * Hard-release the frontier for a load that is no longer being driven at
 * all — Canceled, Expired, or reopened to Open. Unlike
 * releaseFrontierOnLoadComplete there is no departure-watch keep-alive:
 * the load's execution is void, so no further geofence timestamps are
 * meaningful for it. Without this, expiring/canceling assigned loads
 * leaks their tracking rows (17 orphans found in the first production
 * sweep). Idempotent — no row is a no-op.
 */
export async function deleteFrontierForLoad(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>
): Promise<void> {
  const state = await getByLoadId(ctx, loadId);
  if (state) await ctx.db.delete(state._id);
}

/**
 * Handoff: point the frontier at the relay driver. The arrival watch is
 * preserved so the relay resumes exactly where the primary left off; the
 * departure watch is cleared — it tracked the from-driver's physical
 * presence, and evaluating it against either driver's pings after the
 * handoff would fire a bogus DEPARTED (the from-driver drives away while
 * the truck/load stays). The relay's own check-in re-arms it.
 *
 * sessionId is re-bound to the relay's active session when they have one;
 * otherwise it stays on the old session until their first check-in
 * re-stamps it (ingestBatch's driverId guard keeps the from-driver's pings
 * from being evaluated against the row in the interim).
 */
export async function transferFrontierToDriver(
  ctx: MutationCtx,
  state: Doc<'loadTrackingState'> | null,
  newDriverId: Id<'drivers'>,
  now: number
): Promise<void> {
  if (!state) return;
  const newSession = await getActiveSessionForDriver(ctx, newDriverId);
  await ctx.db.patch(state._id, {
    driverId: newDriverId,
    ...(newSession ? { sessionId: newSession._id } : {}),
    departureWatch: undefined,
    updatedAt: now,
  });
}

/**
 * Session-end cleanup: drop rows that only exist to resolve a final
 * departure (loadCompleted=true) for a session that just ended — no more
 * pings are coming, so the session timeline falls back to the manual
 * checkout time. Mid-load rows (load not completed) are left untouched.
 *
 * NOT called for next_session_opened ends: the same driver keeps pinging
 * under the new session, so those rows are re-bound instead — see
 * transferCompletedRowsToSession.
 */
export async function deleteCompletedRowsForSession(
  ctx: MutationCtx,
  sessionId: Id<'driverSessions'>
): Promise<void> {
  const rows = await ctx.db
    .query('loadTrackingState')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .collect();
  for (const row of rows) {
    if (row.loadCompleted) await ctx.db.delete(row._id);
  }
}

/**
 * Same-driver session rollover ("forgot to end shift" → Start Shift): move
 * pending final-departure rows from the closed session to the new one so
 * the still-inbound pings (now tagged with the new session) can resolve the
 * DEPARTED that would otherwise be lost.
 */
export async function transferCompletedRowsToSession(
  ctx: MutationCtx,
  fromSessionId: Id<'driverSessions'>,
  toSessionId: Id<'driverSessions'>,
  now: number
): Promise<void> {
  const rows = await ctx.db
    .query('loadTrackingState')
    .withIndex('by_session', (q) => q.eq('sessionId', fromSessionId))
    .collect();
  for (const row of rows) {
    if (row.loadCompleted) {
      await ctx.db.patch(row._id, { sessionId: toSessionId, updatedAt: now });
    }
  }
}
