import { QueryCtx, MutationCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';

/**
 * loadTrackingState — per-load geofence frontier.
 *
 * Exactly one row per load while it's being driven. Created on first
 * check-in; advanced on each subsequent check-in; transferred on handoff.
 * On last-stop checkout the row is deleted — unless a departure watch is
 * still pending, in which case it's kept (loadCompleted=true) purely so the
 * driver's actual facility exit gets timestamped, then deleted by the
 * evaluator (or session-end cleanup).
 *
 * The row carries two independent watches for the geofence evaluator:
 *   - Arrival watch (currentStop*): the next unarrived stop. APPROACHING /
 *     ARRIVED fire against it, gated by the *Fired flags.
 *   - Departure watch (departureStop*): the most recently checked-in stop,
 *     watched for a confirmed exit (DEPARTED). departureCandidateAt is the
 *     first-outside-ping debounce marker.
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
  loadId: Id<'loadInformation'>,
): Promise<Doc<'loadTrackingState'> | null> {
  return ctx.db
    .query('loadTrackingState')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .first();
}

/**
 * Advance the frontier for a check-in at `stop` (creates the row on the
 * load's first check-in):
 *   - arrival watch → the next non-detour, non-canceled stop with
 *     coordinates after this one (absent when this was the final stop);
 *   - departure watch → the checked-in stop itself (when it has
 *     coordinates), with the debounce candidate reset;
 *   - sessionId/driverId re-stamped, so events after a handoff attribute to
 *     the relay driver's session.
 */
export async function setFrontierOnCheckIn(
  ctx: MutationCtx,
  args: {
    stop: Doc<'loadStops'>;
    sessionId: Id<'driverSessions'>;
    driverId: Id<'drivers'>;
    organizationId: string;
    now: number;
  },
): Promise<void> {
  const { stop } = args;

  const siblingStops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
    .collect();
  const upcoming = siblingStops
    .filter(
      (s) =>
        s.sequenceNumber > stop.sequenceNumber &&
        s.stopType !== 'DETOUR' &&
        s.status !== 'Canceled' &&
        s.latitude !== undefined &&
        s.longitude !== undefined,
    )
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];

  const hasStopCoords = stop.latitude !== undefined && stop.longitude !== undefined;
  const watches = {
    currentStopSequenceNumber: upcoming?.sequenceNumber,
    currentStopLat: upcoming?.latitude,
    currentStopLng: upcoming?.longitude,
    approachingFired: false,
    arrivedFired: false,
    // A coordinate-less stop (possible on detours) clears the departure
    // watch rather than leaving it aimed at the previous stop.
    departureStopSequenceNumber: hasStopCoords ? stop.sequenceNumber : undefined,
    departureStopLat: hasStopCoords ? stop.latitude : undefined,
    departureStopLng: hasStopCoords ? stop.longitude : undefined,
    departureCandidateAt: undefined,
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
 * Release the frontier when the load's last stop is checked out. Historical
 * geofenceEvents stay — only the current-pointer state is affected. If a
 * departure watch is still pending (the truck is normally still inside the
 * fence when the driver taps checkout), the row survives with
 * loadCompleted=true so the final DEPARTED can still fire; the evaluator
 * deletes it once the exit confirms.
 */
export async function releaseFrontierOnLoadComplete(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  now: number,
): Promise<void> {
  const state = await getByLoadId(ctx, loadId);
  if (!state) return;

  if (state.departureStopLat !== undefined) {
    await ctx.db.patch(state._id, {
      loadCompleted: true,
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
 * Handoff: point the frontier at the relay driver. Watches are preserved so
 * the relay resumes exactly where the primary left off; sessionId stays the
 * old session until the relay driver's first check-in re-stamps it (see
 * setFrontierOnCheckIn).
 */
export async function transferFrontierToDriver(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  newDriverId: Id<'drivers'>,
  now: number,
): Promise<void> {
  const state = await getByLoadId(ctx, loadId);
  if (!state) return;
  await ctx.db.patch(state._id, {
    driverId: newDriverId,
    updatedAt: now,
  });
}

/**
 * Session-end cleanup: drop rows that only exist to resolve a final
 * departure (loadCompleted=true) for a session that just ended — the driver
 * ended their shift while still parked at the last stop, so no more pings
 * are coming. The session timeline falls back to the manual checkout time.
 * Mid-load rows (load not completed) are left untouched.
 */
export async function deleteCompletedRowsForSession(ctx: MutationCtx, sessionId: Id<'driverSessions'>): Promise<void> {
  const rows = await ctx.db
    .query('loadTrackingState')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .collect();
  for (const row of rows) {
    if (row.loadCompleted) await ctx.db.delete(row._id);
  }
}
