import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import type { FunctionReference } from 'convex/server';
import type { Doc } from '../_generated/dataModel';
import type { ActionCtx, MutationCtx } from '../_generated/server';
import { laneAddressesByPosition } from '../fourKitesUtils';
import { laneBindingsByPosition } from '../lib/facilityMatch';
import { getActiveFacilities, resolveStopFacilityLink } from '../lib/facilityLink';
import { getLoadFacets } from '../lib/loadFacets';

/**
 * Migration: backfill addresses + facility links onto EXISTING load stops.
 *
 * The Phase 1–3 import fixes (lane-address inheritance, facility matching,
 * pin snapping) only apply to loads created after they shipped. This
 * migration retrofits already-imported loads with the same logic:
 *
 *   1. Address fill — stops with an empty address inherit the contract
 *      lane's street address by position (same all-or-nothing alignment
 *      guard as the live import). Applied to ALL stops, including
 *      completed ones: address text is display-only.
 *   2. Facility link — stops without a facilityId run the same lane-
 *      binding + proximity/address matcher as the live import. Applied to
 *      ALL stops including completed ones ON PURPOSE: linked historical
 *      stops carry real driver check-in/checkout GPS fixes, which is
 *      exactly the evidence pool the "suggested pin" verification uses.
 *   3. Coordinate snap — ONLY on stops that are still Pending (not
 *      checked in) on Open/Assigned loads, and only per the live snap
 *      rule (VERIFIED facility pin, or stop had no coordinates at all).
 *      Completed stops' coordinates are historical record and are never
 *      touched.
 *
 * Run:
 *   npx convex run migrations/007_backfill_stop_enrichment:dryRun
 *   npx convex run migrations/007_backfill_stop_enrichment:apply
 *
 * Both paginate the whole loadInformation table; dryRun reports what
 * WOULD change without writing. Re-running apply is safe (idempotent:
 * only empty addresses and unlinked stops are considered).
 */

const BATCH_SIZE = 50;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['migrations/007_backfill_stop_enrichment'];
type _Ref = FunctionReference<'mutation' | 'query', 'internal'>;
void (null as unknown as _Ref);

interface BatchStats {
  loadsScanned: number;
  loadsTouched: number;
  addressesFilled: number;
  facilitiesLinked: number;
  coordsSnapped: number;
}

async function findLaneForLoad(
  ctx: MutationCtx,
  load: Doc<'loadInformation'>,
): Promise<Doc<'contractLanes'> | null> {
  const facets = await getLoadFacets(ctx, load._id);
  if (!facets.hcr) return null;

  // Mirror the sync's two-gate lookup: exact HCR+trip, then HCR wildcard.
  for (const trip of [facets.trip, '*']) {
    if (!trip) continue;
    const lane = await ctx.db
      .query('contractLanes')
      .withIndex('by_org_hcr_trip', (q) =>
        q.eq('workosOrgId', load.workosOrgId).eq('hcr', facets.hcr!).eq('tripNumber', trip),
      )
      .filter((q) => q.and(q.eq(q.field('isDeleted'), false), q.eq(q.field('isActive'), true)))
      .first();
    if (lane) return lane;
  }
  return null;
}

async function enrichLoad(
  ctx: MutationCtx,
  load: Doc<'loadInformation'>,
  dryRun: boolean,
  stats: BatchStats,
): Promise<void> {
  const allStops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', load._id))
    .collect();
  // Detours are driver-created at their own GPS position — nothing to fix.
  const stops = allStops
    .filter((s) => s.stopType !== 'DETOUR')
    .sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  if (stops.length === 0) return;

  const needsWork = stops.some(
    (s) => !(s.address && s.address.trim()) || !s.facilityId,
  );
  if (!needsWork) return;

  const facilities = await getActiveFacilities(ctx, load.customerId);
  const lane = await findLaneForLoad(ctx, load);

  const shapes = stops.map((s) => ({ sequence: s.sequenceNumber, city: s.city }));
  const laneAddresses = laneAddressesByPosition(lane?.stops, shapes);
  const laneBindings = laneBindingsByPosition(lane?.stops, shapes);

  let touched = false;
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];
    const patch: Record<string, unknown> = {};

    if (!(stop.address && stop.address.trim()) && laneAddresses[i]) {
      patch.address = laneAddresses[i];
      stats.addressesFilled++;
    }

    if (!stop.facilityId && facilities.length > 0) {
      const link = resolveStopFacilityLink(
        {
          city: stop.city,
          state: stop.state,
          postalCode: stop.postalCode,
          latitude: stop.latitude,
          longitude: stop.longitude,
        },
        facilities,
        laneBindings[i],
      );
      if (link) {
        patch.facilityId = link.facilityId;
        stats.facilitiesLinked++;
        // Coordinates only move on stops a driver hasn't reached, on loads
        // still in flight — completed stops are pay-bearing history.
        const stopMutable =
          !stop.checkedInAt &&
          (!stop.status || stop.status === 'Pending') &&
          (load.status === 'Open' || load.status === 'Assigned');
        if (stopMutable && link.latitude !== undefined && link.longitude !== undefined) {
          patch.latitude = link.latitude;
          patch.longitude = link.longitude;
          stats.coordsSnapped++;
        }
      }
    }

    if (Object.keys(patch).length > 0) {
      touched = true;
      if (!dryRun) {
        await ctx.db.patch(stop._id, { ...patch, updatedAt: Date.now() });
      }
    }
  }
  if (touched) stats.loadsTouched++;
}

export const processBatch = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    dryRun: v.boolean(),
  },
  returns: v.object({
    loadsScanned: v.number(),
    loadsTouched: v.number(),
    addressesFilled: v.number(),
    facilitiesLinked: v.number(),
    coordsSnapped: v.number(),
    isDone: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query('loadInformation')
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });

    const stats: BatchStats = {
      loadsScanned: 0,
      loadsTouched: 0,
      addressesFilled: 0,
      facilitiesLinked: 0,
      coordsSnapped: 0,
    };
    for (const load of result.page) {
      stats.loadsScanned++;
      await enrichLoad(ctx, load, args.dryRun, stats);
    }

    return {
      ...stats,
      isDone: result.isDone,
      nextCursor: result.isDone ? null : result.continueCursor,
    };
  },
});

const summaryValidator = v.object({
  loadsScanned: v.number(),
  loadsTouched: v.number(),
  addressesFilled: v.number(),
  facilitiesLinked: v.number(),
  coordsSnapped: v.number(),
  batches: v.number(),
});

async function drive(ctx: ActionCtx, dryRun: boolean) {
  const total = {
    loadsScanned: 0,
    loadsTouched: 0,
    addressesFilled: 0,
    facilitiesLinked: 0,
    coordsSnapped: 0,
    batches: 0,
  };
  let cursor: string | null = null;
  const MAX_ITERATIONS = 20_000;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch: any = await ctx.runMutation(self.processBatch, {
      cursor: cursor ?? undefined,
      dryRun,
    });
    total.batches++;
    total.loadsScanned += batch.loadsScanned;
    total.loadsTouched += batch.loadsTouched;
    total.addressesFilled += batch.addressesFilled;
    total.facilitiesLinked += batch.facilitiesLinked;
    total.coordsSnapped += batch.coordsSnapped;
    if (batch.isDone) break;
    cursor = batch.nextCursor;
  }
  return total;
}

export const dryRun = internalAction({
  args: {},
  returns: summaryValidator,
  handler: async (ctx) => {
    const summary = await drive(ctx, true);
    console.log('[007 dryRun]', JSON.stringify(summary));
    return summary;
  },
});

export const apply = internalAction({
  args: {},
  returns: summaryValidator,
  handler: async (ctx) => {
    const summary = await drive(ctx, false);
    console.log('[007 apply]', JSON.stringify(summary));
    return summary;
  },
});
