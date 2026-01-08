import { internalMutation } from '../_generated/server';
import { v } from 'convex/values';

/**
 * Migration: Backfill Dispatch Legs for Existing Loads
 * 
 * This migration creates dispatchLegs for existing loads that are not "Open".
 * Per the design document:
 * - Creates legs with driverId: null (we cannot invent history)
 * - Sets status based on load status (Completed -> COMPLETED, others -> ACTIVE)
 * - Skips loads with < 2 stops (can't create valid leg)
 * - Skips loads that already have legs
 * 
 * Run this migration after deploying the new schema.
 */

/**
 * Run the migration for a single organization
 * Use this for controlled rollout
 */
export const migrateOrganization = internalMutation({
  args: {
    workosOrgId: v.string(),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .filter((q) => q.neq(q.field('status'), 'Open'))
      .collect();

    const results = {
      total: loads.length,
      created: 0,
      skipped: 0,
      skippedReasons: [] as string[],
    };

    for (const load of loads) {
      // Check if leg already exists
      const existingLeg = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .first();

      if (existingLeg) {
        results.skipped++;
        results.skippedReasons.push(`Load ${load.internalId}: Already has leg`);
        continue;
      }

      // Get stops for this load
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();

      if (stops.length < 2) {
        results.skipped++;
        results.skippedReasons.push(`Load ${load.internalId}: Less than 2 stops`);
        continue;
      }

      const sortedStops = stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const firstStop = sortedStops[0];
      const lastStop = sortedStops[sortedStops.length - 1];

      // Determine leg status based on load status
      let legStatus: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED' = 'ACTIVE';
      if (load.status === 'Completed') {
        legStatus = 'COMPLETED';
      } else if (load.status === 'Canceled') {
        legStatus = 'CANCELED';
      }

      if (!args.dryRun) {
        const now = Date.now();
        await ctx.db.insert('dispatchLegs', {
          loadId: load._id,
          driverId: undefined, // Cannot invent history - null driver
          truckId: undefined,
          trailerId: undefined,
          sequence: 1,
          startStopId: firstStop._id,
          endStopId: lastStop._id,
          legLoadedMiles: load.effectiveMiles ?? 0,
          legEmptyMiles: 0,
          status: legStatus,
          workosOrgId: load.workosOrgId,
          createdAt: now,
          updatedAt: now,
        });
      }

      results.created++;
    }

    return results;
  },
});

/**
 * Run the migration for ALL organizations
 * Use with caution - better to migrate org by org
 */
export const migrateAll = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    limit: v.optional(v.number()), // Process in batches
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 100;

    // Get all non-Open loads that don't have legs yet
    const loads = await ctx.db
      .query('loadInformation')
      .filter((q) => q.neq(q.field('status'), 'Open'))
      .take(limit);

    const results = {
      processed: 0,
      created: 0,
      skipped: 0,
      errors: [] as string[],
    };

    for (const load of loads) {
      results.processed++;

      try {
        // Check if leg already exists
        const existingLeg = await ctx.db
          .query('dispatchLegs')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .first();

        if (existingLeg) {
          results.skipped++;
          continue;
        }

        // Get stops
        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();

        if (stops.length < 2) {
          results.skipped++;
          continue;
        }

        const sortedStops = stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        const firstStop = sortedStops[0];
        const lastStop = sortedStops[sortedStops.length - 1];

        let legStatus: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED' = 'ACTIVE';
        if (load.status === 'Completed') legStatus = 'COMPLETED';
        else if (load.status === 'Canceled') legStatus = 'CANCELED';

        if (!args.dryRun) {
          const now = Date.now();
          await ctx.db.insert('dispatchLegs', {
            loadId: load._id,
            driverId: undefined,
            truckId: undefined,
            trailerId: undefined,
            sequence: 1,
            startStopId: firstStop._id,
            endStopId: lastStop._id,
            legLoadedMiles: load.effectiveMiles ?? 0,
            legEmptyMiles: 0,
            status: legStatus,
            workosOrgId: load.workosOrgId,
            createdAt: now,
            updatedAt: now,
          });
        }

        results.created++;
      } catch (error) {
        results.errors.push(`Load ${load._id}: ${error}`);
      }
    }

    return {
      ...results,
      hasMore: loads.length === limit,
      message: loads.length === limit 
        ? `Processed ${limit} loads. Run again to continue.`
        : `Migration complete. Processed ${results.processed} loads.`,
    };
  },
});

/**
 * Check migration status
 */
export const checkMigrationStatus = internalMutation({
  args: {
    workosOrgId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Count loads by status
    const allLoads = args.workosOrgId
      ? await ctx.db
          .query('loadInformation')
          .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId!))
          .collect()
      : await ctx.db.query('loadInformation').collect();
    
    const nonOpenLoads = allLoads.filter((l) => l.status !== 'Open');

    // Count legs
    const legs = args.workosOrgId
      ? await ctx.db
          .query('dispatchLegs')
          .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId!))
          .collect()
      : await ctx.db.query('dispatchLegs').collect();

    // Find loads without legs
    const loadsWithLegs = new Set(legs.map((l) => l.loadId));
    const loadsWithoutLegs = nonOpenLoads.filter((l) => !loadsWithLegs.has(l._id));

    return {
      totalLoads: allLoads.length,
      nonOpenLoads: nonOpenLoads.length,
      totalLegs: legs.length,
      loadsMissingLegs: loadsWithoutLegs.length,
      migrationComplete: loadsWithoutLegs.length === 0,
      sampleMissingLoads: loadsWithoutLegs.slice(0, 5).map((l) => ({
        id: l._id,
        internalId: l.internalId,
        status: l.status,
      })),
    };
  },
});
