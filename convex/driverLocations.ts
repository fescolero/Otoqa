import { v } from 'convex/values';
import {
  query,
  mutation,
  internalQuery,
  internalMutation,
  internalAction,
} from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';

// ============================================
// DRIVER LOCATION TRACKING
// For helicopter view and route history polylines
// ============================================

// ============================================
// PUBLIC MUTATIONS
// ============================================

/**
 * Batch insert locations from mobile app
 * Called every 5 minutes when tracking is active
 */
export const batchInsertLocations = mutation({
  args: {
    locations: v.array(
      v.object({
        driverId: v.id('drivers'),
        loadId: v.id('loadInformation'),
        latitude: v.float64(),
        longitude: v.float64(),
        accuracy: v.optional(v.float64()),
        speed: v.optional(v.float64()),
        heading: v.optional(v.float64()),
        trackingType: v.literal('LOAD_ROUTE'),
        recordedAt: v.float64(),
      })
    ),
    organizationId: v.string(),
  },
  returns: v.object({ inserted: v.number() }),
  handler: async (ctx, args) => {
    // Verify authentication
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error('Not authenticated');
    }

    const now = Date.now();
    let inserted = 0;
    let skippedDriver = 0;
    let skippedOrgMismatch = 0;
    let skippedLoad = 0;
    let skippedDuplicate = 0;

    for (const loc of args.locations) {
      const driver = await ctx.db.get(loc.driverId);
      if (!driver || driver.isDeleted) {
        skippedDriver++;
        continue;
      }
      if (driver.organizationId !== args.organizationId) {
        skippedOrgMismatch++;
        continue;
      }

      const load = await ctx.db.get(loc.loadId);
      if (!load) {
        skippedLoad++;
        continue;
      }

      // Server-side dedup: skip if a point with the same loadId and
      // recordedAt already exists (catches duplicate syncs from client)
      const existing = await ctx.db
        .query('driverLocations')
        .withIndex('by_load', (q) => q.eq('loadId', loc.loadId))
        .filter((q) => q.eq(q.field('recordedAt'), loc.recordedAt))
        .first();
      if (existing) {
        skippedDuplicate++;
        continue;
      }

      await ctx.db.insert('driverLocations', {
        driverId: loc.driverId,
        loadId: loc.loadId,
        organizationId: args.organizationId,
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
    }

    if (skippedDriver > 0 || skippedOrgMismatch > 0 || skippedLoad > 0 || skippedDuplicate > 0) {
      console.warn(
        `[batchInsertLocations] Skipped ${skippedDriver + skippedOrgMismatch + skippedLoad + skippedDuplicate}/${args.locations.length} points:`,
        `driver=${skippedDriver}, orgMismatch=${skippedOrgMismatch} (passed="${args.organizationId}"), load=${skippedLoad}, duplicate=${skippedDuplicate}`
      );
    }

    return { inserted };
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

/**
 * Get recent route for a driver (for showing current trip progress)
 * Returns last N hours of location data
 */
export const getRecentRouteForDriver = query({
  args: {
    driverId: v.id('drivers'),
    hoursBack: v.optional(v.number()),
    nowMs: v.number(),
  },
  returns: v.array(
    v.object({
      latitude: v.float64(),
      longitude: v.float64(),
      loadId: v.id('loadInformation'),
      recordedAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    const hours = args.hoursBack ?? 24;
    const cutoff = args.nowMs - hours * 60 * 60 * 1000;

    const locations = await ctx.db
      .query('driverLocations')
      .withIndex('by_driver_time', (q) =>
        q.eq('driverId', args.driverId).gte('recordedAt', cutoff)
      )
      .order('asc')
      .collect();

    return locations.map((loc) => ({
      latitude: loc.latitude,
      longitude: loc.longitude,
      loadId: loc.loadId,
      recordedAt: loc.recordedAt,
    }));
  },
});

/**
 * Check if a driver is currently being tracked
 */
export const isDriverBeingTracked = query({
  args: { driverId: v.id('drivers'), nowMs: v.number() },
  returns: v.object({
    isTracking: v.boolean(),
    lastLocation: v.optional(
      v.object({
        latitude: v.float64(),
        longitude: v.float64(),
        loadId: v.id('loadInformation'),
        recordedAt: v.float64(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    // Check for location in last 10 minutes
    const cutoff = args.nowMs - 10 * 60 * 1000;

    const recentLocation = await ctx.db
      .query('driverLocations')
      .withIndex('by_driver_time', (q) =>
        q.eq('driverId', args.driverId).gte('recordedAt', cutoff)
      )
      .order('desc')
      .first();

    if (recentLocation) {
      return {
        isTracking: true,
        lastLocation: {
          latitude: recentLocation.latitude,
          longitude: recentLocation.longitude,
          loadId: recentLocation.loadId,
          recordedAt: recentLocation.recordedAt,
        },
      };
    }

    return { isTracking: false };
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
      loadId: v.id('loadInformation'),
      organizationId: v.string(),
      latitude: v.float64(),
      longitude: v.float64(),
      accuracy: v.optional(v.float64()),
      speed: v.optional(v.float64()),
      heading: v.optional(v.float64()),
      trackingType: v.literal('LOAD_ROUTE'),
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
