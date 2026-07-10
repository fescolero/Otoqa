import { MutationCtx, QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';

// ============================================
// SAMSARA INGEST — PING CONTEXT RESOLVER
// Given a truck, figure out (driverId, sessionId, loadId?, trackingType)
// to stamp on an inbound Samsara GPS ping. Returns null if no driver is
// on shift for this truck — caller drops the ping (per the design
// decision to not store orphan pings).
// ============================================

export type SamsaraPingContext =
  | {
      driverId: Id<'drivers'>;
      sessionId: Id<'driverSessions'>;
      loadId: Id<'loadInformation'>;
      trackingType: 'LOAD_ROUTE';
    }
  | {
      driverId: Id<'drivers'>;
      sessionId: Id<'driverSessions'>;
      loadId?: undefined;
      trackingType: 'SESSION_ROUTE';
    };

/**
 * Resolve the ingest context for a Samsara GPS ping.
 *
 *   1. Find the truck's currently-open driverSession (status='active'). If
 *      none → return null. The driver hasn't tapped Start Shift, so we have
 *      no driverId to attribute the ping to and no leg context.
 *
 *   2. Find an ACTIVE dispatchLeg for that session. If found, the driver is
 *      actively on a load → ping is LOAD_ROUTE with that loadId. Otherwise
 *      the driver is on-shift between loads → SESSION_ROUTE.
 *
 * The "ACTIVE leg → LOAD_ROUTE" branch matches the invariants enforced by
 * driverLocations.ingestBatch (loadId present ↔ LOAD_ROUTE), so callers can
 * pass the result straight through without re-deriving trackingType.
 */
export async function resolvePingContext(
  ctx: QueryCtx | MutationCtx,
  truck: Doc<'trucks'>,
): Promise<SamsaraPingContext | null> {
  // 1) Open session for this truck.
  const session = await ctx.db
    .query('driverSessions')
    .withIndex('by_truck_status', (q) =>
      q.eq('truckId', truck._id).eq('status', 'active'),
    )
    .first();

  if (!session) return null;

  // Defensive: if the session somehow lives in a different org than the
  // truck (data hygiene bug), refuse to attribute the ping. Belt-and-
  // suspenders on top of the per-mutation org check.
  if (session.organizationId !== truck.organizationId) return null;

  // 2) ACTIVE leg for this session. Use the by_driver index keyed on
  // (driverId, status); active legs per driver are typically 0 or 1, so
  // filtering by sessionId in memory is cheap.
  const activeLegs = await ctx.db
    .query('dispatchLegs')
    .withIndex('by_driver', (q) =>
      q.eq('driverId', session.driverId).eq('status', 'ACTIVE'),
    )
    .collect();

  const legForThisSession = activeLegs.find(
    (leg) => leg.sessionId === session._id,
  );

  if (legForThisSession) {
    return {
      driverId: session.driverId,
      sessionId: session._id,
      loadId: legForThisSession.loadId,
      trackingType: 'LOAD_ROUTE',
    };
  }

  return {
    driverId: session.driverId,
    sessionId: session._id,
    trackingType: 'SESSION_ROUTE',
  };
}
