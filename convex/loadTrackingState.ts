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

async function getActiveSessionForDriver(
  ctx: QueryCtx | MutationCtx,
  driverId: Id<'drivers'>
): Promise<Doc<'driverSessions'> | null> {
  return ctx.db
    .query('driverSessions')
    .withIndex('by_driver_status', (q) => q.eq('driverId', driverId).eq('status', 'active'))
    .first();
}

/**
 * Advance the frontier for a check-in at `stop` (creates the row on the
 * load's first check-in):
 *   - arrival watch → the next non-detour, non-canceled stop with
 *     coordinates after this one (absent when this was the final stop);
 *   - departure watch → the checked-in stop itself (when it has
 *     coordinates), freshly armed;
 *   - sessionId/driverId re-stamped, so events after a handoff attribute to
 *     the relay driver's session;
 *   - loadCompleted cleared — a post-completion re-check-in (possible via
 *     the legacy primaryDriverId access path) revives the row as a normal
 *     mid-load frontier instead of leaving it flagged for deletion.
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
  const upcoming = siblingStops
    .filter(
      (s) =>
        s.sequenceNumber > stop.sequenceNumber &&
        s.stopType !== 'DETOUR' &&
        s.status !== 'Canceled' &&
        s.latitude !== undefined &&
        s.longitude !== undefined
    )
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber)[0];

  const watches = {
    currentStopSequenceNumber: upcoming?.sequenceNumber,
    currentStopLat: upcoming?.latitude,
    currentStopLng: upcoming?.longitude,
    approachingFired: false,
    arrivedFired: false,
    // A coordinate-less stop (possible on detours) clears the departure
    // watch rather than leaving it aimed at the previous stop.
    departureWatch:
      stop.latitude !== undefined && stop.longitude !== undefined
        ? {
            stopSequenceNumber: stop.sequenceNumber,
            lat: stop.latitude,
            lng: stop.longitude,
            armedAt: args.now,
          }
        : undefined,
    loadCompleted: undefined,
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
