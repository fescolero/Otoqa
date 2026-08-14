import type { QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { parseStopDateTime } from '../_helpers/timeUtils';

// Structural ctx: just the db reader. Lets loosely-typed internal helpers
// (e.g. externalTracking's `{ db: any }` resolver) call in; a MutationCtx
// satisfies it too since its writer extends the reader.
type DbCtx = Pick<QueryCtx, 'db'>;

/**
 * legTracking — the ONE home for "which session speaks for this dispatch
 * leg, and how early may its pings surface" — the data-isolation policy
 * every partner-facing read and push enforces.
 *
 * Previously this concept was re-implemented in five places
 * (externalTracking ×2, fourKitesDispatcherPushMutations ×3), one of
 * which had drifted onto its own inline date parser. Any change to the
 * isolation policy — the approach window, the session-resolution rules —
 * happens here and nowhere else.
 */

/**
 * Approach window: how far before the leg's pickup appointment partner
 * reads are allowed to surface session pings. Caps the otherwise-
 * unbounded "since session start" window so a driver who started shift
 * hours before pickup doesn't leak unrelated pre-approach pings (other
 * loads, deadhead) to this load's watchers.
 */
export const APPROACH_WINDOW_MS = 30 * 60 * 1000;

/**
 * The session whose pings represent this leg:
 *   a) leg.sessionId (stamped on first check-in) when present — even if
 *      that session has since ended (historical legs);
 *   b) otherwise, the assigned driver's currently-open session — the
 *      pre-check-in fallback that lets partners see approach pings
 *      BEFORE the driver taps Check In (the approach-window floor keeps
 *      earlier-shift pings out);
 *   c) null when the leg has neither (orphan or legacy pre-Phase-1 leg —
 *      callers fall back to load-tagged pings only).
 */
export async function resolveLegSession(
  ctx: DbCtx,
  leg: Pick<Doc<'dispatchLegs'>, 'sessionId' | 'driverId'>
): Promise<Doc<'driverSessions'> | null> {
  if (leg.sessionId) return ctx.db.get(leg.sessionId);
  if (leg.driverId) {
    return ctx.db
      .query('driverSessions')
      .withIndex('by_driver_status', (q) =>
        q.eq('driverId', leg.driverId!).eq('status', 'active')
      )
      .first();
  }
  return null;
}

/**
 * The leg's pickup appointment anchor (ms epoch): the denormalized
 * scheduledStartMs cache when present, else parsed live from the start
 * stop's window (legacy rows not yet backfilled). Null when neither
 * yields a timestamp.
 */
export async function legPickupAnchorMs(
  ctx: DbCtx,
  leg: Pick<Doc<'dispatchLegs'>, 'scheduledStartMs' | 'startStopId'>
): Promise<number | null> {
  if (leg.scheduledStartMs !== undefined) return leg.scheduledStartMs;
  const startStop = await ctx.db.get(leg.startStopId);
  if (!startStop) return null;
  return parseStopDateTime(startStop.windowBeginDate, startStop.windowBeginTime);
}

/**
 * Earliest recordedAt partner-facing reads may surface for a leg: the
 * pickup anchor minus the approach window. Null when the leg has no
 * resolvable anchor — callers choose their legacy fallback explicitly
 * (session start, or no floor) so un-backfilled legs don't lose pings.
 */
export function approachFloorMs(pickupAnchor: number | null): number | null {
  return pickupAnchor !== null ? pickupAnchor - APPROACH_WINDOW_MS : null;
}
