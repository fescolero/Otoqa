import { v } from 'convex/values';
import { internalQuery } from './_generated/server';
import { Id, Doc } from './_generated/dataModel';
// Session-per-leg resolution and the approach-window isolation policy
// live in lib/legTracking — shared with the FourKites push tooling.
import {
  resolveLegSession,
  legPickupAnchorMs,
  approachFloorMs,
} from './lib/legTracking';

// ============================================
// EXTERNAL TRACKING API - DATA LAYER
// Core data extraction, downsampling, field transform
// ============================================

// ============================================
// TYPES
// ============================================

// External-facing position (field allowlist applied)
const externalPositionValidator = v.object({
  latitude: v.number(),
  longitude: v.number(),
  speed: v.optional(v.number()),
  heading: v.optional(v.number()),
  accuracy: v.optional(v.number()),
  recordedAt: v.string(), // ISO 8601 UTC
});

// External-facing stop
const externalStopValidator = v.object({
  sequenceNumber: v.number(),
  stopType: v.string(),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  status: v.optional(v.string()),
  scheduledWindow: v.optional(v.object({
    begin: v.string(),
    end: v.string(),
  })),
  checkedInAt: v.optional(v.string()),
  checkedOutAt: v.optional(v.string()),
});

// External-facing status event
const externalEventValidator = v.object({
  eventType: v.string(),
  stopNumber: v.number(),
  timestamp: v.string(),
  latitude: v.optional(v.number()),
  longitude: v.optional(v.number()),
});

// ============================================
// LOAD RESOLUTION (flexible lookup)
// ============================================

/**
 * Resolve a load by flexible reference (externalLoadId, internalId, or orderNumber).
 * Returns the load document if found and authorized, null otherwise.
 * Performs BOLA check: load.workosOrgId must match the API key's org.
 */
export const resolveLoad = internalQuery({
  args: {
    ref: v.string(),
    refType: v.optional(v.union(v.literal('external'), v.literal('internal'), v.literal('order'))),
    workosOrgId: v.string(),
    environment: v.union(v.literal('sandbox'), v.literal('production')),
  },
  returns: v.union(
    v.object({
      loadId: v.string(), // Convex ID as string for external use
      internalId: v.string(),
      orderNumber: v.string(),
      externalLoadId: v.optional(v.string()),
      trackingStatus: v.string(),
      stopCount: v.optional(v.number()),
      firstStopDate: v.optional(v.string()),
      isSandbox: v.boolean(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    // Sandbox: query sandboxLoads table
    if (args.environment === 'sandbox') {
      return await resolveSandboxLoad(ctx, args.ref, args.refType, args.workosOrgId);
    }

    // Production: query loadInformation table
    return await resolveProductionLoad(ctx, args.ref, args.refType, args.workosOrgId);
  },
});

async function resolveProductionLoad(
  ctx: any,
  ref: string,
  refType: string | undefined,
  workosOrgId: string
) {
  let load: Doc<'loadInformation'> | null = null;

  // Auto-detect refType if not provided
  const effectiveRefType = refType || autoDetectRefType(ref);

  if (effectiveRefType === 'external') {
    load = await ctx.db
      .query('loadInformation')
      .withIndex('by_external_id', (q: any) =>
        q.eq('externalSource', 'FOURKITES').eq('externalLoadId', ref)
      )
      .first();
    // Also try without source filter if not found
    if (!load) {
      load = await ctx.db
        .query('loadInformation')
        .withIndex('by_external_id', (q: any) =>
          q.eq('externalSource', 'FourKites').eq('externalLoadId', ref)
        )
        .first();
    }
  } else if (effectiveRefType === 'internal') {
    load = await ctx.db
      .query('loadInformation')
      .withIndex('by_internal_id', (q: any) =>
        q.eq('workosOrgId', workosOrgId).eq('internalId', ref)
      )
      .unique();
  } else {
    // order
    load = await ctx.db
      .query('loadInformation')
      .withIndex('by_order_number', (q: any) =>
        q.eq('workosOrgId', workosOrgId).eq('orderNumber', ref)
      )
      .first();
  }

  if (!load) return null;

  // BOLA check: load must belong to the API key's org
  if (load.workosOrgId !== workosOrgId) return null;

  return {
    loadId: load._id as string,
    internalId: load.internalId,
    orderNumber: load.orderNumber,
    externalLoadId: load.externalLoadId,
    trackingStatus: load.trackingStatus,
    stopCount: load.stopCount,
    firstStopDate: load.firstStopDate,
    isSandbox: false,
  };
}

async function resolveSandboxLoad(
  ctx: any,
  ref: string,
  refType: string | undefined,
  workosOrgId: string
) {
  const load = await ctx.db
    .query('sandboxLoads')
    .withIndex('by_internal_id', (q: any) =>
      q.eq('workosOrgId', workosOrgId).eq('internalId', ref)
    )
    .first();

  if (!load) return null;
  if (load.workosOrgId !== workosOrgId) return null;

  return {
    loadId: load._id as string,
    internalId: load.internalId,
    orderNumber: load.orderNumber,
    externalLoadId: load.externalLoadId,
    trackingStatus: load.trackingStatus,
    stopCount: load.stopCount,
    firstStopDate: load.firstStopDate,
    isSandbox: true,
  };
}

/** Round a number to n decimal places, returning undefined if input is undefined. */
function round(value: number | undefined, decimals: number): number | undefined {
  if (value === undefined) return undefined;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function autoDetectRefType(ref: string): 'external' | 'internal' | 'order' {
  // FK- and LD- prefixes are internalId formats (e.g. FK-96790533, LD-12345)
  if (ref.startsWith('FK-') || ref.startsWith('fk-') || ref.startsWith('LD-') || ref.startsWith('ld-')) return 'internal';
  // Pure numeric strings are likely order numbers or external IDs
  if (/^\d+$/.test(ref)) return 'order';
  return 'internal'; // Default
}

// ============================================
// GPS POSITIONS (with 5-min downsampling)
// ============================================

/**
 * Get GPS positions for a load, downsampled to 5-minute intervals.
 * Works for both production and sandbox environments.
 */
export const getPositions = internalQuery({
  args: {
    loadId: v.string(),
    isSandbox: v.boolean(),
    since: v.optional(v.number()),  // epoch ms
    until: v.optional(v.number()),  // epoch ms
    limit: v.optional(v.number()),  // max 500, default 100
    // Downsample to N-second buckets (pick ping nearest each bucket midpoint).
    // 0 (default) = no downsampling, return raw device cadence. Capped at 600s
    // server-side. Re-publishers feeding sub-minute visibility platforms
    // should leave this at 0.
    downsampleSeconds: v.optional(v.number()),
  },
  returns: v.object({
    positions: v.array(externalPositionValidator),
    hasMore: v.boolean(),
    cursor: v.optional(v.string()),
    latestRecordedAt: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    const maxLimit = Math.min(args.limit ?? 100, 500);
    const until = args.until ?? Date.now();

    // Enforce max 7-day range
    const maxRange = 7 * 24 * 60 * 60 * 1000;
    const since = args.since ?? Math.max(0, until - maxRange);
    const effectiveUntil = until;

    let rawPositions: Array<{
      latitude: number;
      longitude: number;
      speed?: number;
      heading?: number;
      accuracy?: number;
      recordedAt: number;
    }>;

    if (args.isSandbox) {
      const positions = await ctx.db
        .query('sandboxPositions')
        .withIndex('by_load', (q: any) =>
          q
            .eq('sandboxLoadId', args.loadId as Id<'sandboxLoads'>)
            .gte('recordedAt', since)
        )
        .order('asc')
        .collect();

      rawPositions = positions
        .filter((p) => p.recordedAt <= effectiveUntil)
        .map((p) => ({
          latitude: p.latitude,
          longitude: p.longitude,
          speed: p.speed ?? undefined,
          heading: p.heading ?? undefined,
          accuracy: p.accuracy ?? undefined,
          recordedAt: p.recordedAt,
        }));
    } else {
      // Production path: union load-tagged pings (legacy + post-rollout
      // post-check-in) with session-tagged pings (post-rollout pre-check-in).
      //
      // Why this matters: before Phase 1, every ping carried loadId because
      // tracking only started at first check-in. After Phase 1, the driver
      // is on shift before they reach the load — those pings carry sessionId
      // only. The whole point of the rewrite was to surface those approach
      // pings to partners (FourKites) so the route doesn't appear to start
      // AT the location.
      //
      // For each leg of this load (handoffs may produce multiple), we look
      // up the leg's session window and pull pings within it. Then we union
      // with the load-tagged read and dedupe by _id.

      const loadIdId = args.loadId as Id<'loadInformation'>;

      // 1) All legs for this load — covers single-driver, relay, and any
      //    historical legs from before this driver's session existed.
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q: any) => q.eq('loadId', loadIdId))
        .collect();

      // 2) Build per-session windows. Session-per-leg resolution and the
      //    approach-window policy are lib/legTracking's (see its doc
      //    comments for the three resolution cases). A leg with no
      //    resolvable pickup anchor falls back to session.startedAt as
      //    the floor — preserves legacy behavior so partners don't lose
      //    all pings on un-backfilled or detour-only legs.
      const sessionWindows: Array<{
        sessionId: Id<'driverSessions'>;
        from: number;
        to: number;
      }> = [];
      for (const leg of legs) {
        const session = await resolveLegSession(ctx, leg);
        if (!session) continue;

        const floor = approachFloorMs(await legPickupAnchorMs(ctx, leg));
        const from = Math.max(since, session.startedAt, floor ?? Number.NEGATIVE_INFINITY);
        const to = Math.min(effectiveUntil, session.endedAt ?? effectiveUntil);
        if (from > to) continue;
        sessionWindows.push({ sessionId: session._id, from, to });
      }

      // 3) Pull session-scoped pings. .take(5000) per session is a safety
      //    ceiling — at 2-min cadence that's ~7 days of continuous tracking.
      const sessionPingsArrays = await Promise.all(
        sessionWindows.map((w) =>
          ctx.db
            .query('driverLocations')
            .withIndex('by_session_time', (q: any) =>
              q
                .eq('sessionId', w.sessionId)
                .gte('recordedAt', w.from)
                .lte('recordedAt', w.to)
            )
            .order('asc')
            .take(5000),
        ),
      );

      // 4) Pull load-tagged pings. Captures legacy (pre-rollout) data AND
      //    new post-check-in pings that have both loadId and sessionId.
      const loadTaggedPings = await ctx.db
        .query('driverLocations')
        .withIndex('by_load', (q: any) =>
          q.eq('loadId', loadIdId).gte('recordedAt', since)
        )
        .order('asc')
        .collect();
      const loadTaggedFiltered = loadTaggedPings.filter(
        (p) => p.recordedAt <= effectiveUntil,
      );

      // 5) Union by _id, then sort by recordedAt asc.
      const seen = new Set<string>();
      const merged: Array<{
        latitude: number;
        longitude: number;
        speed?: number;
        heading?: number;
        accuracy?: number;
        recordedAt: number;
      }> = [];
      const consume = (rows: typeof loadTaggedFiltered) => {
        for (const p of rows) {
          if (seen.has(p._id)) continue;
          seen.add(p._id);
          merged.push({
            latitude: p.latitude,
            longitude: p.longitude,
            speed: p.speed ?? undefined,
            heading: p.heading ?? undefined,
            accuracy: p.accuracy ?? undefined,
            recordedAt: p.recordedAt,
          });
        }
      };
      consume(loadTaggedFiltered);
      for (const arr of sessionPingsArrays) consume(arr);
      merged.sort((a, b) => a.recordedAt - b.recordedAt);

      rawPositions = merged;
    }

    // Optional downsampling. 0 = raw device cadence (default for sub-minute
    // visibility platforms). Capped at 600s to bound bucket-count blowup on
    // hostile inputs.
    const requestedDownsampleSec = args.downsampleSeconds ?? 0;
    const downsampleMs = Math.max(0, Math.min(requestedDownsampleSec, 600)) * 1000;
    const downsampled = downsampleMs > 0
      ? downsampleToInterval(rawPositions, downsampleMs)
      : rawPositions;

    // Paginate
    const page = downsampled.slice(0, maxLimit);
    const hasMore = downsampled.length > maxLimit;
    const latestRecordedAt = page.length > 0
      ? new Date(page[page.length - 1].recordedAt).toISOString()
      : undefined;

    return {
      positions: page.map((p) => ({
        latitude: round(p.latitude, 6)!,
        longitude: round(p.longitude, 6)!,
        speed: round(p.speed, 2),
        heading: round(p.heading, 2),
        accuracy: round(p.accuracy, 2),
        recordedAt: new Date(p.recordedAt).toISOString(),
      })),
      hasMore,
      cursor: hasMore ? new Date(page[page.length - 1].recordedAt).toISOString() : undefined,
      latestRecordedAt,
    };
  },
});

/**
 * Per-load latest-position resolver, shared by getLatestPosition (single)
 * and getLatestPositionsForLoads (batched). Pure ctx.db reads — safe to
 * call N times in parallel from one query.
 */
async function resolveLatestPositionForLoad(
  ctx: { db: any },
  loadId: string,
  isSandbox: boolean,
): Promise<any | null> {
  let position;
  if (isSandbox) {
    position = await ctx.db
      .query('sandboxPositions')
      .withIndex('by_load', (q: any) =>
        q.eq('sandboxLoadId', loadId as Id<'sandboxLoads'>)
      )
      .order('desc')
      .first();
  } else {
    const loadIdId = loadId as Id<'loadInformation'>;

    const loadTaggedLatest = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q: any) => q.eq('loadId', loadIdId))
      .order('desc')
      .first();

    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q: any) => q.eq('loadId', loadIdId))
      .collect();

    const sessionLatestArr = await Promise.all(
      legs.map(async (leg: any) => {
        const session = await resolveLegSession(ctx, leg);
        if (!session) return null;
        const sessionId = session._id;

        // No resolvable anchor → no floor (gte 0), matching the window
        // query's session-start fallback for legacy legs.
        const floor = approachFloorMs(await legPickupAnchorMs(ctx, leg)) ?? 0;
        return ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q: any) =>
            q.eq('sessionId', sessionId).gte('recordedAt', floor),
          )
          .order('desc')
          .first();
      }),
    );

    const candidates = [loadTaggedLatest, ...sessionLatestArr].filter(
      (p): p is NonNullable<typeof p> => p !== null && p !== undefined,
    );
    position = candidates.reduce<typeof candidates[number] | undefined>(
      (best, cur) => (best === undefined || cur.recordedAt > best.recordedAt ? cur : best),
      undefined,
    );
  }

  if (!position) return null;

  return {
    latitude: round(position.latitude, 6)!,
    longitude: round(position.longitude, 6)!,
    speed: round(position.speed, 2),
    heading: round(position.heading, 2),
    accuracy: round(position.accuracy, 2),
    recordedAt: new Date(position.recordedAt).toISOString(),
  };
}

/**
 * Get the latest position for a load.
 */
export const getLatestPosition = internalQuery({
  args: {
    loadId: v.string(),
    isSandbox: v.boolean(),
  },
  returns: v.union(externalPositionValidator, v.null()),
  handler: async (ctx, args) => {
    return resolveLatestPositionForLoad(ctx, args.loadId, args.isSandbox);
  },
});

/**
 * Batched variant of getLatestPosition — resolves N loads in one query
 * roundtrip. The caller (notably the FourKites push cron) was previously
 * doing one ctx.runQuery per load from a Node action, eating ~7ms × N in
 * Node↔V8 RPC overhead. By moving the iteration inside a single V8 query
 * we collapse that to one roundtrip; per-load reads happen in parallel
 * via Promise.all.
 *
 * Caller must chunk to keep the per-query read budget bounded (Convex
 * limit: 16k docs per query). At ~5–10 reads per load, a chunk size of
 * 200 stays under 2k reads in steady state.
 */
export const getLatestPositionsForLoads = internalQuery({
  args: {
    loadIds: v.array(v.string()),
    isSandbox: v.boolean(),
  },
  returns: v.array(
    v.object({
      loadId: v.string(),
      position: v.union(externalPositionValidator, v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    const positions = await Promise.all(
      args.loadIds.map((loadId) =>
        resolveLatestPositionForLoad(ctx, loadId, args.isSandbox),
      ),
    );
    return args.loadIds.map((loadId, i) => ({
      loadId,
      position: positions[i],
    }));
  },
});

// ============================================
// STOPS DATA
// ============================================

/**
 * Get stop details for a load (production only - sandbox has inline stops).
 */
export const getStops = internalQuery({
  args: {
    loadId: v.string(),
    isSandbox: v.boolean(),
    workosOrgId: v.string(),
  },
  returns: v.array(externalStopValidator),
  handler: async (ctx, args) => {
    if (args.isSandbox) {
      const load = await ctx.db.get(args.loadId as Id<'sandboxLoads'>);
      if (!load) return [];
      return load.stops.map((s) => ({
        sequenceNumber: s.sequenceNumber,
        stopType: s.stopType,
        city: s.city,
        state: s.state,
        status: s.status,
        scheduledWindow: {
          begin: s.scheduledWindowBegin,
          end: s.scheduledWindowEnd,
        },
        checkedInAt: s.checkedInAt,
        checkedOutAt: s.checkedOutAt,
      }));
    }

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_sequence', (q: any) =>
        q.eq('loadId', args.loadId as Id<'loadInformation'>)
      )
      .order('asc')
      .collect();

    return stops.map((s) => ({
      sequenceNumber: s.sequenceNumber,
      stopType: s.stopType,
      city: s.city,
      state: s.state,
      status: s.status,
      scheduledWindow: s.windowBeginTime && s.windowEndTime
        ? { begin: s.windowBeginTime, end: s.windowEndTime }
        : undefined,
      checkedInAt: s.checkedInAt,
      checkedOutAt: s.checkedOutAt,
    }));
  },
});

// ============================================
// STATUS EVENTS
// ============================================

/**
 * Generate status events from stop check-in/out data.
 */
export const getStatusEvents = internalQuery({
  args: {
    loadId: v.string(),
    isSandbox: v.boolean(),
    workosOrgId: v.string(),
  },
  returns: v.array(externalEventValidator),
  handler: async (ctx, args) => {
    const events: Array<{
      eventType: string;
      stopNumber: number;
      timestamp: string;
      latitude?: number;
      longitude?: number;
    }> = [];

    if (args.isSandbox) {
      const load = await ctx.db.get(args.loadId as Id<'sandboxLoads'>);
      if (!load) return [];

      for (const stop of load.stops) {
        if (stop.checkedInAt) {
          events.push({
            eventType: 'ARRIVED',
            stopNumber: stop.sequenceNumber,
            timestamp: stop.checkedInAt,
            latitude: round(stop.latitude, 6),
            longitude: round(stop.longitude, 6),
          });
        }
        if (stop.checkedOutAt) {
          const isLastStop = stop.sequenceNumber === load.stops.length;
          events.push({
            eventType: isLastStop ? 'DELIVERED' : 'DEPARTED',
            stopNumber: stop.sequenceNumber,
            timestamp: stop.checkedOutAt,
            latitude: round(stop.latitude, 6),
            longitude: round(stop.longitude, 6),
          });
        }
      }
    } else {
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_sequence', (q: any) =>
          q.eq('loadId', args.loadId as Id<'loadInformation'>)
        )
        .order('asc')
        .collect();

      const totalStops = stops.length;

      for (const stop of stops) {
        if (stop.checkedInAt) {
          events.push({
            eventType: 'ARRIVED',
            stopNumber: stop.sequenceNumber,
            timestamp: stop.checkedInAt,
            latitude: round(stop.checkinLatitude, 6),
            longitude: round(stop.checkinLongitude, 6),
          });
        }
        if (stop.checkedOutAt) {
          const isLastStop = stop.sequenceNumber === totalStops;
          events.push({
            eventType: isLastStop ? 'DELIVERED' : 'DEPARTED',
            stopNumber: stop.sequenceNumber,
            timestamp: stop.checkedOutAt,
            latitude: round(stop.checkoutLatitude, 6),
            longitude: round(stop.checkoutLongitude, 6),
          });
        }
      }
    }

    // Sort by timestamp
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return events;
  },
});

// ============================================
// LIST TRACKED LOADS
// ============================================

/**
 * List loads with active or recent tracking for an org.
 */
export const listTrackedLoads = internalQuery({
  args: {
    workosOrgId: v.string(),
    environment: v.union(v.literal('sandbox'), v.literal('production')),
    trackingStatusFilter: v.optional(v.string()), // "active" | "completed" | "all"
    limit: v.optional(v.number()),
  },
  returns: v.object({
    loads: v.array(v.object({
      loadRef: v.string(),
      internalId: v.string(),
      externalLoadId: v.optional(v.string()),
      externalSource: v.optional(v.string()),
      orderNumber: v.optional(v.string()),
      trackingStatus: v.string(),
      stopCount: v.optional(v.number()),
      firstStopDate: v.optional(v.string()),
    })),
    hasMore: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const maxLimit = Math.min(args.limit ?? 50, 100);
    const filter = args.trackingStatusFilter ?? 'active';

    if (args.environment === 'sandbox') {
      const sandboxQuery = filter === 'active'
        ? ctx.db.query('sandboxLoads')
            .withIndex('by_org_tracking_status', (q: any) =>
              q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'In Transit')
            )
        : ctx.db.query('sandboxLoads')
            .withIndex('by_org', (q: any) =>
              q.eq('workosOrgId', args.workosOrgId)
            );
      const loads = await sandboxQuery.take(maxLimit + 1);
      const page = loads.slice(0, maxLimit);
      return {
        loads: page.map((l) => ({
          loadRef: l.internalId,
          internalId: l.internalId,
          externalLoadId: l.externalLoadId,
          externalSource: undefined,
          orderNumber: l.orderNumber,
          trackingStatus: l.trackingStatus,
          stopCount: l.stopCount,
          firstStopDate: l.firstStopDate,
        })),
        hasMore: loads.length > maxLimit,
      };
    }

    // Production - use separate queries per filter to avoid type reassignment
    const prodQuery = filter === 'active'
      ? ctx.db.query('loadInformation')
          .withIndex('by_org_tracking_status', (q: any) =>
            q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'In Transit')
          )
      : filter === 'completed'
      ? ctx.db.query('loadInformation')
          .withIndex('by_org_tracking_status', (q: any) =>
            q.eq('workosOrgId', args.workosOrgId).eq('trackingStatus', 'Completed')
          )
      : ctx.db.query('loadInformation')
          .withIndex('by_organization', (q: any) =>
            q.eq('workosOrgId', args.workosOrgId)
          );

    const loads = await prodQuery.take(maxLimit + 1);
    const page = loads.slice(0, maxLimit);

    return {
      loads: page.map((l) => ({
        loadRef: l.internalId,
        internalId: l.internalId,
        externalLoadId: l.externalLoadId,
        externalSource: l.externalSource,
        orderNumber: l.orderNumber,
        trackingStatus: l.trackingStatus,
        stopCount: l.stopCount,
        firstStopDate: l.firstStopDate,
      })),
      hasMore: loads.length > maxLimit,
    };
  },
});

// ============================================
// DOWNSAMPLING (configurable interval)
// ============================================

interface RawPosition {
  latitude: number;
  longitude: number;
  speed?: number;
  heading?: number;
  accuracy?: number;
  recordedAt: number;
}

/**
 * Downsample positions to N-millisecond clock-aligned buckets. From each
 * bucket, pick the ping nearest the bucket midpoint. Default behavior in
 * getPositions is *no* downsampling (raw cadence) — this is only invoked
 * when the partner explicitly requests bucketing.
 */
function downsampleToInterval(
  positions: RawPosition[],
  intervalMs: number,
): RawPosition[] {
  if (positions.length === 0 || intervalMs <= 0) return positions;

  const buckets = new Map<number, RawPosition[]>();
  for (const p of positions) {
    const bucketKey = Math.floor(p.recordedAt / intervalMs) * intervalMs;
    let arr = buckets.get(bucketKey);
    if (!arr) {
      arr = [];
      buckets.set(bucketKey, arr);
    }
    arr.push(p);
  }

  const result: RawPosition[] = [];
  const sortedKeys = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const bucketKey of sortedKeys) {
    const points = buckets.get(bucketKey)!;
    const midpoint = bucketKey + intervalMs / 2;
    let closest = points[0];
    let closestDist = Math.abs(closest.recordedAt - midpoint);
    for (let i = 1; i < points.length; i++) {
      const dist = Math.abs(points[i].recordedAt - midpoint);
      if (dist < closestDist) {
        closest = points[i];
        closestDist = dist;
      }
    }
    result.push(closest);
  }
  return result;
}
