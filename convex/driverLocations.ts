import { v } from 'convex/values';
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  MutationCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';

// ============================================
// DRIVER LOCATION TRACKING
// For helicopter view and route history polylines
// ============================================

// ============================================
// SHARED INGEST HELPER
// ============================================

/**
 * Shape of a single ping as accepted by the batch-insert mutations.
 *
 * Invariants (enforced below):
 *   - At least one of { loadId, sessionId } must be present.
 *   - trackingType must match attachment:
 *       LOAD_ROUTE     ↔ loadId present  (driver actively on a load)
 *       SESSION_ROUTE  ↔ loadId absent   (on-shift but not on a load)
 *   - If both loadId and sessionId present, trackingType must be LOAD_ROUTE.
 *   - sessionId (if present) must belong to the claimed driver in the claimed org.
 */
const pingValidator = v.object({
  driverId: v.id('drivers'),
  loadId: v.optional(v.id('loadInformation')),
  sessionId: v.optional(v.id('driverSessions')),
  latitude: v.float64(),
  longitude: v.float64(),
  accuracy: v.optional(v.float64()),
  speed: v.optional(v.float64()),
  heading: v.optional(v.float64()),
  trackingType: v.union(v.literal('LOAD_ROUTE'), v.literal('SESSION_ROUTE')),
  recordedAt: v.float64(),
});

type PingInput = {
  driverId: Id<'drivers'>;
  loadId?: Id<'loadInformation'>;
  sessionId?: Id<'driverSessions'>;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  heading?: number;
  trackingType: 'LOAD_ROUTE' | 'SESSION_ROUTE';
  recordedAt: number;
};

/**
 * Insert a batch of GPS pings with org scoping, session/load consistency
 * validation, batch-boundary dedup, and scheduled geofence evaluation.
 *
 * Dedup strategy: a per-ping dedup read cost 50× more than what's needed
 * for the common case. Instead we group pings by their dedup key (sessionId
 * when present, else loadId), query the latest stored ping for that key
 * once, and only fall back to per-ping dedup if the new batch overlaps
 * the stored window (the "genuine retry" scenario, which is rare).
 */
/**
 * Structured outcome of a batch insert. The mobile client uses these to
 * decide which queued rows to mark synced (and stop retrying).
 *
 *   • inserted              — newly stored. Mark synced.
 *   • duplicates            — server already had this exact (sessionId,
 *                             recordedAt) or (loadId, recordedAt). Data is
 *                             on the server already. Mark synced.
 *   • permanentlyRejected   — driver/org/load/session not found, shape
 *                             invariant violated, or clock-skew guard
 *                             tripped. Will NEVER succeed on retry. Mark
 *                             synced + telemetry. Includes skew
 *                             rejections — see rejectedIndices below.
 *   • transientlyRejected   — reserved for future use (none today). Do
 *                             NOT mark synced; let the client retry.
 *   • rejectedIndices       — zero-based indices into the incoming
 *                             `locations` array for pings that were
 *                             rejected specifically by the clock-skew
 *                             guard. The client flags these as
 *                             `permanentlyFailed` on the local queue
 *                             (retained for forensic inspection until
 *                             the 48h age purge), rather than removing
 *                             them as it does for other permanent
 *                             rejections. Other permanent rejections
 *                             (driver/org/session/shape) do NOT appear
 *                             here — they flow through the scalar
 *                             `permanentlyRejected` count and are
 *                             removed from the local queue as before.
 *
 * Invariant: inserted + duplicates + permanentlyRejected + transientlyRejected
 *            === pings.length (modulo bugs — telemetry surfaces drift).
 */
type IngestOutcome = {
  inserted: number;
  duplicates: number;
  permanentlyRejected: number;
  transientlyRejected: number;
  rejectedIndices: number[];
};

// Clock-skew guard thresholds. Tuned so:
//   • Future > 5min:  covers RTC / NTP drift on consumer hardware. A real
//                     driver's phone shouldn't ever record a timestamp
//                     more than a few seconds ahead of the server; 5 min
//                     is comfortably above that noise floor.
//   • Past > 48h:     matches MAX_PING_AGE_MS in mobile/location-tracking.ts.
//                     A ping older than 48h was already going to be purged
//                     client-side; rejecting it here prevents storing a
//                     stale ping whose ordering would confuse geofence
//                     evaluation and the dispatcher freshness heuristic.
const SKEW_FUTURE_MS = 5 * 60 * 1000;
const SKEW_PAST_MS = 48 * 60 * 60 * 1000;

async function ingestBatch(
  ctx: MutationCtx,
  pings: PingInput[],
  orgId: string
): Promise<IngestOutcome> {
  const now = Date.now();
  let inserted = 0;
  let skippedDriver = 0;
  let skippedOrgMismatch = 0;
  let skippedLoad = 0;
  let skippedSession = 0;
  let skippedShape = 0;
  let skippedDuplicate = 0;
  let skippedSkew = 0;
  // Indices (in the original `pings` array) of pings rejected by the
  // clock-skew guard. Returned so the client can mark those specific
  // local rows `permanentlyFailed` instead of removing them outright —
  // retained for forensic inspection until the 48h age purge sweeps
  // them up.
  const rejectedIndices: number[] = [];

  // Cache per-batch to avoid re-reads when multiple pings share a driver.
  const driverCache = new Map<Id<'drivers'>, Doc<'drivers'> | null>();
  const sessionCache = new Map<Id<'driverSessions'>, Doc<'driverSessions'> | null>();
  const loadCache = new Map<Id<'loadInformation'>, Doc<'loadInformation'> | null>();

  const getDriver = async (id: Id<'drivers'>) => {
    if (!driverCache.has(id)) driverCache.set(id, await ctx.db.get(id));
    return driverCache.get(id)!;
  };
  const getSession = async (id: Id<'driverSessions'>) => {
    if (!sessionCache.has(id)) sessionCache.set(id, await ctx.db.get(id));
    return sessionCache.get(id)!;
  };
  const getLoad = async (id: Id<'loadInformation'>) => {
    if (!loadCache.has(id)) loadCache.set(id, await ctx.db.get(id));
    return loadCache.get(id)!;
  };

  // First pass: per-ping validation. Build the "valid" list for dedup + insert.
  const valid: PingInput[] = [];
  for (let idx = 0; idx < pings.length; idx++) {
    const loc = pings[idx];

    // Clock-skew guard — runs first. A ping with a garbage timestamp
    // would poison downstream logic (dedup on recordedAt, geofence
    // evaluation on the "latest" ping, dispatcher freshness checks
    // that compare `recordedAt` against wall-clock "now"), so reject
    // before anything else touches it.
    const futureSkewMs = loc.recordedAt - now;
    const pastSkewMs = now - loc.recordedAt;
    if (futureSkewMs > SKEW_FUTURE_MS) {
      skippedSkew++;
      rejectedIndices.push(idx);
      console.warn(
        `[driverLocations.ingestBatch] tracking_skewed_ping_rejected ` +
          `driverId=${loc.driverId} skewMs=${futureSkewMs} direction=future`,
      );
      continue;
    }
    if (pastSkewMs > SKEW_PAST_MS) {
      skippedSkew++;
      rejectedIndices.push(idx);
      console.warn(
        `[driverLocations.ingestBatch] tracking_skewed_ping_rejected ` +
          `driverId=${loc.driverId} skewMs=${pastSkewMs} direction=past`,
      );
      continue;
    }

    // Shape invariants
    if (!loc.loadId && !loc.sessionId) {
      skippedShape++;
      continue;
    }
    if (loc.loadId && loc.trackingType !== 'LOAD_ROUTE') {
      skippedShape++;
      continue;
    }
    if (!loc.loadId && loc.trackingType !== 'SESSION_ROUTE') {
      skippedShape++;
      continue;
    }

    const driver = await getDriver(loc.driverId);
    if (!driver || driver.isDeleted) {
      skippedDriver++;
      continue;
    }
    if (driver.organizationId !== orgId) {
      skippedOrgMismatch++;
      continue;
    }

    if (loc.sessionId) {
      const session = await getSession(loc.sessionId);
      if (!session) {
        skippedSession++;
        continue;
      }
      if (session.driverId !== loc.driverId || session.organizationId !== orgId) {
        skippedSession++;
        continue;
      }
      // Quietly accept pings for sessions that have ended — they may be
      // late-arriving background syncs. We still store them so history is
      // complete, but they won't trigger the evaluator (scheduled below
      // only when an ACTIVE leg exists).
    }

    if (loc.loadId) {
      const load = await getLoad(loc.loadId);
      if (!load) {
        skippedLoad++;
        continue;
      }
    }

    valid.push(loc);
  }

  // Batch-boundary dedup. Group by sessionId (new mode) or loadId (legacy).
  // For each group, read the latest stored ping once; if the batch starts
  // after that timestamp there's no possible overlap, so skip the per-ping
  // dedup reads entirely.
  //
  // Dedup caveat (documented, intentionally permissive): the batch-boundary
  // shortcut assumes one active device per (sessionId|loadId) at a time.
  // With a single device, the ping queue's timestamp-based ids (see
  // mobile/lib/location-queue.ts:43) all but guarantee monotonic
  // recordedAt within a batch; collisions there would indicate a client
  // bug. With two devices reporting against the same sessionId, both can
  // independently sample a GPS fix at the same millisecond — a genuine
  // cross-device dup. We observe here (below) but do not reject, so we
  // don't surprise any unintentional multi-device users while the rate
  // is measured.
  const sessionGroups = new Map<Id<'driverSessions'>, PingInput[]>();
  const legacyLoadGroups = new Map<Id<'loadInformation'>, PingInput[]>();

  for (const loc of valid) {
    if (loc.sessionId) {
      const list = sessionGroups.get(loc.sessionId) ?? [];
      list.push(loc);
      sessionGroups.set(loc.sessionId, list);
    } else if (loc.loadId) {
      const list = legacyLoadGroups.get(loc.loadId) ?? [];
      list.push(loc);
      legacyLoadGroups.set(loc.loadId, list);
    }
  }

  // Observe intra-batch duplicates BEFORE dedup — the "clean boundary"
  // shortcut (below) will happily insert them all, so the telemetry here
  // is the only way to measure how often this happens. If the rate
  // exceeds 0.1% of inserts over a 7-day window, the § 6.4 plan note
  // says to revisit and add per-ping dedup. Until then: observe only.
  let internalDupCount = 0;
  for (const [sessionId, group] of sessionGroups) {
    const seen = new Set<number>();
    let groupDups = 0;
    for (const p of group) {
      if (seen.has(p.recordedAt)) groupDups++;
      else seen.add(p.recordedAt);
    }
    if (groupDups > 0) {
      internalDupCount += groupDups;
      console.warn(
        `[driverLocations.ingestBatch] location_queue_internal_dup_observed ` +
          `count=${groupDups} sessionId=${sessionId}`,
      );
    }
  }
  for (const [loadId, group] of legacyLoadGroups) {
    const seen = new Set<number>();
    let groupDups = 0;
    for (const p of group) {
      if (seen.has(p.recordedAt)) groupDups++;
      else seen.add(p.recordedAt);
    }
    if (groupDups > 0) {
      internalDupCount += groupDups;
      console.warn(
        `[driverLocations.ingestBatch] location_queue_internal_dup_observed ` +
          `count=${groupDups} loadId=${loadId}`,
      );
    }
  }

  const insertPing = async (loc: PingInput) => {
    await ctx.db.insert('driverLocations', {
      driverId: loc.driverId,
      loadId: loc.loadId,
      sessionId: loc.sessionId,
      organizationId: orgId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      trackingType: loc.trackingType,
      recordedAt: loc.recordedAt,
      createdAt: now,
    });
    inserted++;
  };

  // Session-keyed groups
  for (const [sessionId, group] of sessionGroups) {
    const earliest = Math.min(...group.map((p) => p.recordedAt));
    const latestStored = await ctx.db
      .query('driverLocations')
      .withIndex('by_session_time', (q) => q.eq('sessionId', sessionId))
      .order('desc')
      .first();

    if (!latestStored || latestStored.recordedAt < earliest) {
      // Clean boundary — bulk insert without per-ping dedup.
      for (const loc of group) await insertPing(loc);
    } else {
      // Overlap detected. Per-ping dedup only for pings inside the window.
      for (const loc of group) {
        if (loc.recordedAt > latestStored.recordedAt) {
          await insertPing(loc);
          continue;
        }
        const existing = await ctx.db
          .query('driverLocations')
          .withIndex('by_session_time', (q) =>
            q.eq('sessionId', sessionId).eq('recordedAt', loc.recordedAt)
          )
          .first();
        if (existing) {
          skippedDuplicate++;
          continue;
        }
        await insertPing(loc);
      }
    }
  }

  // Legacy loadId-only groups (no sessionId — pre-rollout flow)
  for (const [loadId, group] of legacyLoadGroups) {
    const earliest = Math.min(...group.map((p) => p.recordedAt));
    const latestStored = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', loadId))
      .order('desc')
      .first();

    if (!latestStored || latestStored.recordedAt < earliest) {
      for (const loc of group) await insertPing(loc);
    } else {
      for (const loc of group) {
        if (loc.recordedAt > latestStored.recordedAt) {
          await insertPing(loc);
          continue;
        }
        const existing = await ctx.db
          .query('driverLocations')
          .withIndex('by_load', (q) =>
            q.eq('loadId', loadId).eq('recordedAt', loc.recordedAt)
          )
          .first();
        if (existing) {
          skippedDuplicate++;
          continue;
        }
        await insertPing(loc);
      }
    }
  }

  // Schedule geofence evaluation for each unique (sessionId, loadId) pair
  // whose driver currently has an ACTIVE leg for that load. Only the latest
  // ping per pair is evaluated — earlier pings are history that the frontier
  // flags would no-op on anyway.
  const evaluatorTargets = new Map<string, PingInput>(); // key: sessionId|loadId
  for (const loc of valid) {
    if (!loc.sessionId || !loc.loadId) continue;
    const key = `${loc.sessionId}|${loc.loadId}`;
    const prev = evaluatorTargets.get(key);
    if (!prev || prev.recordedAt < loc.recordedAt) {
      evaluatorTargets.set(key, loc);
    }
  }

  for (const loc of evaluatorTargets.values()) {
    // Only schedule if the driver has an ACTIVE leg for this load. This
    // prevents evaluator fanout for legs that are PENDING/COMPLETED or
    // for sessions that lost their leg mid-batch.
    const activeLeg = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', loc.driverId).eq('status', 'ACTIVE'))
      .filter((q) => q.eq(q.field('loadId'), loc.loadId!))
      .first();
    if (!activeLeg) continue;

    await ctx.scheduler.runAfter(0, internal.geofenceEvaluator.evaluateLatestPing, {
      loadId: loc.loadId!,
      ping: {
        latitude: loc.latitude,
        longitude: loc.longitude,
        recordedAt: loc.recordedAt,
      },
    });
  }

  const skippedTotal =
    skippedDriver +
    skippedOrgMismatch +
    skippedLoad +
    skippedSession +
    skippedShape +
    skippedDuplicate +
    skippedSkew;
  if (skippedTotal > 0) {
    console.warn(
      `[driverLocations.ingestBatch] Skipped ${skippedTotal}/${pings.length}:`,
      `driver=${skippedDriver}, orgMismatch=${skippedOrgMismatch} (passed="${orgId}"),`,
      `load=${skippedLoad}, session=${skippedSession}, shape=${skippedShape},`,
      `dup=${skippedDuplicate}, skew=${skippedSkew}, internalDup=${internalDupCount}`
    );
  }

  // Categorize skips for the client. Everything except duplicates is
  // permanent — these conditions don't heal on retry. Reserved
  // transientlyRejected bucket stays at 0 for now; if we later add a
  // transient failure mode (e.g. rate-limit / temporary server error
  // surfaced via this path), we can route it here without changing the
  // contract.
  const permanentlyRejected =
    skippedDriver +
    skippedOrgMismatch +
    skippedLoad +
    skippedSession +
    skippedShape +
    skippedSkew;

  return {
    inserted,
    duplicates: skippedDuplicate,
    permanentlyRejected,
    transientlyRejected: 0,
    rejectedIndices,
  };
}

// ============================================
// PUBLIC MUTATIONS
// ============================================

/**
 * Batch insert locations from mobile app (Clerk-authenticated path).
 * Accepts both the legacy loadId-only shape and the new sessionId shape.
 */
export const batchInsertLocations = mutation({
  args: {
    locations: v.array(pingValidator),
    organizationId: v.string(),
  },
  returns: v.object({
    inserted: v.number(),
    duplicates: v.number(),
    permanentlyRejected: v.number(),
    transientlyRejected: v.number(),
    rejectedIndices: v.array(v.number()),
  }),
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');
    return ingestBatch(ctx, args.locations, args.organizationId);
  },
});

/**
 * Internal mutation for inserting locations from the mobile HTTP endpoint.
 * Skips Clerk auth — the HTTP endpoint validates a static API key instead.
 * Same ingest logic as batchInsertLocations minus the identity check.
 */
export const internalBatchInsertLocations = internalMutation({
  args: {
    locations: v.array(pingValidator),
    organizationId: v.string(),
  },
  returns: v.object({
    inserted: v.number(),
    duplicates: v.number(),
    permanentlyRejected: v.number(),
    transientlyRejected: v.number(),
    rejectedIndices: v.array(v.number()),
  }),
  handler: async (ctx, args) => {
    return ingestBatch(ctx, args.locations, args.organizationId);
  },
});

// ============================================
// PUBLIC QUERIES
// ============================================

/**
 * Get latest location for all active drivers (helicopter view)
 * Returns drivers who have reported location in the last 30 minutes
 */
export const getActiveDriverLocations = query({
  args: { organizationId: v.string(), nowMs: v.number() },
  returns: v.array(
    v.object({
      driverId: v.id('drivers'),
      driverName: v.string(),
      latitude: v.float64(),
      longitude: v.float64(),
      accuracy: v.optional(v.float64()),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      loadId: v.id('loadInformation'),
      loadInternalId: v.string(),
      trackingType: v.string(),
      recordedAt: v.float64(),
      truckUnitId: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    // Get locations from last 30 minutes (active tracking)
    const cutoff = args.nowMs - 30 * 60 * 1000;

    const recentLocations = await ctx.db
      .query('driverLocations')
      .withIndex('by_org_time', (q) =>
        q.eq('organizationId', args.organizationId).gte('recordedAt', cutoff)
      )
      .order('desc')
      .collect();

    // Get latest per driver (dedup)
    const latestByDriver = new Map<Id<'drivers'>, Doc<'driverLocations'>>();
    for (const loc of recentLocations) {
      if (!latestByDriver.has(loc.driverId)) {
        latestByDriver.set(loc.driverId, loc);
      }
    }

    // Enrich with driver and load info
    const results: Array<{
      driverId: Id<'drivers'>;
      driverName: string;
      latitude: number;
      longitude: number;
      accuracy?: number;
      speed?: number;
      heading?: number;
      loadId: Id<'loadInformation'>;
      loadInternalId: string;
      trackingType: string;
      recordedAt: number;
      truckUnitId?: string;
    }> = [];

    for (const loc of latestByDriver.values()) {
      // Session-only pings (no loadId) aren't included in this view — it's a
      // load-centric feed. They still flow to driverLocations but surface in
      // other queries (session history, dispatcher freshness).
      if (!loc.loadId) continue;

      const driver = await ctx.db.get(loc.driverId);
      const load = await ctx.db.get(loc.loadId);

      if (driver && !driver.isDeleted && load) {
        // Get truck info if available
        let truckUnitId: string | undefined;
        if (driver.currentTruckId) {
          const truck = await ctx.db.get(driver.currentTruckId);
          if (truck && !truck.isDeleted) {
            truckUnitId = truck.unitId;
          }
        }

        results.push({
          driverId: loc.driverId,
          driverName: `${driver.firstName} ${driver.lastName}`,
          latitude: loc.latitude,
          longitude: loc.longitude,
          accuracy: loc.accuracy,
          speed: loc.speed,
          heading: loc.heading,
          loadId: loc.loadId,
          loadInternalId: load.internalId,
          trackingType: loc.trackingType,
          recordedAt: loc.recordedAt,
          truckUnitId,
        });
      }
    }

    return results;
  },
});

/**
 * Get route history for a specific load (polyline data)
 * Returns all location points for drawing the route on a map
 */
export const getRouteHistoryForLoad = query({
  args: { loadId: v.id('loadInformation') },
  returns: v.array(
    v.object({
      latitude: v.float64(),
      longitude: v.float64(),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      recordedAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const locations = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .order('asc')
      .collect();

    return locations.map((loc) => ({
      latitude: loc.latitude,
      longitude: loc.longitude,
      speed: loc.speed,
      heading: loc.heading,
      recordedAt: loc.recordedAt,
    }));
  },
});

/**
 * Get detailed route history for GPS diagnostics page.
 * Returns all fields including accuracy and createdAt (for sync delay analysis).
 */
export const getDetailedRouteHistoryForLoad = query({
  args: { loadId: v.id('loadInformation') },
  returns: v.array(
    v.object({
      _id: v.id('driverLocations'),
      latitude: v.float64(),
      longitude: v.float64(),
      accuracy: v.optional(v.float64()),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      recordedAt: v.float64(),
      createdAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const locations = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .order('asc')
      .collect();

    return locations.map((loc) => ({
      _id: loc._id,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      recordedAt: loc.recordedAt,
      createdAt: loc.createdAt,
    }));
  },
});

// ============================================
// INTERNAL QUERIES (for archival cron)
// ============================================

/**
 * Get locations older than cutoff time for archival
 */
export const getLocationsOlderThan = internalQuery({
  args: {
    cutoffTime: v.float64(),
    limit: v.number(),
  },
  returns: v.array(
    v.object({
      _id: v.id('driverLocations'),
      driverId: v.id('drivers'),
      // Optional: legacy rows always have it; session-only pings don't.
      loadId: v.optional(v.id('loadInformation')),
      sessionId: v.optional(v.id('driverSessions')),
      organizationId: v.string(),
      latitude: v.float64(),
      longitude: v.float64(),
      accuracy: v.optional(v.float64()),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      trackingType: v.union(v.literal('LOAD_ROUTE'), v.literal('SESSION_ROUTE')),
      recordedAt: v.float64(),
      createdAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    // Get old locations using createdAt index
    const oldLocations = await ctx.db
      .query('driverLocations')
      .withIndex('by_org_created')
      .filter((q) => q.lt(q.field('createdAt'), args.cutoffTime))
      .take(args.limit);

    return oldLocations.map((loc) => ({
      _id: loc._id,
      driverId: loc.driverId,
      loadId: loc.loadId,
      sessionId: loc.sessionId,
      organizationId: loc.organizationId,
      latitude: loc.latitude,
      longitude: loc.longitude,
      accuracy: loc.accuracy,
      speed: loc.speed,
      heading: loc.heading,
      trackingType: loc.trackingType,
      recordedAt: loc.recordedAt,
      createdAt: loc.createdAt,
    }));
  },
});

// ============================================
// INTERNAL MUTATIONS (for archival cron)
// ============================================

/**
 * Delete locations that have been archived
 */
export const deleteArchivedLocations = internalMutation({
  args: {
    ids: v.array(v.id('driverLocations')),
  },
  returns: v.object({ deleted: v.number() }),
  handler: async (ctx, args) => {
    let deleted = 0;
    for (const id of args.ids) {
      await ctx.db.delete(id);
      deleted++;
    }
    return { deleted };
  },
});

// ============================================
// ARCHIVAL — orchestrator moved to convex/gpsArchive.ts
// This file keeps only the helper query + mutation it calls.
// ============================================

/**
 * Write an audit row after a successful archive upload. Internal; only the
 * gpsArchive action calls this, between the S3 PUT and the row delete. If
 * the process crashes between upload and this write, the next cron run
 * will re-upload the same range — idempotent because S3 object keys are
 * deterministic per (orgId, date, hour).
 */
export const logArchiveUpload = internalMutation({
  args: {
    organizationId: v.string(),
    date: v.string(),
    hour: v.number(),
    s3Bucket: v.string(),
    s3Key: v.string(),
    rowCount: v.number(),
    byteCount: v.number(),
    minRecordedAt: v.number(),
    maxRecordedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert('gpsArchiveLog', {
      ...args,
      archivedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Called by the retrieval action (gpsArchive.getArchivedPositionFiles) to
 * find which archive files cover a requested [from, to] time window.
 *
 * Lives here (not in gpsArchive.ts) because gpsArchive.ts uses `'use node'`
 * and can only contain actions. Keeps the query close to the other archive
 * database helpers.
 */
export const listArchivedFilesInWindow = internalQuery({
  args: {
    organizationId: v.string(),
    from: v.number(),
    to: v.number(),
  },
  returns: v.array(
    v.object({
      date: v.string(),
      hour: v.number(),
      s3Bucket: v.string(),
      s3Key: v.string(),
      rowCount: v.number(),
      byteCount: v.number(),
      minRecordedAt: v.number(),
      maxRecordedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    // Range-scan by the archive log's maxRecordedAt — every file whose
    // maxRecordedAt is ≥ args.from MIGHT overlap the window. We further
    // filter by minRecordedAt in-memory to exclude files whose recorded
    // range falls entirely past args.to.
    const candidates = await ctx.db
      .query('gpsArchiveLog')
      .withIndex('by_org_window', (q) =>
        q.eq('organizationId', args.organizationId).gte('maxRecordedAt', args.from)
      )
      .collect();

    return candidates
      .filter((f) => f.minRecordedAt <= args.to)
      .map((f) => ({
        date: f.date,
        hour: f.hour,
        s3Bucket: f.s3Bucket,
        s3Key: f.s3Key,
        rowCount: f.rowCount,
        byteCount: f.byteCount,
        minRecordedAt: f.minRecordedAt,
        maxRecordedAt: f.maxRecordedAt,
      }));
  },
});
