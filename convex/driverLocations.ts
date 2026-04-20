import { v } from 'convex/values';
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
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
async function ingestBatch(
  ctx: MutationCtx,
  pings: PingInput[],
  orgId: string
): Promise<{ inserted: number }> {
  const now = Date.now();
  let inserted = 0;
  let skippedDriver = 0;
  let skippedOrgMismatch = 0;
  let skippedLoad = 0;
  let skippedSession = 0;
  let skippedShape = 0;
  let skippedDuplicate = 0;

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
  for (const loc of pings) {
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
    skippedDuplicate;
  if (skippedTotal > 0) {
    console.warn(
      `[driverLocations.ingestBatch] Skipped ${skippedTotal}/${pings.length}:`,
      `driver=${skippedDriver}, orgMismatch=${skippedOrgMismatch} (passed="${orgId}"),`,
      `load=${skippedLoad}, session=${skippedSession}, shape=${skippedShape}, dup=${skippedDuplicate}`
    );
  }

  return { inserted };
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
  returns: v.object({ inserted: v.number() }),
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
  returns: v.object({ inserted: v.number() }),
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
// ARCHIVAL ACTION (runs via cron)
// Archives old location data and deletes from hot storage
// ============================================

const RETENTION_DAYS = 90; // Keep 90 days in hot storage
const BATCH_SIZE = 5000; // Process in batches to avoid timeouts

/**
 * Archive old location data to cold storage (R2)
 * This action:
 * 1. Queries locations older than retention period
 * 2. Groups them by month
 * 3. Uploads to R2 as JSONL files (append mode)
 * 4. Deletes archived records from Convex
 *
 * Note: R2 upload is optional - if not configured, just deletes old records
 */
export const archiveOldLocations = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoffTime = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    console.log(
      `[LocationArchival] Starting archival for records older than ${new Date(cutoffTime).toISOString()}`
    );

    // Get old locations
    const oldLocations = await ctx.runQuery(
      internal.driverLocations.getLocationsOlderThan,
      {
        cutoffTime,
        limit: BATCH_SIZE,
      }
    );

    if (oldLocations.length === 0) {
      console.log('[LocationArchival] No records to archive');
      return null;
    }

    console.log(`[LocationArchival] Found ${oldLocations.length} records to archive`);

    // Group by organization and month for organized archival
    const groupedByOrgMonth = new Map<string, typeof oldLocations>();

    for (const loc of oldLocations) {
      const date = new Date(loc.recordedAt);
      const monthKey = `${loc.organizationId}/${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!groupedByOrgMonth.has(monthKey)) {
        groupedByOrgMonth.set(monthKey, []);
      }
      groupedByOrgMonth.get(monthKey)!.push(loc);
    }

    console.log(
      `[LocationArchival] Grouped into ${groupedByOrgMonth.size} org/month buckets`
    );

    // For now, just log what would be archived
    // R2 upload would happen here in production with proper credentials
    for (const [monthKey, locations] of groupedByOrgMonth) {
      console.log(
        `[LocationArchival] Would archive ${locations.length} records to ${monthKey}.jsonl`
      );

      // TODO: Implement R2 upload when credentials are configured
      // const jsonl = locations.map(l => JSON.stringify({
      //   driverId: l.driverId,
      //   loadId: l.loadId,
      //   organizationId: l.organizationId,
      //   latitude: l.latitude,
      //   longitude: l.longitude,
      //   accuracy: l.accuracy,
      //   speed: l.speed,
      //   heading: l.heading,
      //   recordedAt: l.recordedAt,
      //   archivedAt: Date.now(),
      // })).join('\n');
      //
      // await uploadToR2(`location-archives/${monthKey}.jsonl`, jsonl);
    }

    // Delete archived records from Convex
    const idsToDelete = oldLocations.map((l: { _id: Id<'driverLocations'> }) => l._id);
    const deleteResult = await ctx.runMutation(
      internal.driverLocations.deleteArchivedLocations,
      { ids: idsToDelete }
    );

    console.log(
      `[LocationArchival] Deleted ${deleteResult.deleted} records from hot storage`
    );

    // If there might be more records, schedule another run
    if (oldLocations.length === BATCH_SIZE) {
      console.log(
        '[LocationArchival] Batch limit reached, more records may need archival'
      );
    }

    return null;
  },
});
