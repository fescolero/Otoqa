/**
 * Live ops — Active Sessions page server queries.
 *
 * Backs `app/(app)/dispatch/sessions/page.tsx` (the live driver map +
 * accordion + per-driver activity panel).
 *
 * Three queries:
 *   1. `listLiveSessions` — REACTIVE. Combines active driverSessions +
 *      driverLatestLocation + the driver's in-progress dispatch leg + truck
 *      metadata into the single shape the page needs. Re-fires only on
 *      session lifecycle / leg lifecycle / latest-location writes (and even
 *      then only when the org's row set changes — Convex deduplicates).
 *
 *      The page already polls `getSessionFreshness` every 60s for sub-minute
 *      freshness on the badge — this composite query is the slower-cadence
 *      "everything-the-screen-needs" lane.
 *
 *   2. `listSessionsForDay` / `listDaysWithData` — past-day replay queries.
 *
 *   3. `listSessionPingsPage` — PAGINATED. Returns GPS pings for one
 *      session, newest first, in cursor-paged chunks. The client uses
 *      `usePaginatedQuery` to load all pages, then keeps watching the
 *      first page for live pings as they land.
 *
 * Status derivation policy ("driving | idle | break | off-duty"):
 *   The backend doesn't have a "break" event yet (no HOS event stream wired),
 *   so we derive status from speed + ping freshness on the latest location:
 *
 *     - latest ping <  5 min old, speed >= 5 mph  → driving
 *     - latest ping <  5 min old, speed <  5 mph  → idle
 *     - latest ping >= 5 min old                  → idle (offline-ish)
 *     - no ping at all                            → idle
 *
 *   "break" is exposed in the UI as a filter chip but currently never
 *   matches a real driver. Once Samsara HOS events land, this is where the
 *   status will lift to 'break' / 'off-duty' / etc.
 */

import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, QueryCtx } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { requireCallerOrgId } from './lib/auth';

const FIVE_MIN_MS = 5 * 60 * 1000;
const DRIVING_SPEED_THRESHOLD_MPH = 5;
// Cap legs per session — a driver could theoretically run 20 short loads
// in a day; in practice this is 2-6. Bound prevents pathological rows.
const MAX_LEGS_PER_SESSION = 32;
// How many of the session's newest pings to scan when looking for the
// latest ping stamped with the ACTIVE leg's load (see the pin-source
// logic in listLiveSessions). At the mobile app's ping cadence this
// covers roughly the last half hour; if the load feed has been silent
// longer than that, the plain latest ping wins — it's fresher truth.
const ACTIVE_LEG_PIN_SCAN = 50;

type DerivedStatus = 'driving' | 'idle' | 'break' | 'off-duty';

/**
 * One dispatch leg in a session — what the UI calls a "trip card".
 *
 * The driver app stamps `sessionId` on a leg the moment it transitions to
 * ACTIVE (driver checks in at the pickup). Legs that never went ACTIVE
 * during this shift (e.g. canceled before the driver arrived) won't have
 * a sessionId and don't appear here.
 *
 * Stops are denormalized so the panel can render without an N+1 client
 * query just to label "Pickup — Western Outfitters". Only the leg's
 * start/end stops are included; intermediate stops live on the load's
 * own loadStops table.
 */
export type TripInfo = {
  legId: Id<'dispatchLegs'>;
  loadId: Id<'loadInformation'>;
  loadInternalId: string;
  sequence: number;
  status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';

  startedAt: number | null; // First check-in event time; null if still PENDING
  endedAt: number | null;
  plannedStartAt: number | null;

  /** Start stop ("pickup") label fields. */
  startStop: {
    sequence: number;
    type: 'PICKUP' | 'DELIVERY' | 'DETOUR';
    referenceName: string | null;
    city: string | null;
    state: string | null;
  } | null;
  /** End stop ("delivery" or next pickup on multi-leg loads). */
  endStop: {
    sequence: number;
    type: 'PICKUP' | 'DELIVERY' | 'DETOUR';
    referenceName: string | null;
    city: string | null;
    state: string | null;
  } | null;
};

export type LiveSession = {
  sessionId: Id<'driverSessions'>;
  driverId: Id<'drivers'>;
  driverName: string;
  truckId: Id<'trucks'>;
  truckUnitId: string | null;
  truckMakeModel: string | null;
  truckPlate: string | null;

  startedAt: number;
  softCap10hAt?: number;
  softCap14hAt?: number;

  /** Derived live status — see header comment. */
  status: DerivedStatus;
  /** Free-text "Westbound on Hwy 99 · 4 min ago"-ish line for the row. */
  statusLoc: string;

  /** Latest GPS position. null if no pings yet on this shift. */
  latestLocation: {
    latitude: number;
    longitude: number;
    speed?: number;
    heading?: number;
    recordedAt: number;
  } | null;

  /** First GPS position of this shift — the "shift start" anchor. The
   *  map renders a green pin here when the driver is selected so the
   *  dispatcher can see where the shift began (typically a yard) vs.
   *  where the driver is now. null if no pings have come in yet. */
  startLocation: {
    latitude: number;
    longitude: number;
    recordedAt: number;
  } | null;

  /** Every dispatch leg stamped with this session, oldest-first.
   *  Drives the multi-trip TripsBody on the right rail. */
  trips: TripInfo[];

  /** Soft alert count — soft-cap hits + (future) HOS / hard-brake events. */
  incidents: number;
};

function deriveStatus(
  latest: { recordedAt: number; speed?: number } | null,
  nowMs: number
): { status: DerivedStatus; statusLoc: string } {
  if (!latest) {
    return { status: 'idle', statusLoc: 'No GPS pings yet on this shift' };
  }
  const ageMs = nowMs - latest.recordedAt;
  const ageMin = Math.max(0, Math.round(ageMs / 60000));
  const speedMph = latest.speed ?? 0;
  const stale = ageMs >= FIVE_MIN_MS;

  let status: DerivedStatus;
  let activity: string;
  if (stale) {
    status = 'idle';
    activity = 'Last GPS ping';
  } else if (speedMph >= DRIVING_SPEED_THRESHOLD_MPH) {
    status = 'driving';
    activity = bucketSpeedLabel(speedMph);
  } else {
    status = 'idle';
    activity = 'Stationary';
  }
  const ago =
    ageMin === 0
      ? 'just now'
      : ageMin === 1
        ? '1 min ago'
        : `${ageMin} min ago`;
  return { status, statusLoc: `${activity} · ${ago}` };
}

function bucketSpeedLabel(mph: number): string {
  if (mph >= 55) return `Highway ${Math.round(mph)} mph`;
  if (mph >= 30) return `Driving ${Math.round(mph)} mph`;
  return `Local roads ${Math.round(mph)} mph`;
}

/**
 * Load every leg stamped with `sessionId`, enriched with each leg's
 * load + start/end stop denormalized labels. Sorted by leg.startedAt
 * (PENDING legs — no startedAt yet — sort to the back).
 *
 * Uses the `by_session` index on dispatchLegs added 2026-05 specifically
 * for this query.
 */
async function loadTripsForSession(
  ctx: QueryCtx,
  sessionId: Id<'driverSessions'>,
  callerOrgId: string
): Promise<TripInfo[]> {
  const legs = await ctx.db
    .query('dispatchLegs')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .take(MAX_LEGS_PER_SESSION);

  const out: TripInfo[] = [];
  for (const leg of legs) {
    // Org guard — defensive, the by_session index already scopes by
    // sessionId which is org-scoped, but a stale cross-org leg would
    // be a confusing leak.
    if (leg.workosOrgId !== callerOrgId) continue;
    const [load, startStop, endStop] = await Promise.all([
      ctx.db.get(leg.loadId),
      ctx.db.get(leg.startStopId),
      ctx.db.get(leg.endStopId),
    ]);
    if (!load) continue;

    out.push({
      legId: leg._id,
      loadId: leg.loadId,
      loadInternalId: load.internalId,
      sequence: leg.sequence,
      status: leg.status,
      startedAt: leg.startedAt ?? null,
      endedAt: leg.endedAt ?? null,
      plannedStartAt: leg.plannedStartAt ?? null,
      startStop: startStop
        ? {
            sequence: startStop.sequenceNumber,
            type: startStop.stopType,
            referenceName: startStop.referenceName ?? null,
            city: startStop.city ?? null,
            state: startStop.state ?? null,
          }
        : null,
      endStop: endStop
        ? {
            sequence: endStop.sequenceNumber,
            type: endStop.stopType,
            referenceName: endStop.referenceName ?? null,
            city: endStop.city ?? null,
            state: endStop.state ?? null,
          }
        : null,
    });
  }

  // PENDING (never went ACTIVE) → sort by plannedStartAt;
  // others → by startedAt; tie-break on leg.sequence
  out.sort((a, b) => {
    const aT = a.startedAt ?? a.plannedStartAt ?? Number.MAX_SAFE_INTEGER;
    const bT = b.startedAt ?? b.plannedStartAt ?? Number.MAX_SAFE_INTEGER;
    if (aT !== bT) return aT - bT;
    return a.sequence - b.sequence;
  });

  return out;
}

// ============================================================================
// LIST: active sessions enriched for the live ops page
// ============================================================================

export const listLiveSessions = query({
  args: {},
  handler: async (ctx) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const nowMs = Date.now();

    const sessions = await ctx.db
      .query('driverSessions')
      .withIndex('by_org_active', (q) =>
        q.eq('organizationId', callerOrgId).eq('status', 'active')
      )
      .collect();

    const out: LiveSession[] = [];
    for (const session of sessions) {
      const [driver, truck] = await Promise.all([
        ctx.db.get(session.driverId),
        ctx.db.get(session.truckId),
      ]);
      if (!driver) continue; // driver row removed — skip (data integrity)

      const [latest, firstPing, trips] = await Promise.all([
        ctx.db
          .query('driverLatestLocation')
          .withIndex('by_driver', (q) => q.eq('driverId', session.driverId))
          .first(),
        // Shift-start anchor — first ping recorded under this session.
        // One index-bounded read; if the shift hasn't seen any pings yet
        // this just returns null and the map renders no start pin.
        ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q) =>
            q.eq('sessionId', session._id),
          )
          .order('asc')
          .first(),
        loadTripsForSession(ctx, session._id, callerOrgId),
      ]);

      // ── Pin source ──
      // The pin the dispatcher sees must follow the load being tracked.
      // A session can receive pings from more than one source (driver
      // phone + truck telematics + a secondary device), and
      // driverLatestLocation is simply whichever wrote last. When a leg
      // is ACTIVE, prefer the newest ping stamped with that leg's load —
      // an untagged stream (e.g. a device pinging from a yard while the
      // truck tracks the load elsewhere) must not move the pin. Bounded
      // to the newest ACTIVE_LEG_PIN_SCAN session pings so a long-dead
      // load feed falls back to the plain latest ping.
      let pinSource: {
        latitude: number;
        longitude: number;
        speed?: number;
        heading?: number;
        recordedAt: number;
      } | null = latest;
      const activeLeg = trips.find((t) => t.status === 'ACTIVE');
      if (activeLeg) {
        const recent = await ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q) =>
            q.eq('sessionId', session._id),
          )
          .order('desc')
          .take(ACTIVE_LEG_PIN_SCAN);
        const legPing = recent.find(
          (p) =>
            p.loadId === activeLeg.loadId &&
            (activeLeg.startedAt == null ||
              p.recordedAt >= activeLeg.startedAt),
        );
        if (legPing) pinSource = legPing;
      }

      const { status, statusLoc } = deriveStatus(pinSource, nowMs);

      // Incident count = HOS soft-cap hits today. Will grow as more event
      // streams land (hard-brake from Samsara, geofence violations, etc.).
      let incidents = 0;
      if (session.softCap10hAt) incidents++;
      if (session.softCap14hAt) incidents++;

      out.push({
        sessionId: session._id,
        driverId: session.driverId,
        driverName: `${driver.firstName} ${driver.lastName}`.trim(),
        truckId: session.truckId,
        truckUnitId: truck?.unitId ?? null,
        truckMakeModel: truck
          ? [truck.make, truck.model].filter(Boolean).join(' ') || null
          : null,
        truckPlate: truck?.plate ?? null,

        startedAt: session.startedAt,
        softCap10hAt: session.softCap10hAt,
        softCap14hAt: session.softCap14hAt,

        status,
        statusLoc,

        latestLocation: pinSource
          ? {
              latitude: pinSource.latitude,
              longitude: pinSource.longitude,
              speed: pinSource.speed,
              heading: pinSource.heading,
              recordedAt: pinSource.recordedAt,
            }
          : null,

        startLocation: firstPing
          ? {
              latitude: firstPing.latitude,
              longitude: firstPing.longitude,
              recordedAt: firstPing.recordedAt,
            }
          : null,

        trips,
        incidents,
      });
    }

    return out;
  },
});

// ============================================================================
// LIST: paginated GPS pings for one session (polyline + GPS pings tab)
// ============================================================================

/**
 * Paginated pings for the selected driver. Replaces the old
 * `take(2000)`-capped listRecentPings — long / chatty shifts now load
 * page-by-page on the client via `usePaginatedQuery`.
 *
 * Order is DESC (newest first) for two reasons:
 *
 *   1. The hot section of the polyline is the most recent route. We want
 *      the first page to give the dispatcher the freshest data fast,
 *      then progressively reveal older history.
 *
 *   2. With DESC + cursor-based pagination, Convex serves new pings into
 *      the FIRST page (since `now > prior_now`). The first page is
 *      reactive to inserts on the index, which means new live pings
 *      flow into the polyline without explicit polling — exactly what
 *      we need for the "polyline keeps growing while you watch" feel.
 *
 * `sinceMs` is intentionally NOT a server arg — Convex pagination needs
 * stable query args (changing them would invalidate the cursor chain).
 * Past vs live windowing is purely a client decision via the consumer's
 * `usePaginatedQuery` arg set.
 */
export const listSessionPingsPage = query({
  args: {
    sessionId: v.id('driverSessions'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.organizationId !== callerOrgId) {
      return {
        page: [] as PingRow[],
        isDone: true,
        continueCursor: '',
      };
    }

    const result = await ctx.db
      .query('driverLocations')
      .withIndex('by_session_time', (q) =>
        q.eq('sessionId', args.sessionId),
      )
      .order('desc')
      .paginate(args.paginationOpts);

    return {
      page: result.page.map(rowToPing),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

type PingRow = {
  id: Id<'driverLocations'>;
  recordedAt: number;
  latitude: number;
  longitude: number;
  speed: number;
  heading: number | undefined;
  loadId: Id<'loadInformation'> | null;
  trackingType: string;
};

function rowToPing(r: Doc<'driverLocations'>): PingRow {
  return {
    id: r._id,
    recordedAt: r.recordedAt,
    latitude: r.latitude,
    longitude: r.longitude,
    speed: r.speed ?? 0,
    heading: r.heading,
    loadId: r.loadId ?? null,
    trackingType: r.trackingType,
  };
}

// ============================================================================
// LIST: past-day sessions for replay mode
// ============================================================================

export type PastSessionRow = {
  sessionId: Id<'driverSessions'>;
  driverId: Id<'drivers'>;
  driverName: string;
  truckId: Id<'trucks'>;
  truckUnitId: string | null;
  truckMakeModel: string | null;
  truckPlate: string | null;

  startedAt: number;
  endedAt: number | null;
  /** Total elapsed shift time in ms (uses endedAt or "still active" cap). */
  activeMs: number;

  startLocation: { latitude: number; longitude: number } | null;
  endLocation: { latitude: number; longitude: number } | null;

  /** Crude distance estimate from successive pings via Haversine. */
  distanceKm: number;
  /** Total pings recorded under this session. */
  pingCount: number;
  /** Soft-cap warnings hit during the shift. */
  incidents: number;
  /** Legs that ran during this shift, in chronological order. */
  trips: TripInfo[];
};

/**
 * Past-day replay — list sessions that STARTED on the given civil day.
 *
 * Strict-by-start: a shift appears on its `startedAt` day, never on a
 * neighbouring day, even if it spilled past midnight. This matches how
 * dispatchers usually think about "what happened on Monday" — they want
 * the shifts they kicked off on Monday, not the tail of a Sunday-night
 * run. Pings outside `[startMs, endMs]` still load when that shift is
 * selected (the polyline is the full shift, not the day window).
 *
 * The caller passes `ymdKey` as `YYYY-M-D` (month & day NOT zero-padded
 * to match the JS `Date.getMonth()`/`getDate()` shape the frontend
 * already builds with `sameDayKey`).
 *
 * Active sessions are excluded from past-day results — they belong in
 * the LIVE view. (An active shift that started yesterday will appear
 * there, not here.)
 *
 * The query is "best-effort" — it doesn't reconstruct routes server-side
 * (that would cost N×pings per call). It returns just enough to render
 * the past-day sidebar + map pins. For the selected driver's full
 * polyline, the client paginates `listSessionPingsPage` instead.
 */
export const listSessionsForDay = query({
  args: { ymdKey: v.string() },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const { startMs, endMs } = parseYmdKey(args.ymdKey);
    if (startMs == null || endMs == null) return [] as PastSessionRow[];

    // Strict: only sessions whose startedAt fell inside the day window.
    const candidates = await ctx.db
      .query('driverSessions')
      .withIndex('by_org_started', (q) =>
        q
          .eq('organizationId', callerOrgId)
          .gte('startedAt', startMs)
          .lte('startedAt', endMs)
      )
      .collect();

    const out: PastSessionRow[] = [];
    for (const session of candidates) {
      // Exclude shifts still in progress — they belong in the LIVE view.
      if (session.status === 'active') continue;
      const sessEnd = session.endedAt ?? Date.now();

      // Cheap: index-only reads for first + last ping (one each, no scan).
      // Distance + ping count are deferred to client-side once the user
      // actually selects this driver — the past-day overview doesn't need
      // them, and computing them upfront for every driver was the main
      // source of slow loads.
      const [driver, truck, trips, firstPing, lastPing] = await Promise.all([
        ctx.db.get(session.driverId),
        ctx.db.get(session.truckId),
        loadTripsForSession(ctx, session._id, callerOrgId),
        ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q) =>
            q.eq('sessionId', session._id)
          )
          .order('asc')
          .first(),
        ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q) =>
            q.eq('sessionId', session._id)
          )
          .order('desc')
          .first(),
      ]);
      if (!driver) continue;

      const startLoc = firstPing
        ? { latitude: firstPing.latitude, longitude: firstPing.longitude }
        : null;
      const endLoc = lastPing
        ? { latitude: lastPing.latitude, longitude: lastPing.longitude }
        : null;

      let incidents = 0;
      if (session.softCap10hAt) incidents++;
      if (session.softCap14hAt) incidents++;

      out.push({
        sessionId: session._id,
        driverId: session.driverId,
        driverName: `${driver.firstName} ${driver.lastName}`.trim(),
        truckId: session.truckId,
        truckUnitId: truck?.unitId ?? null,
        truckMakeModel: truck
          ? [truck.make, truck.model].filter(Boolean).join(' ') || null
          : null,
        truckPlate: truck?.plate ?? null,
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? null,
        activeMs: sessEnd - session.startedAt,
        startLocation: startLoc,
        endLocation: endLoc,
        // Distance + ping count are derived client-side once the user
        // selects the driver and `listSessionPingsPage` paginates in.
        // Left as 0 here so the sidebar row + header stats still render
        // — a hint banner would be louder than helpful.
        distanceKm: 0,
        pingCount: 0,
        incidents,
        trips,
      });
    }
    return out;
  },
});

/**
 * Tell the date picker which past days have data. Returns an array of
 * `YYYY-M-D` keys (last 30 days) where at least one completed session
 * exists. Cheap — index-backed range scan, no enrichment.
 */
export const listDaysWithData = query({
  args: {},
  handler: async (ctx) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const lookbackMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const sessions = await ctx.db
      .query('driverSessions')
      .withIndex('by_org_started', (q) =>
        q.eq('organizationId', callerOrgId).gte('startedAt', lookbackMs)
      )
      .collect();
    const days = new Set<string>();
    for (const s of sessions) {
      const d = new Date(s.startedAt);
      days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
    return Array.from(days);
  },
});

// ============================================================================
// HELPERS (intentionally kept in this file — too small to justify a module)
// ============================================================================

/** Parse a frontend `sameDayKey` (`YYYY-M-D`, month/day NOT zero-padded)
 *  into start/end millisecond bounds in local server time. */
function parseYmdKey(
  key: string
): { startMs: number | null; endMs: number | null } {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(key);
  if (!m) return { startMs: null, endMs: null };
  const year = Number(m[1]);
  const month = Number(m[2]); // 0-indexed by JS convention — frontend already passes it that way
  const day = Number(m[3]);
  const start = new Date(year, month, day, 0, 0, 0, 0).getTime();
  const end = new Date(year, month, day, 23, 59, 59, 999).getTime();
  return { startMs: start, endMs: end };
}

function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
