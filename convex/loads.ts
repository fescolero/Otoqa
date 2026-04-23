import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import type { MutationCtx } from './_generated/server';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { internal } from './_generated/api';
import { Doc, Id } from './_generated/dataModel';
import { paginationOptsValidator } from 'convex/server';
import { parseStopDateTime, syncLegsAffectedByStop } from './_helpers/timeUtils';
import { updateLoadCount } from './stats_helpers';
import {
  setLoadTag,
  removeAllTagsForLoad,
  syncFirstStopDateToTags,
  getLoadFacets,
} from './lib/loadFacets';

const loadStatusValidator = v.union(
  v.literal('Open'),
  v.literal('Assigned'),
  v.literal('Canceled'),
  v.literal('Completed'),
  v.literal('Expired'),
);

const cancellationReasonValidator = v.union(
  v.literal('DRIVER_BREAKDOWN'),
  v.literal('CUSTOMER_CANCELLED'),
  v.literal('EQUIPMENT_ISSUE'),
  v.literal('RATE_DISPUTE'),
  v.literal('WEATHER_CONDITIONS'),
  v.literal('CAPACITY_ISSUE'),
  v.literal('SCHEDULING_CONFLICT'),
  v.literal('OTHER'),
);

async function applyLoadStatusUpdate(
  ctx: MutationCtx,
  args: {
    loadId: Id<'loadInformation'>;
    status: 'Open' | 'Assigned' | 'Canceled' | 'Completed' | 'Expired';
    cancellationReason?:
      | 'DRIVER_BREAKDOWN'
      | 'CUSTOMER_CANCELLED'
      | 'EQUIPMENT_ISSUE'
      | 'RATE_DISPUTE'
      | 'WEATHER_CONDITIONS'
      | 'CAPACITY_ISSUE'
      | 'SCHEDULING_CONFLICT'
      | 'OTHER';
    cancellationNotes?: string;
    canceledBy?: string;
  },
) {
  const load = await ctx.db.get(args.loadId);
  if (!load) throw new Error('Load not found');

  const now = Date.now();
  const updates: Record<string, unknown> = {
    status: args.status,
    updatedAt: now,
  };

  if (args.status === 'Completed') {
    updates.trackingStatus = 'Completed';
    updates.deliveredAt = now;

    const carrierAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q: any) => q.eq('loadId', args.loadId))
      .collect();
    for (const ca of carrierAssignments) {
      if (ca.status === 'AWARDED' || ca.status === 'IN_PROGRESS') {
        await ctx.db.patch(ca._id, {
          status: 'COMPLETED' as const,
          completedAt: now,
          paymentStatus: ca.paymentStatus ?? ('PENDING' as const),
        });
      }
    }

    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q: any) => q.eq('loadId', args.loadId))
      .collect();
    for (const leg of legs) {
      if (leg.status !== 'COMPLETED' && leg.status !== 'CANCELED') {
        await ctx.db.patch(leg._id, {
          status: 'COMPLETED' as const,
          updatedAt: now,
        });
      }
    }
  } else if (args.status === 'Assigned') {
    if (load.trackingStatus === 'Pending') {
      updates.trackingStatus = 'In Transit';
    }
  } else if (args.status === 'Canceled') {
    updates.trackingStatus = 'Canceled';

    if (args.cancellationReason) {
      updates.cancellationReason = args.cancellationReason;
      updates.cancellationNotes = args.cancellationNotes;
      updates.canceledAt = now;
      updates.canceledBy = args.canceledBy;
    }

    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q: any) => q.eq('loadId', args.loadId))
      .collect();

    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          status: 'CANCELED',
          updatedAt: now,
        });

        const payables = await ctx.db
          .query('loadPayables')
          .withIndex('by_leg', (q: any) => q.eq('legId', leg._id))
          .collect();

        for (const payable of payables) {
          if (payable.sourceType === 'SYSTEM' && !payable.isLocked) {
            await ctx.db.delete(payable._id);
          }
        }
      }
    }
  } else if (args.status === 'Expired') {
    updates.trackingStatus = 'Canceled';

    // Cascade: a load can't expire while still holding open legs. Mirrors
    // the Canceled branch above. Prior to this cascade, expiring loads
    // accumulated orphan PENDING legs (closed out in migration 012).
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q: any) => q.eq('loadId', args.loadId))
      .collect();

    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          status: 'CANCELED',
          endReason: 'data_hygiene',
          endedAt: now,
          updatedAt: now,
        });

        const payables = await ctx.db
          .query('loadPayables')
          .withIndex('by_leg', (q: any) => q.eq('legId', leg._id))
          .collect();

        for (const payable of payables) {
          if (payable.sourceType === 'SYSTEM' && !payable.isLocked) {
            await ctx.db.delete(payable._id);
          }
        }
      }
    }
  } else if (args.status === 'Open') {
    updates.primaryDriverId = undefined;
    updates.primaryCarrierPartnershipId = undefined;
    updates.trackingStatus = 'Pending';

    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q: any) => q.eq('loadId', args.loadId))
      .collect();

    for (const leg of legs) {
      if (leg.status === 'PENDING') {
        await ctx.db.patch(leg._id, {
          driverId: undefined,
          truckId: undefined,
          trailerId: undefined,
          carrierPartnershipId: undefined,
          status: 'CANCELED',
          updatedAt: now,
        });

        const payables = await ctx.db
          .query('loadPayables')
          .withIndex('by_leg', (q: any) => q.eq('legId', leg._id))
          .collect();

        for (const payable of payables) {
          if (payable.sourceType === 'SYSTEM' && !payable.isLocked) {
            await ctx.db.delete(payable._id);
          }
        }
      }
    }
  }

  await ctx.db.patch(args.loadId, updates);

  return { load, previousStatus: load.status, nextStatus: args.status };
}

// Count loads by status for tab badges
// ✅ Optimized: Reads from aggregate table (1 read instead of 10,000+)
export const countLoadsByStatus = query({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.object({
    Open: v.number(),
    Assigned: v.number(),
    Delivered: v.number(),
    Canceled: v.number(),
    Expired: v.number(),
  }),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // Read from organizationStats aggregate table (1 read)
    const stats = await ctx.db
      .query('organizationStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    if (!stats) {
      return {
        Open: 0,
        Assigned: 0,
        Delivered: 0,
        Canceled: 0,
        Expired: 0,
      };
    }

    return {
      Open: stats.loadCounts.Open,
      Assigned: stats.loadCounts.Assigned,
      Delivered: stats.loadCounts.Completed,
      Canceled: stats.loadCounts.Canceled,
      Expired: stats.loadCounts.Expired ?? 0,
    };
  },
});

// Helper function to calculate effective miles
// Priority: manual > contract > imported > google
function calculateEffectiveMiles(
  manualMiles?: number,
  contractMiles?: number,
  importedMiles?: number,
  googleMiles?: number,
): number | undefined {
  if (manualMiles != null) return manualMiles;
  if (contractMiles != null) return contractMiles;
  if (importedMiles != null) return importedMiles;
  if (googleMiles != null) return googleMiles;
  return undefined;
}

/**
 * Sync the denormalized firstStopDate field on loadInformation.
 *
 * This is the SINGLE SOURCE OF TRUTH for keeping firstStopDate in sync.
 * Call this function whenever:
 * - A new load is created with stops
 * - Stop times are updated (especially windowBeginDate)
 * - Stops are synced from external sources (FourKites)
 *
 * @param ctx - Convex mutation context
 * @param loadId - ID of the load to sync
 * @returns The synced firstStopDate value (or undefined if no valid date)
 */
async function syncFirstStopDate(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
): Promise<string | undefined> {
  // Fetch all stops once — used to derive every denormalized field below.
  // This replaces the per-list-row N+1 queries that used to happen on
  // getLoads / enrichLoadFromLeg / enrichLoadDirectly just to compute
  // origin/destination/stopsCount on render.
  const allStops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q: any) => q.eq('loadId', loadId))
    .collect();
  allStops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  const firstStop = allStops.find((s) => s.sequenceNumber === 1) ?? allStops[0];
  const firstPickup = allStops.find((s) => s.stopType === 'PICKUP');
  const lastDelivery = [...allStops].reverse().find((s) => s.stopType === 'DELIVERY');

  // Extract and sanitize the date (YYYY-MM-DD, reject TBD / malformed).
  let firstStopDate: string | undefined = undefined;
  if (firstStop?.windowBeginDate) {
    const rawDate = firstStop.windowBeginDate;
    if (rawDate && rawDate !== 'TBD') {
      const dateOnly = rawDate.split('T')[0];
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
        firstStopDate = dateOnly;
      }
    }
  }

  // Patch all denormalized fields in one call.
  await ctx.db.patch(loadId, {
    firstStopDate,
    originCity: firstPickup?.city,
    originState: firstPickup?.state,
    originAddress: firstPickup?.address,
    destinationCity: lastDelivery?.city,
    destinationState: lastDelivery?.state,
    destinationAddress: lastDelivery?.address,
    stopsCountDenorm: allStops.length,
  });

  // Propagate firstStopDate to loadTags (facet index depends on it).
  await syncFirstStopDateToTags(ctx, loadId, firstStopDate);

  return firstStopDate;
}

/**
 * Internal mutation to sync firstStopDate - callable from other files
 * Use this when you need to sync from fourKitesSyncHelpers or other internal mutations
 */
export const syncFirstStopDateMutation = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    return syncFirstStopDate(ctx, args.loadId);
  },
});

/**
 * Distinct filter values for the dropdown UI.
 *
 * Reads from the facetValues registry (~hundreds of rows) rather than
 * scanning loadInformation (~thousands to millions of rows). Previous
 * implementation triggered Convex Health "Nearing documents read limit"
 * warnings at ~13K loads; the facet path is O(distinct facet count)
 * regardless of load volume.
 *
 * Safety fallback: if facetValues returns empty for an org (e.g. the
 * backfill hasn't completed yet for a newly-provisioned org), fall
 * through to the legacy full scan so the dropdown is never empty when
 * loads exist. Remove the fallback in Phase 5 after all orgs are
 * confirmed backfilled.
 *
 * Return shape unchanged: `{ hcrs: string[], trips: string[] }`.
 * Callers (planner, filter-bar) require no changes.
 */
export const getDistinctFilterValues = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // Fast path: read aggregated values from the facetValues registry.
    const [hcrFacets, tripFacets] = await Promise.all([
      ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'HCR'),
        )
        .collect(),
      ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'TRIP'),
        )
        .collect(),
    ]);

    if (hcrFacets.length > 0 || tripFacets.length > 0) {
      return {
        hcrs: hcrFacets.map((f) => f.value).sort(),
        trips: tripFacets.map((f) => f.value).sort(),
      };
    }

    // Fallback: scan loadTags directly. Only hits when facetValues is
    // empty for the org (drift or fresh org with no loads). Stays
    // valid after Phase 5 drops the parsedHcr/parsedTripNumber columns.
    const hcrs = new Set<string>();
    const trips = new Set<string>();
    for await (const tag of ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'HCR'),
      )) {
      hcrs.add(tag.value);
    }
    for await (const tag of ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'TRIP'),
      )) {
      trips.add(tag.value);
    }
    return {
      hcrs: Array.from(hcrs).sort(),
      trips: Array.from(trips).sort(),
    };
  },
});

// ✅ 1. GET LOADS (Read) - Optimized with denormalized firstStopDate index
export const getLoads = query({
  args: {
    workosOrgId: v.string(),
    status: v.optional(v.string()),
    trackingStatus: v.optional(v.string()),
    customerId: v.optional(v.id('customers')),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    startDate: v.optional(v.string()), // Date string in YYYY-MM-DD format
    endDate: v.optional(v.string()), // Date string in YYYY-MM-DD format
    requiresManualReview: v.optional(v.boolean()), // Filter for spot review
    loadType: v.optional(v.string()), // Filter by load type (CONTRACT, SPOT, UNMAPPED)
    search: v.optional(v.string()), // Search query
    mileRange: v.optional(v.string()), // Mile range filter: '0-100', '100-250', '250-500', '500+'
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // ── SEARCH PATH: bypass pagination, use index lookups ──
    // When searching, we do direct index lookups first (instant), then a
    // broader scan with a cap. This guarantees the load is found regardless
    // of which page it would normally be on.
    if (args.search) {
      const searchLower = args.search.toLowerCase().trim();
      const searchCanonical = searchLower.toUpperCase();
      const canonicalHcrArg = args.hcr?.trim().toUpperCase();
      const canonicalTripArg = args.tripNumber?.trim().toUpperCase();
      const seenIds = new Set<string>();
      const matchedLoads: any[] = [];
      const MAX_SEARCH_RESULTS = 50;

      // `load` here is pre-enriched with parsedHcr / parsedTripNumber
      // from tag lookup, so the existing field accesses continue to work.
      const matchesFilters = (load: any) => {
        if (args.status && load.status !== args.status) return false;
        if (args.trackingStatus && load.trackingStatus !== args.trackingStatus) return false;
        if (args.customerId && load.customerId !== args.customerId) return false;
        if (canonicalHcrArg && (load.parsedHcr ?? '').trim().toUpperCase() !== canonicalHcrArg)
          return false;
        if (canonicalTripArg && (load.parsedTripNumber ?? '').trim().toUpperCase() !== canonicalTripArg)
          return false;
        if (args.requiresManualReview !== undefined && load.requiresManualReview !== args.requiresManualReview)
          return false;
        if (args.loadType && load.loadType !== args.loadType) return false;
        if (args.mileRange && args.mileRange !== 'all') {
          const miles = load.effectiveMiles;
          if (!miles) return false;
          switch (args.mileRange) {
            case '0-100':
              if (miles < 0 || miles > 100) return false;
              break;
            case '100-250':
              if (miles <= 100 || miles > 250) return false;
              break;
            case '250-500':
              if (miles <= 250 || miles > 500) return false;
              break;
            case '500+':
              if (miles <= 500) return false;
              break;
          }
        }
        if (args.startDate && (!load.firstStopDate || load.firstStopDate < args.startDate)) return false;
        if (args.endDate && (!load.firstStopDate || load.firstStopDate > args.endDate)) return false;
        return true;
      };

      // Enrich a raw load doc with its facet values from tags.
      // After Phase 5 drops the columns, these are the only sources.
      const enrichWithFacets = async (load: any) => {
        const facets = await getLoadFacets(ctx, load._id);
        return {
          ...load,
          parsedHcr: facets.hcr,
          parsedTripNumber: facets.trip,
          _hcrCanonical: facets.hcrCanonical,
          _tripCanonical: facets.tripCanonical,
        };
      };

      const addIfMatch = async (load: any) => {
        if (!load || seenIds.has(load._id) || load.workosOrgId !== args.workosOrgId) return;
        seenIds.add(load._id);
        const enriched = await enrichWithFacets(load);
        if (!matchesFilters(enriched)) return;
        matchedLoads.push(enriched);
      };

      // 1. Exact index lookups (O(1) reads — fastest path)
      const [byOrder, byInternal] = await Promise.all([
        ctx.db
          .query('loadInformation')
          .withIndex('by_order_number', (q) => q.eq('workosOrgId', args.workosOrgId).eq('orderNumber', args.search!))
          .first(),
        ctx.db
          .query('loadInformation')
          .withIndex('by_internal_id', (q) =>
            q.eq('workosOrgId', args.workosOrgId).eq('internalId', `FK-${args.search!}`),
          )
          .first(),
      ]);

      await addIfMatch(byOrder);
      await addIfMatch(byInternal);

      // 2. If we don't have enough results, do a broader scan
      if (matchedLoads.length < MAX_SEARCH_RESULTS) {
        let scanQuery;
        if (args.status) {
          scanQuery = ctx.db
            .query('loadInformation')
            .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', args.status! as any));
        } else {
          scanQuery = ctx.db
            .query('loadInformation')
            .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId));
        }

        // Scan up to 2000 documents for partial matches (avoids reading all 13K+).
        // Exact matches are already found via index lookups above.
        const SCAN_LIMIT = 2000;
        const scanResults = await scanQuery.order('desc').take(SCAN_LIMIT);
        for (const load of scanResults) {
          if (matchedLoads.length >= MAX_SEARCH_RESULTS) break;
          if (seenIds.has(load._id)) continue;

          // Quick match on fields that live on loadInformation. If this
          // hits AND no HCR/Trip filter is set, skip the tag lookup entirely.
          const matchesOnLoadFields =
            load.orderNumber?.toLowerCase().includes(searchLower) ||
            load.customerName?.toLowerCase().includes(searchLower) ||
            load.internalId?.toLowerCase().includes(searchLower);

          const needsFacets =
            !matchesOnLoadFields ||
            !!canonicalHcrArg ||
            !!canonicalTripArg;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let enrichedLoad: any = load;
          let facetsMatched = false;
          if (needsFacets) {
            enrichedLoad = await enrichWithFacets(load);
            facetsMatched =
              (enrichedLoad._hcrCanonical ?? '').includes(searchCanonical) ||
              (enrichedLoad._tripCanonical ?? '').includes(searchCanonical);
          }

          if (!matchesOnLoadFields && !facetsMatched) continue;
          seenIds.add(load._id);
          // Always enrich before pushing so the response has parsedHcr /
          // parsedTripNumber for row badges, even when search matched on
          // orderNumber/customerName and tag lookup was skipped above.
          if (!needsFacets) {
            enrichedLoad = await enrichWithFacets(load);
          }
          if (!matchesFilters(enrichedLoad)) continue;
          matchedLoads.push(enrichedLoad);
        }
      }

      // Search path: matchedLoads here were already enriched inside the
      // scan loop via enrichWithFacets (which sets parsedHcr /
      // parsedTripNumber). Project the denorm columns into the legacy
      // origin / destination / stopsCount shape the UI expects.
      const enriched = matchedLoads.map((load) => ({
        ...load,
        // parsedHcr / parsedTripNumber already set by enrichWithFacets
        origin:
          load.originCity !== undefined ||
          load.originState !== undefined ||
          load.originAddress !== undefined
            ? {
                city: load.originCity,
                state: load.originState,
                address: load.originAddress ?? '',
              }
            : null,
        destination:
          load.destinationCity !== undefined ||
          load.destinationState !== undefined ||
          load.destinationAddress !== undefined
            ? {
                city: load.destinationCity,
                state: load.destinationState,
                address: load.destinationAddress ?? '',
              }
            : null,
        stopsCount: load.stopsCountDenorm ?? 0,
        firstStopDate: load.firstStopDate,
      }));

      enriched.sort((a, b) => {
        const dateA = a.firstStopDate || '';
        const dateB = b.firstStopDate || '';
        return dateB.localeCompare(dateA);
      });

      return {
        page: enriched,
        isDone: true,
        continueCursor: '',
      };
    }

    // ── NORMAL PATH: paginated query (no search) ──
    //
    // Two pagination strategies depending on whether a facet filter is present:
    //
    //  - With HCR or TRIP filter: paginate the loadTags index
    //    (by_org_key_canonical_date) and fetch loads by ID. Date range and
    //    facet value are both indexable; remaining filters (status, customer,
    //    miles, etc.) are post-filtered in app code.
    //
    //  - Without facet filter: paginate loadInformation by_org_first_stop_date
    //    with all filters applied via Convex .filter() — same as before.
    //
    // The facet path replaces the previous parsedHcr/parsedTripNumber column
    // .filter() calls. It works after Phase 5 drops those columns.
    const canonicalHcr = args.hcr?.trim().toUpperCase();
    const canonicalTrip = args.tripNumber?.trim().toUpperCase();
    const useFacetIndex = !!(canonicalHcr || canonicalTrip);

    let paginatedResult: {
      page: Array<Doc<'loadInformation'>>;
      isDone: boolean;
      continueCursor: string;
    };

    if (useFacetIndex) {
      // Helper — in-memory row filter shared across both combined and
      // single-facet paths.
      const passesNonIndexedFilters = (load: Doc<'loadInformation'>): boolean => {
        if (load.workosOrgId !== args.workosOrgId) return false;
        if (args.status && load.status !== args.status) return false;
        if (args.trackingStatus && load.trackingStatus !== args.trackingStatus) return false;
        if (args.customerId && load.customerId !== args.customerId) return false;
        if (
          args.requiresManualReview !== undefined &&
          load.requiresManualReview !== args.requiresManualReview
        )
          return false;
        if (args.loadType && load.loadType !== args.loadType) return false;
        if (args.mileRange && args.mileRange !== 'all') {
          const miles = load.effectiveMiles;
          if (miles === undefined) return false;
          const inRange =
            (args.mileRange === '0-100' && miles >= 0 && miles <= 100) ||
            (args.mileRange === '100-250' && miles > 100 && miles <= 250) ||
            (args.mileRange === '250-500' && miles > 250 && miles <= 500) ||
            (args.mileRange === '500+' && miles > 500);
          if (!inRange) return false;
        }
        return true;
      };

      if (canonicalHcr && canonicalTrip) {
        // ─ COMBINED HCR + TRIP: full intersection, in-memory paginate ─
        //
        // Previously we paginated the primary tag set and post-filtered by
        // secondary. That shrunk pages dramatically when the specific
        // (HCR, TRIP) pair was narrow within the primary set (e.g. filtering
        // 5K+ HCR=917DK loads by a specific TRIP returned 0-2 per page).
        //
        // The intersection is by definition small (user is drilling in),
        // so fetching all matching primary tags + checking secondary per
        // load is cheap (~250 reads for 125 primary tags) and gives
        // correct pagination with full pages.
        //
        // Primary key: TRIP when both are specified. In typical data trips
        // are far more numerous per-org (~566 distinct) than HCRs (~9),
        // so an individual trip filter yields a far smaller load set.
        const primaryTags = await ctx.db
          .query('loadTags')
          .withIndex('by_org_key_canonical_date', (q) => {
            const base = q
              .eq('workosOrgId', args.workosOrgId)
              .eq('facetKey', 'TRIP')
              .eq('canonicalValue', canonicalTrip);
            if (args.startDate && args.endDate) {
              return base
                .gte('firstStopDate', args.startDate)
                .lte('firstStopDate', args.endDate);
            }
            if (args.startDate) return base.gte('firstStopDate', args.startDate);
            if (args.endDate) return base.lte('firstStopDate', args.endDate);
            return base;
          })
          .order('desc')
          .collect();

        // Secondary check: per-load HCR tag lookup.
        const secondaryTags = await Promise.all(
          primaryTags.map((t) =>
            ctx.db
              .query('loadTags')
              .withIndex('by_load_key', (q) =>
                q.eq('loadId', t.loadId).eq('facetKey', 'HCR'),
              )
              .unique(),
          ),
        );
        const intersectionLoadIds = primaryTags
          .filter(
            (_, i) => secondaryTags[i]?.canonicalValue === canonicalHcr,
          )
          .map((t) => t.loadId);

        const loads = (
          await Promise.all(intersectionLoadIds.map((id) => ctx.db.get(id)))
        ).filter((l): l is Doc<'loadInformation'> => l !== null);

        const filtered = loads.filter(passesNonIndexedFilters);

        // In-memory pagination — numeric-offset cursor. Stable since the
        // intersection ordering is deterministic (primary tag order desc).
        const offset = args.paginationOpts.cursor
          ? parseInt(args.paginationOpts.cursor, 10) || 0
          : 0;
        const pageSize = args.paginationOpts.numItems;
        const page = filtered.slice(offset, offset + pageSize);
        const next = offset + pageSize;
        const isDone = next >= filtered.length;

        paginatedResult = {
          page,
          isDone,
          continueCursor: isDone ? '' : String(next),
        };
      } else {
        // ─ SINGLE FACET: paginate the tag index directly ─
        const primaryKey = canonicalHcr ? 'HCR' : 'TRIP';
        const primaryValue = canonicalHcr ?? canonicalTrip!;

        const tagQuery = ctx.db
          .query('loadTags')
          .withIndex('by_org_key_canonical_date', (q) => {
            const base = q
              .eq('workosOrgId', args.workosOrgId)
              .eq('facetKey', primaryKey)
              .eq('canonicalValue', primaryValue);
            if (args.startDate && args.endDate) {
              return base
                .gte('firstStopDate', args.startDate)
                .lte('firstStopDate', args.endDate);
            }
            if (args.startDate) return base.gte('firstStopDate', args.startDate);
            if (args.endDate) return base.lte('firstStopDate', args.endDate);
            return base;
          });

        const tagPage = await tagQuery.order('desc').paginate(args.paginationOpts);

        const fetched = await Promise.all(
          tagPage.page.map((t) => ctx.db.get(t.loadId)),
        );
        const filtered = fetched.filter(
          (l): l is Doc<'loadInformation'> =>
            l !== null && passesNonIndexedFilters(l),
        );

        paginatedResult = {
          page: filtered,
          isDone: tagPage.isDone,
          continueCursor: tagPage.continueCursor,
        };
      }
    } else {
      // Unfiltered (or only date-range): existing loadInformation path.
      let loadsQuery;
      if (args.startDate && args.endDate) {
        loadsQuery = ctx.db
          .query('loadInformation')
          .withIndex('by_org_first_stop_date', (q) =>
            q
              .eq('workosOrgId', args.workosOrgId)
              .gte('firstStopDate', args.startDate!)
              .lte('firstStopDate', args.endDate!),
          );
      } else if (args.startDate) {
        loadsQuery = ctx.db
          .query('loadInformation')
          .withIndex('by_org_first_stop_date', (q) =>
            q.eq('workosOrgId', args.workosOrgId).gte('firstStopDate', args.startDate!),
          );
      } else if (args.endDate) {
        loadsQuery = ctx.db
          .query('loadInformation')
          .withIndex('by_org_first_stop_date', (q) =>
            q.eq('workosOrgId', args.workosOrgId).lte('firstStopDate', args.endDate!),
          );
      } else {
        loadsQuery = ctx.db
          .query('loadInformation')
          .withIndex('by_org_first_stop_date', (q) => q.eq('workosOrgId', args.workosOrgId));
      }

      if (args.status) {
        loadsQuery = loadsQuery.filter((q) => q.eq(q.field('status'), args.status));
      }
      if (args.trackingStatus) {
        loadsQuery = loadsQuery.filter((q) => q.eq(q.field('trackingStatus'), args.trackingStatus));
      }
      if (args.customerId) {
        loadsQuery = loadsQuery.filter((q) => q.eq(q.field('customerId'), args.customerId));
      }
      if (args.requiresManualReview !== undefined) {
        loadsQuery = loadsQuery.filter((q) => q.eq(q.field('requiresManualReview'), args.requiresManualReview));
      }
      if (args.loadType) {
        loadsQuery = loadsQuery.filter((q) => q.eq(q.field('loadType'), args.loadType));
      }
      if (args.mileRange && args.mileRange !== 'all') {
        switch (args.mileRange) {
          case '0-100':
            loadsQuery = loadsQuery
              .filter((q) => q.gte(q.field('effectiveMiles'), 0))
              .filter((q) => q.lte(q.field('effectiveMiles'), 100));
            break;
          case '100-250':
            loadsQuery = loadsQuery
              .filter((q) => q.gt(q.field('effectiveMiles'), 100))
              .filter((q) => q.lte(q.field('effectiveMiles'), 250));
            break;
          case '250-500':
            loadsQuery = loadsQuery
              .filter((q) => q.gt(q.field('effectiveMiles'), 250))
              .filter((q) => q.lte(q.field('effectiveMiles'), 500));
            break;
          case '500+':
            loadsQuery = loadsQuery.filter((q) => q.gt(q.field('effectiveMiles'), 500));
            break;
        }
      }

      paginatedResult = await loadsQuery.order('desc').paginate(args.paginationOpts);
    }

    // Enrich each page row with parsedHcr / parsedTripNumber from facet
    // tags. Callers (loads-table, virtualized-loads-table, filter-bar)
    // still expect these field NAMES on the response — the values now
    // come from loadTags instead of the (dropped) columns.
    // One tag lookup per page row via by_load index (O(1) per row).
    const loadsWithStops = await Promise.all(
      paginatedResult.page.map(async (load) => {
        const facets = await getLoadFacets(ctx, load._id);
        return {
          ...load,
          parsedHcr: facets.hcr,
          parsedTripNumber: facets.trip,
          origin:
            load.originCity !== undefined ||
            load.originState !== undefined ||
            load.originAddress !== undefined
              ? {
                  city: load.originCity,
                  state: load.originState,
                  address: load.originAddress ?? '',
                }
              : null,
          destination:
            load.destinationCity !== undefined ||
            load.destinationState !== undefined ||
            load.destinationAddress !== undefined
              ? {
                  city: load.destinationCity,
                  state: load.destinationState,
                  address: load.destinationAddress ?? '',
                }
              : null,
          stopsCount: load.stopsCountDenorm ?? 0,
          firstStopDate: load.firstStopDate,
        };
      }),
    );

    return {
      ...paginatedResult,
      page: loadsWithStops,
    };
  },
});

// ✅ 2. GET SINGLE LOAD (Read)
export const getLoad = query({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) return null;
    if (load.workosOrgId !== callerOrgId) return null;

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    // Fetch dispatch legs for this load
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Get assigned driver (from load's primaryDriverId cache)
    const primaryDriver = load.primaryDriverId ? await ctx.db.get(load.primaryDriverId) : null;

    // Get assigned carrier partnership
    let primaryCarrierPartnership = load.primaryCarrierPartnershipId
      ? await ctx.db.get(load.primaryCarrierPartnershipId)
      : null;

    // If no direct partnership, check the marketplace assignment system
    let carrierAssignment = null;
    if (!primaryCarrierPartnership) {
      carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .filter((q) => q.or(q.eq(q.field('status'), 'AWARDED'), q.eq(q.field('status'), 'IN_PROGRESS')))
        .first();
    }

    // Get truck and trailer from first leg (primary equipment)
    const firstLeg = legs.length > 0 ? legs.sort((a, b) => a.sequence - b.sequence)[0] : null;

    const truck = firstLeg?.truckId ? await ctx.db.get(firstLeg.truckId) : null;

    const trailer = firstLeg?.trailerId ? await ctx.db.get(firstLeg.trailerId) : null;

    // HCR / TRIP from facet tags (columns removed in Phase 5b).
    const facets = await getLoadFacets(ctx, load._id);

    return {
      ...load,
      parsedHcr: facets.hcr,
      parsedTripNumber: facets.trip,
      stops,
      // Enriched assignment data
      assignedDriver: primaryDriver
        ? {
            _id: primaryDriver._id,
            name: `${primaryDriver.firstName} ${primaryDriver.lastName}`,
            phone: primaryDriver.phone,
          }
        : null,
      assignedCarrier: primaryCarrierPartnership
        ? {
            _id: primaryCarrierPartnership._id,
            companyName: primaryCarrierPartnership.carrierName,
            phone: primaryCarrierPartnership.contactPhone,
            mcNumber: primaryCarrierPartnership.mcNumber,
          }
        : carrierAssignment
          ? {
              _id: carrierAssignment._id,
              companyName: carrierAssignment.carrierName,
              phone: carrierAssignment.assignedDriverPhone,
              mcNumber: carrierAssignment.carrierMcNumber,
              carrierRate: carrierAssignment.carrierTotalAmount,
              // Carrier's assigned driver for this load
              driverName: carrierAssignment.assignedDriverName,
              driverPhone: carrierAssignment.assignedDriverPhone,
            }
          : null,
      assignedTruck: truck
        ? {
            _id: truck._id,
            unitId: truck.unitId,
            bodyType: truck.bodyType,
          }
        : null,
      assignedTrailer: trailer
        ? {
            _id: trailer._id,
            unitId: trailer.unitId,
            trailerType: trailer.bodyType,
          }
        : null,
    };
  },
});

// ✅ 2b. GET LOAD WITH TIME RANGE (For Dispatch Planner)
// Returns load details with computed time window from stops
// Enriched with assigned assets for post-assignment monitoring
export const getByIdWithRange = query({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) return null;
    if (load.workosOrgId !== callerOrgId) return null;

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Fetch dispatch legs for this load
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Get assigned driver (from load's primaryDriverId cache)
    const primaryDriver = load.primaryDriverId ? await ctx.db.get(load.primaryDriverId) : null;

    // Get assigned carrier partnership
    let primaryCarrierPartnership = load.primaryCarrierPartnershipId
      ? await ctx.db.get(load.primaryCarrierPartnershipId)
      : null;

    // If no direct partnership, check the marketplace assignment system
    let carrierAssignment = null;
    if (!primaryCarrierPartnership) {
      carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .filter((q) => q.or(q.eq(q.field('status'), 'AWARDED'), q.eq(q.field('status'), 'IN_PROGRESS')))
        .first();
    }

    // Get truck and trailer from first leg (primary equipment)
    const firstLeg = legs.length > 0 ? legs.sort((a, b) => a.sequence - b.sequence)[0] : null;

    const truck = firstLeg?.truckId ? await ctx.db.get(firstLeg.truckId) : null;

    const trailer = firstLeg?.trailerId ? await ctx.db.get(firstLeg.trailerId) : null;

    if (stops.length === 0) {
      return {
        ...load,
        startTime: null,
        endTime: null,
        stops: [],
        legs: [],
        assignedDriver: null,
        assignedCarrier: null,
        assignedTruck: null,
        assignedTrailer: null,
      };
    }

    // Sort to find the true start and end of the load (exclude detour stops from time range)
    const scheduledStops = [...stops]
      .filter((s) => s.stopType !== 'DETOUR')
      .sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const startTime =
      scheduledStops.length > 0
        ? parseStopDateTime(scheduledStops[0].windowBeginDate, scheduledStops[0].windowBeginTime)
        : null;
    // Use windowBeginTime (appointment time) not windowEndTime (end of delivery window)
    // This prevents false scheduling conflicts from wide delivery windows
    const endTime =
      scheduledStops.length > 0
        ? parseStopDateTime(
            scheduledStops[scheduledStops.length - 1].windowBeginDate,
            scheduledStops[scheduledStops.length - 1].windowBeginTime,
          )
        : null;

    // Get origin/destination for display (from scheduled stops only)
    const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const firstPickup = sortedStops.find((s) => s.stopType === 'PICKUP');
    const lastDelivery = sortedStops.filter((s) => s.stopType === 'DELIVERY').pop();

    return {
      ...load,
      startTime,
      endTime,
      origin: firstPickup
        ? {
            city: firstPickup.city,
            state: firstPickup.state,
            address: firstPickup.address,
            lat: firstPickup.latitude,
            lng: firstPickup.longitude,
          }
        : null,
      destination: lastDelivery
        ? {
            city: lastDelivery.city,
            state: lastDelivery.state,
            address: lastDelivery.address,
            lat: lastDelivery.latitude,
            lng: lastDelivery.longitude,
          }
        : null,
      stops: sortedStops,
      // Enriched assignment data
      legs: legs.sort((a, b) => a.sequence - b.sequence),
      assignedDriver: primaryDriver
        ? {
            _id: primaryDriver._id,
            name: `${primaryDriver.firstName} ${primaryDriver.lastName}`,
            phone: primaryDriver.phone,
            city: primaryDriver.city,
            state: primaryDriver.state,
          }
        : null,
      assignedCarrier: primaryCarrierPartnership
        ? {
            _id: primaryCarrierPartnership._id,
            companyName: primaryCarrierPartnership.carrierName,
            phone: primaryCarrierPartnership.contactPhone,
            mcNumber: primaryCarrierPartnership.mcNumber,
          }
        : carrierAssignment
          ? {
              _id: carrierAssignment._id,
              companyName: carrierAssignment.carrierName,
              phone: carrierAssignment.assignedDriverPhone,
              // Extra fields from marketplace assignment
              mcNumber: carrierAssignment.carrierMcNumber,
              carrierRate: carrierAssignment.carrierTotalAmount,
              // Carrier's assigned driver for this load
              driverName: carrierAssignment.assignedDriverName,
              driverPhone: carrierAssignment.assignedDriverPhone,
            }
          : null,
      assignedTruck: truck
        ? {
            _id: truck._id,
            unitId: truck.unitId,
            bodyType: truck.bodyType,
          }
        : null,
      assignedTrailer: trailer
        ? {
            _id: trailer._id,
            unitId: trailer.unitId,
            trailerType: trailer.bodyType,
          }
        : null,
    };
  },
});

// ✅ 3. CREATE LOAD (Write) - Architecture Aligned
export const createLoad = mutation({
  args: {
    workosOrgId: v.string(),
    createdBy: v.string(),
    createdByName: v.optional(v.string()), // For auto-assignment audit
    internalId: v.string(),
    orderNumber: v.string(),
    poNumber: v.optional(v.string()),
    customerId: v.id('customers'),
    fleet: v.string(),
    equipmentType: v.optional(v.string()),
    equipmentLength: v.optional(v.number()),
    commodityDescription: v.optional(v.string()),
    weight: v.optional(v.number()),
    units: v.union(v.literal('Pallets'), v.literal('Boxes'), v.literal('Pieces'), v.literal('Lbs'), v.literal('Kg')),
    temperature: v.optional(v.number()),
    maxTemperature: v.optional(v.number()),
    contactPersonName: v.optional(v.string()),
    contactPersonPhone: v.optional(v.string()),
    contactPersonEmail: v.optional(v.string()),
    generalInstructions: v.optional(v.string()),
    contractMiles: v.optional(v.number()),
    importedMiles: v.optional(v.number()),
    googleMiles: v.optional(v.number()),
    manualMiles: v.optional(v.number()),
    // Route identification (manual entry)
    parsedHcr: v.optional(v.string()),
    parsedTripNumber: v.optional(v.string()),
    // Direct assignment (create dispatch leg immediately)
    assignDriverId: v.optional(v.id('drivers')),
    assignCarrierId: v.optional(v.id('carrierPartnerships')),
    stops: v.array(
      v.object({
        sequenceNumber: v.number(),
        stopType: v.union(v.literal('PICKUP'), v.literal('DELIVERY')),
        loadingType: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),
        address: v.string(),
        city: v.optional(v.string()),
        state: v.optional(v.string()),
        postalCode: v.optional(v.string()),
        latitude: v.optional(v.number()),
        longitude: v.optional(v.number()),
        timeZone: v.optional(v.string()), // IANA timezone (e.g., "America/Los_Angeles")
        windowBeginDate: v.string(),
        windowBeginTime: v.string(), // Full ISO string with timezone OR just "HH:mm"
        windowEndDate: v.string(),
        windowEndTime: v.string(), // Full ISO string with timezone OR just "HH:mm"
        commodityDescription: v.string(),
        commodityUnits: v.union(
          v.literal('Pallets'),
          v.literal('Boxes'),
          v.literal('Pieces'),
          v.literal('Lbs'),
          v.literal('Kg'),
        ),
        pieces: v.number(),
        weight: v.optional(v.number()),
        instructions: v.optional(v.string()),
        photoRequired: v.optional(v.boolean()),
        signatureRequired: v.optional(v.boolean()),
        referenceName: v.optional(v.string()),
        referenceValue: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const { userId: createdBy, userName: createdByName } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    if (args.stops.length === 0) throw new Error('At least one stop is required');

    const customer = await ctx.db.get(args.customerId);
    if (!customer) throw new Error('Customer not found');

    const effectiveMiles = calculateEffectiveMiles(
      args.manualMiles,
      args.contractMiles,
      args.importedMiles,
      args.googleMiles,
    );

    // HCR/Trip for route identification
    const parsedHcr = args.parsedHcr;
    const parsedTripNumber = args.parsedTripNumber;

    const loadId = await ctx.db.insert('loadInformation', {
      workosOrgId: args.workosOrgId,
      createdBy: createdBy,
      internalId: args.internalId,
      orderNumber: args.orderNumber,
      poNumber: args.poNumber,

      // ⚡ ARCHITECTURE DEFAULTS (Title Case per schema)
      status: 'Open', // Workflow status
      trackingStatus: 'Pending', // Physical tracking status

      // Manual loads don't have external source
      externalSource: undefined,
      externalLoadId: undefined,
      lastExternalUpdatedAt: undefined,

      // HCR / TRIP are no longer stored on loadInformation — they live
      // in loadTags, registered via setLoadTag below. args.parsedHcr /
      // args.parsedTripNumber are still accepted for API compatibility
      // and feed into the tag writes.

      customerId: args.customerId,
      customerName: customer.name,
      fleet: args.fleet,
      equipmentType: args.equipmentType,
      equipmentLength: args.equipmentLength,
      commodityDescription: args.commodityDescription,
      weight: args.weight,
      units: args.units,
      temperature: args.temperature,
      maxTemperature: args.maxTemperature,
      contactPersonName: args.contactPersonName,
      contactPersonPhone: args.contactPersonPhone,
      contactPersonEmail: args.contactPersonEmail,
      generalInstructions: args.generalInstructions,
      contractMiles: args.contractMiles,
      importedMiles: args.importedMiles,
      googleMiles: args.googleMiles,
      manualMiles: args.manualMiles,
      effectiveMiles,
      lastMilesUpdate: effectiveMiles ? new Date().toISOString() : undefined,
      createdAt: now,
      updatedAt: now,
    });

    for (const stop of args.stops) {
      await ctx.db.insert('loadStops', {
        workosOrgId: args.workosOrgId,
        createdBy: createdBy,
        loadId: loadId as Id<'loadInformation'>,
        internalId: args.internalId,

        // ✅ ARCHITECTURE FIX: No fake external IDs for manual stops
        externalStopId: undefined,

        sequenceNumber: stop.sequenceNumber,
        stopType: stop.stopType,
        loadingType: stop.loadingType,
        address: stop.address,
        city: stop.city,
        state: stop.state,
        postalCode: stop.postalCode,
        latitude: stop.latitude,
        longitude: stop.longitude,
        timeZone: stop.timeZone, // IANA timezone (e.g., "America/Los_Angeles")
        windowBeginDate: stop.windowBeginDate,
        windowBeginTime: stop.windowBeginTime, // Full ISO with timezone OR "HH:mm"
        windowEndDate: stop.windowEndDate,
        windowEndTime: stop.windowEndTime, // Full ISO with timezone OR "HH:mm"
        commodityDescription: stop.commodityDescription,
        commodityUnits: stop.commodityUnits,
        pieces: stop.pieces,
        weight: stop.weight,
        instructions: stop.instructions,
        photoRequired: stop.photoRequired,
        signatureRequired: stop.signatureRequired,
        referenceName: stop.referenceName,
        referenceValue: stop.referenceValue,

        // Default status for new stops
        status: 'Pending',

        createdAt: now,
        updatedAt: now,
      });
    }

    // Sync firstStopDate after all stops are created
    const firstStopDate = await syncFirstStopDate(ctx, loadId as Id<'loadInformation'>);

    // Register HCR / TRIP facet tags. Source of truth for the dropdown
    // and (Phase 5+) the load filter index. setLoadTag is a no-op for
    // undefined/empty/wildcard values.
    await setLoadTag(ctx, {
      loadId: loadId as Id<'loadInformation'>,
      workosOrgId: args.workosOrgId,
      facetKey: 'HCR',
      value: parsedHcr,
      source: 'LOAD_MANUAL',
      firstStopDate,
    });
    await setLoadTag(ctx, {
      loadId: loadId as Id<'loadInformation'>,
      workosOrgId: args.workosOrgId,
      facetKey: 'TRIP',
      value: parsedTripNumber,
      source: 'LOAD_MANUAL',
      firstStopDate,
    });

    // Handle direct assignment if driver or carrier was selected
    if (args.assignDriverId || args.assignCarrierId) {
      try {
        if (args.assignDriverId) {
          // Get driver info for the dispatch leg
          const driver = await ctx.db.get(args.assignDriverId);
          if (driver) {
            await ctx.runMutation(internal.dispatchLegs.assignDriverInternal, {
              loadId: loadId as Id<'loadInformation'>,
              driverId: args.assignDriverId,
              truckId: driver.currentTruckId,
              assignedBy: createdBy,
              assignedByName: createdByName,
            });
          }
        } else if (args.assignCarrierId) {
          // Get carrier info for the dispatch leg
          const carrier = await ctx.db.get(args.assignCarrierId);
          if (carrier) {
            await ctx.runMutation(internal.dispatchLegs.assignCarrierInternal, {
              loadId: loadId as Id<'loadInformation'>,
              carrierPartnershipId: args.assignCarrierId,
              carrierRate: carrier.defaultRate,
              assignedBy: createdBy,
              assignedByName: createdByName,
            });
          }
        }
      } catch (error) {
        // Log but don't fail load creation
        console.error('Direct assignment failed:', error);
      }
    } else if (parsedHcr) {
      // Only trigger auto-assignment based on route rules if no direct assignment was made
      // and the load has an HCR for matching
      try {
        await ctx.runMutation(internal.autoAssignment.triggerAutoAssignmentForLoad, {
          loadId: loadId as Id<'loadInformation'>,
          workosOrgId: args.workosOrgId,
          userId: createdBy,
          userName: createdByName,
        });
      } catch (error) {
        // Log but don't fail load creation
        console.error('Auto-assignment failed:', error);
      }
    }

    return loadId;
  },
});

// ✅ 4. UPDATE STATUS (Write)
// When moving to "Open", clears assignment data and cancels pending legs
// When moving to "Canceled" for assigned loads, requires cancellation reason
export const updateLoadStatus = mutation({
  args: {
    loadId: v.id('loadInformation'),
    status: loadStatusValidator,
    // Cancellation tracking (required when status = 'Canceled' and was 'Assigned')
    cancellationReason: v.optional(cancellationReasonValidator),
    cancellationNotes: v.optional(v.string()),
    canceledBy: v.optional(v.string()), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');
    const result = await applyLoadStatusUpdate(ctx, args);

    await updateLoadCount(ctx, result.load.workosOrgId, result.previousStatus, result.nextStatus);
  },
});

export const updateLoadStatusInternal = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    status: loadStatusValidator,
    cancellationReason: v.optional(cancellationReasonValidator),
    cancellationNotes: v.optional(v.string()),
    canceledBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await applyLoadStatusUpdate(ctx, args);

    await updateLoadCount(ctx, result.load.workosOrgId, result.previousStatus, result.nextStatus);
  },
});

// ✅ BULK UPDATE STATUS (Optimized for bulk operations)
export const bulkUpdateLoadStatus = mutation({
  args: {
    loadIds: v.array(v.id('loadInformation')),
    status: loadStatusValidator,
    cancellationReason: v.optional(cancellationReasonValidator),
    cancellationNotes: v.optional(v.string()),
    canceledBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    if (args.loadIds.length === 0) return { success: 0, failed: 0 };

    const now = Date.now();
    let success = 0;
    let failed = 0;

    // Group loads by organization and track status changes
    const orgStatusChanges = new Map<string, Map<string, number>>();

    // First pass: validate and collect all loads
    const loadsToUpdate: Array<{
      id: Id<'loadInformation'>;
      orgId: string;
    }> = [];

    for (const loadId of args.loadIds) {
      try {
        const load = await ctx.db.get(loadId);
        if (!load) {
          failed++;
          continue;
        }
        if (load.workosOrgId !== callerOrgId) {
          failed++;
          continue;
        }
        loadsToUpdate.push({ id: loadId, orgId: load.workosOrgId });
      } catch {
        failed++;
      }
    }

    // Second pass: perform all updates and track status changes
    for (const { id, orgId } of loadsToUpdate) {
      try {
        const result = await applyLoadStatusUpdate(ctx, {
          loadId: id,
          status: args.status,
          cancellationReason: args.cancellationReason,
          cancellationNotes: args.cancellationNotes,
          canceledBy: args.canceledBy,
        });

        // Track status changes by organization
        if (!orgStatusChanges.has(orgId)) {
          orgStatusChanges.set(orgId, new Map());
        }
        const orgChanges = orgStatusChanges.get(orgId)!;

        // Decrement old status
        orgChanges.set(result.previousStatus, (orgChanges.get(result.previousStatus) || 0) - 1);
        // Increment new status
        orgChanges.set(result.nextStatus, (orgChanges.get(result.nextStatus) || 0) + 1);

        success++;
      } catch (error) {
        console.error(`Failed to update load ${id}:`, error);
        failed++;
      }
    }

    // Third pass: Apply all stat changes at once per organization
    for (const [orgId, statusChanges] of orgStatusChanges.entries()) {
      const stats = await ctx.db
        .query('organizationStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', orgId))
        .first();

      if (stats) {
        const newLoadCounts = { ...stats.loadCounts };

        for (const [status, delta] of statusChanges.entries()) {
          if (status in newLoadCounts) {
            newLoadCounts[status as keyof typeof newLoadCounts] = Math.max(
              0,
              (newLoadCounts[status as keyof typeof newLoadCounts] || 0) + delta,
            );
          }
        }

        await ctx.db.patch(stats._id, {
          loadCounts: newLoadCounts,
          updatedAt: now,
        });
      }
    }

    return { success, failed };
  },
});

// ✅ 5. UPDATE MILES (Write)
export const updateLoadMiles = mutation({
  args: {
    loadId: v.id('loadInformation'),
    contractMiles: v.optional(v.number()),
    importedMiles: v.optional(v.number()),
    googleMiles: v.optional(v.number()),
    manualMiles: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    const updatedContractMiles = args.contractMiles ?? load.contractMiles;
    const updatedImportedMiles = args.importedMiles ?? load.importedMiles;
    const updatedGoogleMiles = args.googleMiles ?? load.googleMiles;
    const updatedManualMiles = args.manualMiles ?? load.manualMiles;

    const effectiveMiles = calculateEffectiveMiles(
      updatedManualMiles,
      updatedContractMiles,
      updatedImportedMiles,
      updatedGoogleMiles,
    );

    await ctx.db.patch(args.loadId, {
      contractMiles: updatedContractMiles,
      importedMiles: updatedImportedMiles,
      googleMiles: updatedGoogleMiles,
      manualMiles: updatedManualMiles,
      effectiveMiles,
      lastMilesUpdate: new Date().toISOString(),
      updatedAt: Date.now(),
    });
  },
});

// ✅ 6. DELETE LOAD (Write)
export const deleteLoad = mutation({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const loadToDelete = await ctx.db.get(args.loadId);
    if (!loadToDelete) throw new Error('Load not found');
    if (loadToDelete.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    // Cascade: cancel any open legs before removing the load. Legs are
    // retained (not deleted) so downstream ledger data — loadPayables,
    // audit trails — keeps its referential anchor. Prior to this cascade,
    // deleted loads left orphan PENDING legs that diagnoseReadCount
    // surfaced via the "parent load missing" bucket.
    const now = Date.now();
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          status: 'CANCELED',
          endReason: 'data_hygiene',
          endedAt: now,
          updatedAt: now,
        });
      }
    }

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    for (const stop of stops) {
      await ctx.db.delete(stop._id);
    }
    // Remove facet tags BEFORE deleting the load. facetValues rows are not
    // touched here — they're pruned by the nightly cleanup cron.
    await removeAllTagsForLoad(ctx, args.loadId);
    await ctx.db.delete(args.loadId);
  },
});

// ✅ 7. UPDATE STOP TIMES (Write) - Triggers pay recalculation
export const updateStopTimes = mutation({
  args: {
    stopId: v.id('loadStops'),
    windowBeginDate: v.optional(v.string()),
    windowBeginTime: v.optional(v.string()),
    windowEndDate: v.optional(v.string()),
    windowEndTime: v.optional(v.string()),
    checkedInAt: v.optional(v.string()),
    checkedOutAt: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const stop = await ctx.db.get(args.stopId);
    if (!stop) throw new Error('Stop not found');
    const stopLoad = await ctx.db.get(stop.loadId);
    if (!stopLoad || stopLoad.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    const { stopId, userId: _argUserId, ...updates } = args;
    const now = Date.now();

    // Build update object
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (updates.windowBeginDate !== undefined) updateData.windowBeginDate = updates.windowBeginDate;
    if (updates.windowBeginTime !== undefined) updateData.windowBeginTime = updates.windowBeginTime;
    if (updates.windowEndDate !== undefined) updateData.windowEndDate = updates.windowEndDate;
    if (updates.windowEndTime !== undefined) updateData.windowEndTime = updates.windowEndTime;
    if (updates.checkedInAt !== undefined) updateData.checkedInAt = updates.checkedInAt;
    if (updates.checkedOutAt !== undefined) updateData.checkedOutAt = updates.checkedOutAt;

    await ctx.db.patch(stopId, updateData);

    // If updating the first stop's date, sync firstStopDate on the load
    if (stop.sequenceNumber === 1 && updates.windowBeginDate !== undefined) {
      await syncFirstStopDate(ctx, stop.loadId);
    }

    // If the window's begin date/time changed, refresh cached scheduled times
    // on every leg that references this stop as start or end.
    if (updates.windowBeginDate !== undefined || updates.windowBeginTime !== undefined) {
      await syncLegsAffectedByStop(ctx, stopId);
    }

    // Trigger pay recalculation for affected legs
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
      .collect();

    for (const leg of legs) {
      // Check if this stop is within the leg's range
      if (leg.driverId) {
        await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
          legId: leg._id,
          userId,
        });
      }
    }

    return stopId;
  },
});

// ✅ 8. VALIDATE BULK STATUS CHANGE (Query) - Dispatch Protection
// Full transition matrix:
// - Assigned → Open: Warn (dispatcher work lost), check imminent/active
// - Assigned → Delivered: Allow manual completion from the loads UI
// - Assigned → Canceled: Require reason code for imminent/active
// - Open → Delivered: Block (impossible - must be assigned first)
// - Open → Canceled: Allow (dead-wood cleanup)
export const validateBulkStatusChange = query({
  args: {
    loadIds: v.array(v.id('loadInformation')),
    targetStatus: v.string(), // The status we're trying to set
    bufferHours: v.optional(v.number()), // Imminent threshold, defaults to 4
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const now = Date.now();
    const bufferMs = (args.bufferHours ?? 4) * 60 * 60 * 1000; // Default 4 hours

    const results: {
      safe: { id: string; orderNumber?: string; currentStatus?: string }[];
      imminent: {
        id: string;
        orderNumber?: string;
        pickupTime: string;
        hoursUntilPickup: number;
        currentStatus?: string;
      }[];
      active: { id: string; orderNumber?: string }[];
      finalized: { id: string; orderNumber?: string; status: string }[];
      blocked: { id: string; orderNumber?: string; reason: string }[]; // New: hard blocks
      requiresReason: { id: string; orderNumber?: string; currentStatus?: string }[]; // New: needs cancellation reason
    } = {
      safe: [],
      imminent: [],
      active: [],
      finalized: [],
      blocked: [],
      requiresReason: [],
    };

    for (const loadId of args.loadIds) {
      const load = await ctx.db.get(loadId);
      if (!load) continue;
      if (load.workosOrgId !== callerOrgId) continue;

      // 1. Check if load is already finalized (Completed/Canceled/Expired)
      if (load.status === 'Completed' || load.status === 'Canceled' || load.status === 'Expired') {
        results.finalized.push({
          id: loadId,
          orderNumber: load.orderNumber,
          status: load.status === 'Completed' ? 'Delivered' : load.status,
        });
        continue;
      }

      // 2. BLOCK: Open → Delivered (impossible transition)
      if (load.status === 'Open' && args.targetStatus === 'Completed') {
        results.blocked.push({
          id: loadId,
          orderNumber: load.orderNumber,
          reason: 'Cannot mark as Delivered - load must be assigned and transported first',
        });
        continue;
      }

      // 3. Get dispatch legs for further checks
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();

      const hasActiveLeg = legs.some((leg) => leg.status === 'ACTIVE');

      // 4. Assigned → Delivered: allow manual completion from the loads UI
      if (load.status === 'Assigned' && args.targetStatus === 'Completed') {
        results.safe.push({
          id: loadId,
          orderNumber: load.orderNumber,
          currentStatus: load.status,
        });
        continue;
      }

      // 5. Active leg check (blocks most transitions)
      if (hasActiveLeg) {
        results.active.push({
          id: loadId,
          orderNumber: load.orderNumber,
        });
        continue;
      }

      // 6. Assigned → Canceled: Check if requires reason (imminent loads)
      if (load.status === 'Assigned' && args.targetStatus === 'Canceled') {
        // All Assigned → Canceled require reason code
        results.requiresReason.push({
          id: loadId,
          orderNumber: load.orderNumber,
          currentStatus: load.status,
        });
        continue;
      }

      // 7. Assigned → Open: Check imminent
      if (load.status === 'Assigned' && args.targetStatus === 'Open') {
        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', loadId))
          .collect();

        const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        const firstPickup = sortedStops.find((s) => s.stopType === 'PICKUP') || sortedStops[0];

        if (firstPickup?.windowBeginDate && firstPickup?.windowBeginTime) {
          try {
            const pickupTime = new Date(`${firstPickup.windowBeginDate}T${firstPickup.windowBeginTime}`).getTime();
            const timeUntilPickup = pickupTime - now;
            const hoursUntilPickup = Math.round((timeUntilPickup / (60 * 60 * 1000)) * 10) / 10;

            if (timeUntilPickup > 0 && timeUntilPickup < bufferMs) {
              results.imminent.push({
                id: loadId,
                orderNumber: load.orderNumber,
                pickupTime: firstPickup.windowBeginTime,
                hoursUntilPickup,
                currentStatus: load.status,
              });
              continue;
            }
          } catch {
            // If date parsing fails, treat as safe
          }
        }
      }

      // 8. Safe to proceed (Open → Canceled, Open → Assigned, etc.)
      results.safe.push({
        id: loadId,
        orderNumber: load.orderNumber,
        currentStatus: load.status,
      });
    }

    return {
      ...results,
      summary: {
        total: args.loadIds.length,
        safeCount: results.safe.length,
        imminentCount: results.imminent.length,
        activeCount: results.active.length,
        finalizedCount: results.finalized.length,
        blockedCount: results.blocked.length,
        requiresReasonCount: results.requiresReason.length,
        canProceedSafely:
          results.imminent.length === 0 &&
          results.active.length === 0 &&
          results.blocked.length === 0 &&
          results.requiresReason.length === 0,
      },
    };
  },
});

// ✅ 9. UPDATE LOAD ATTRIBUTES (Write) - isHazmat, requiresTarp trigger recalculation
export const updateLoadAttributes = mutation({
  args: {
    loadId: v.id('loadInformation'),
    isHazmat: v.optional(v.boolean()),
    requiresTarp: v.optional(v.boolean()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    const { loadId, userId: _argUserId, ...updates } = args;
    const now = Date.now();

    // Build update object
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (updates.isHazmat !== undefined) updateData.isHazmat = updates.isHazmat;
    if (updates.requiresTarp !== undefined) updateData.requiresTarp = updates.requiresTarp;

    await ctx.db.patch(loadId, updateData);

    // Trigger pay recalculation for all legs (driver and carrier)
    await ctx.runMutation(internal.driverPayCalculation.recalculateForLoad, {
      loadId,
      userId,
    });
    await ctx.runMutation(internal.carrierPayCalculation.recalculateForLoad, {
      loadId,
      userId,
    });

    return loadId;
  },
});

// ==========================================
// ASSIGNED LOADS QUERIES (for carrier/driver detail pages)
// ==========================================

const assignedLoadStatusValidator = v.union(
  v.literal('Assigned'),
  v.literal('Completed'),
  v.literal('Canceled'),
  v.literal('Expired'),
);

async function enrichLoadFromLeg(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  leg: {
    loadId: Id<'loadInformation'>;
    status: string;
    legLoadedMiles: number;
    driverId?: Id<'drivers'>;
    carrierPartnershipId?: Id<'carrierPartnerships'>;
  },
) {
  const load = await ctx.db.get(leg.loadId);
  if (!load) return null;

  // HCR/Trip from facet tags. Origin/destination/stopsCount from
  // denormalized columns (syncFirstStopDate keeps them fresh).
  const facets = await getLoadFacets(ctx, leg.loadId);

  return {
    _id: load._id as Id<'loadInformation'>,
    orderNumber: load.orderNumber as string,
    customerName: load.customerName as string | undefined,
    status: load.status as string,
    trackingStatus: load.trackingStatus as string,
    stopsCount: load.stopsCountDenorm ?? 0,
    origin:
      load.originCity !== undefined || load.originState !== undefined
        ? { city: load.originCity, state: load.originState }
        : null,
    destination:
      load.destinationCity !== undefined || load.destinationState !== undefined
        ? { city: load.destinationCity, state: load.destinationState }
        : null,
    firstStopDate: load.firstStopDate as string | undefined,
    parsedHcr: facets.hcr,
    parsedTripNumber: facets.trip,
    legStatus: leg.status,
    legLoadedMiles: leg.legLoadedMiles,
    createdAt: load._creationTime as number,
  };
}

/**
 * Enrich a load document directly (without a dispatch leg).
 * Used by fallback paths when the load is found via primaryDriverId or carrier assignments.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichLoadDirectly(ctx: any, load: any) {
  const facets = await getLoadFacets(ctx, load._id);

  return {
    _id: load._id as Id<'loadInformation'>,
    orderNumber: load.orderNumber as string,
    customerName: load.customerName as string | undefined,
    status: load.status as string,
    trackingStatus: load.trackingStatus as string,
    stopsCount: load.stopsCountDenorm ?? 0,
    origin:
      load.originCity !== undefined || load.originState !== undefined
        ? { city: load.originCity, state: load.originState }
        : null,
    destination:
      load.destinationCity !== undefined || load.destinationState !== undefined
        ? { city: load.destinationCity, state: load.destinationState }
        : null,
    firstStopDate: load.firstStopDate as string | undefined,
    parsedHcr: facets.hcr,
    parsedTripNumber: facets.trip,
    legStatus: 'PENDING',
    legLoadedMiles: load.effectiveMiles ?? 0,
    createdAt: load._creationTime as number,
  };
}

function mapLoadStatusToDispatchStatus(
  status: 'Assigned' | 'Completed' | 'Canceled' | 'Expired',
): 'COMPLETED' | 'CANCELED' | undefined {
  switch (status) {
    case 'Assigned':
      return undefined;
    case 'Completed':
      return 'COMPLETED';
    case 'Canceled':
      return 'CANCELED';
    case 'Expired':
      return undefined;
  }
}

/**
 * Get loads assigned to a specific driver.
 * Primary source: dispatchLegs with driverId.
 * Fallback: loadInformation.primaryDriverId for loads where the dispatch leg
 * wasn't properly linked (e.g., all legs were terminal when driver was assigned).
 */
export const getByDriver = query({
  args: {
    driverId: v.id('drivers'),
    status: assignedLoadStatusValidator,
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) throw new Error('Not authorized for this organization');

    const dispatchStatus = mapLoadStatusToDispatchStatus(args.status);
    const seenLoadIds = new Set<string>();
    const enrichedLoads: Array<Record<string, any>> = [];

    // --- Primary: dispatch legs indexed by driver ---
    let legsQuery;
    if (dispatchStatus) {
      legsQuery = ctx.db
        .query('dispatchLegs')
        .withIndex('by_driver', (q) => q.eq('driverId', args.driverId).eq('status', dispatchStatus));
    } else {
      legsQuery = ctx.db.query('dispatchLegs').withIndex('by_driver', (q) => q.eq('driverId', args.driverId));
    }

    const allLegs = await legsQuery.order('desc').collect();

    for (const leg of allLegs) {
      if (seenLoadIds.has(leg.loadId)) continue;
      seenLoadIds.add(leg.loadId);

      if (args.status === 'Assigned') {
        if (leg.status === 'COMPLETED' || leg.status === 'CANCELED') continue;
      }

      if (leg.driverId !== args.driverId) continue;

      const enriched = await enrichLoadFromLeg(ctx, leg);
      if (!enriched) continue;

      const loadStatusMatchesFilter =
        (args.status === 'Assigned' && enriched.status === 'Assigned') ||
        (args.status === 'Completed' && enriched.status === 'Completed') ||
        (args.status === 'Canceled' && enriched.status === 'Canceled') ||
        (args.status === 'Expired' && enriched.status === 'Expired');
      if (!loadStatusMatchesFilter) continue;

      enrichedLoads.push(enriched);
    }

    // --- Fallback 1: loads where primaryDriverId matches but no dispatch leg found ---
    const statusToMatch =
      args.status === 'Completed'
        ? 'Completed'
        : args.status === 'Canceled'
          ? 'Canceled'
          : args.status === 'Expired'
            ? 'Expired'
            : 'Assigned';

    const fallbackLoads = await ctx.db
      .query('loadInformation')
      .withIndex('by_primary_driver_status', (q) => q.eq('primaryDriverId', args.driverId).eq('status', statusToMatch))
      .collect();

    for (const load of fallbackLoads) {
      if (seenLoadIds.has(load._id)) continue;
      seenLoadIds.add(load._id);

      const enrichedFallback = await enrichLoadDirectly(ctx, load);
      if (enrichedFallback) enrichedLoads.push(enrichedFallback);
    }

    // --- Fallback 2: carrier assignments where this driver is the assignedDriverId ---
    // For Completed loads, check all active-ish statuses since the assignment
    // status may not have been synced when the load was marked Completed.
    const assignmentStatuses =
      args.status === 'Assigned'
        ? (['AWARDED', 'IN_PROGRESS'] as const)
        : args.status === 'Canceled'
          ? (['CANCELED'] as const)
          : args.status === 'Expired'
            ? (['AWARDED', 'IN_PROGRESS'] as const)
            : (['COMPLETED', 'AWARDED', 'IN_PROGRESS'] as const);

    for (const aStatus of assignmentStatuses) {
      const assignments = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_assigned_driver', (q) => q.eq('assignedDriverId', args.driverId).eq('status', aStatus))
        .collect();

      for (const assignment of assignments) {
        if (seenLoadIds.has(assignment.loadId)) continue;
        seenLoadIds.add(assignment.loadId);

        const load = await ctx.db.get(assignment.loadId);
        if (!load) continue;

        const loadStatusMatchesFilter =
          (args.status === 'Assigned' && load.status === 'Assigned') ||
          (args.status === 'Completed' && load.status === 'Completed') ||
          (args.status === 'Canceled' && load.status === 'Canceled') ||
          (args.status === 'Expired' && load.status === 'Expired');
        if (!loadStatusMatchesFilter) continue;

        const enrichedFallback = await enrichLoadDirectly(ctx, load);
        if (enrichedFallback) enrichedLoads.push(enrichedFallback);
      }
    }

    enrichedLoads.sort((a, b) => b.createdAt - a.createdAt);
    return enrichedLoads;
  },
});

/**
 * Get loads assigned to a specific carrier partnership.
 * Primary source: dispatchLegs with carrierPartnershipId.
 * Fallback: loadCarrierAssignments for loads where the dispatch leg
 * wasn't properly linked (e.g., all legs were terminal when carrier was assigned).
 */
export const getByCarrierPartnership = query({
  args: {
    partnershipId: v.id('carrierPartnerships'),
    status: assignedLoadStatusValidator,
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership || (partnership.brokerOrgId !== callerOrgId && partnership.carrierOrgId !== callerOrgId)) {
      throw new Error('Not authorized for this organization');
    }

    const dispatchStatus = mapLoadStatusToDispatchStatus(args.status);
    const seenLoadIds = new Set<string>();
    const enrichedLoads: Array<Record<string, any>> = [];

    // --- Primary: dispatch legs indexed by carrier partnership ---
    let legsQuery;
    if (dispatchStatus) {
      legsQuery = ctx.db
        .query('dispatchLegs')
        .withIndex('by_carrier_partnership', (q) =>
          q.eq('carrierPartnershipId', args.partnershipId).eq('status', dispatchStatus),
        );
    } else {
      legsQuery = ctx.db
        .query('dispatchLegs')
        .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.partnershipId));
    }

    const allLegs = await legsQuery.order('desc').collect();

    for (const leg of allLegs) {
      if (seenLoadIds.has(leg.loadId)) continue;
      seenLoadIds.add(leg.loadId);

      if (args.status === 'Assigned') {
        if (leg.status === 'COMPLETED' || leg.status === 'CANCELED') continue;
      }

      if (leg.carrierPartnershipId !== args.partnershipId) continue;

      const enriched = await enrichLoadFromLeg(ctx, leg);
      if (!enriched) continue;

      const loadStatusMatchesFilter =
        (args.status === 'Assigned' && enriched.status === 'Assigned') ||
        (args.status === 'Completed' && enriched.status === 'Completed') ||
        (args.status === 'Canceled' && enriched.status === 'Canceled') ||
        (args.status === 'Expired' && enriched.status === 'Expired');
      if (!loadStatusMatchesFilter) continue;

      const assignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
        .filter((q) => q.eq(q.field('partnershipId'), args.partnershipId))
        .first();

      enrichedLoads.push({
        ...enriched,
        carrierRate: assignment?.carrierTotalAmount ?? assignment?.carrierRate,
      });
    }

    // --- Fallback: loadCarrierAssignments for loads not found via dispatch legs ---
    // This catches loads where the carrier was assigned but no dispatch leg
    // has this carrier's ID (e.g., all legs were COMPLETED/CANCELED at assignment time).
    // Note: `partnership` was already fetched and validated at the top of this handler.

    const carrierAssignments = partnership.carrierOrgId
      ? await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_carrier', (q) => q.eq('carrierOrgId', partnership.carrierOrgId!))
          .filter((q) => q.eq(q.field('partnershipId'), args.partnershipId))
          .collect()
      : await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_broker', (q) => q.eq('brokerOrgId', partnership.brokerOrgId))
          .filter((q) => q.eq(q.field('partnershipId'), args.partnershipId))
          .collect();

    for (const assignment of carrierAssignments) {
      if (seenLoadIds.has(assignment.loadId)) continue;
      seenLoadIds.add(assignment.loadId);

      if (args.status === 'Assigned') {
        if (assignment.status !== 'AWARDED' && assignment.status !== 'IN_PROGRESS') continue;
      } else if (args.status === 'Canceled') {
        if (assignment.status !== 'CANCELED') continue;
      } else if (args.status === 'Expired') {
        if (assignment.status !== 'AWARDED' && assignment.status !== 'IN_PROGRESS') continue;
      }

      const load = await ctx.db.get(assignment.loadId);
      if (!load) continue;

      const loadStatusMatchesFilter =
        (args.status === 'Assigned' && load.status === 'Assigned') ||
        (args.status === 'Completed' && load.status === 'Completed') ||
        (args.status === 'Canceled' && load.status === 'Canceled') ||
        (args.status === 'Expired' && load.status === 'Expired');
      if (!loadStatusMatchesFilter) continue;

      const facets = await getLoadFacets(ctx, load._id);
      enrichedLoads.push({
        _id: load._id as Id<'loadInformation'>,
        orderNumber: load.orderNumber as string,
        customerName: load.customerName as string | undefined,
        status: load.status as string,
        trackingStatus: load.trackingStatus as string,
        stopsCount: load.stopsCountDenorm ?? 0,
        origin:
          load.originCity !== undefined || load.originState !== undefined
            ? { city: load.originCity, state: load.originState }
            : null,
        destination:
          load.destinationCity !== undefined || load.destinationState !== undefined
            ? { city: load.destinationCity, state: load.destinationState }
            : null,
        firstStopDate: load.firstStopDate as string | undefined,
        parsedHcr: facets.hcr,
        parsedTripNumber: facets.trip,
        legStatus: 'PENDING',
        legLoadedMiles: load.effectiveMiles ?? 0,
        createdAt: load._creationTime as number,
        carrierRate: assignment.carrierTotalAmount ?? assignment.carrierRate,
      });
    }

    enrichedLoads.sort((a, b) => b.createdAt - a.createdAt);
    return enrichedLoads;
  },
});

// ==========================================
// AUTO-EXPIRE LOADS
// ==========================================

/**
 * Auto-expire loads whose first stop date has passed with no tracking activity.
 * Targets loads that are Open or Assigned where:
 *   - firstStopDate is in the past (before today)
 *   - trackingStatus is still 'Pending' (no GPS/tracking data received)
 *
 * Processes in batches to stay within transaction limits.
 * Called by cron job (daily).
 */
export const autoExpireStaleLoads = internalMutation({
  args: {
    orgId: v.optional(v.string()),
    statusIndex: v.optional(v.number()),
    phase: v.optional(v.union(v.literal('pending'), v.literal('in-transit'))),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const BATCH_SIZE = 200;
    const STALE_IN_TRANSIT_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
    const phase = args.phase ?? 'pending';

    // Dispatch phase: fan out to all orgs
    if (!args.orgId) {
      const orgs = await ctx.db.query('organizations').take(500);
      for (const org of orgs) {
        if (!org.workosOrgId) continue;
        await ctx.scheduler.runAfter(0, internal.loads.autoExpireStaleLoads, {
          orgId: org.workosOrgId,
          statusIndex: 0,
          phase: 'pending',
        });
      }
      return null;
    }

    // Phase 1: Expire Open/Assigned loads with trackingStatus 'Pending' and past firstStopDate
    if (phase === 'pending') {
      const statusesToCheck = ['Open', 'Assigned'] as const;
      const statusIdx = args.statusIndex ?? 0;
      if (statusIdx >= statusesToCheck.length) {
        // Pending phase done — move to in-transit phase
        await ctx.scheduler.runAfter(0, internal.loads.autoExpireStaleLoads, {
          orgId: args.orgId,
          phase: 'in-transit',
        });
        return null;
      }

      const status = statusesToCheck[statusIdx];
      let expired = 0;

      const loads = await ctx.db
        .query('loadInformation')
        .withIndex('by_status', (q) => q.eq('workosOrgId', args.orgId!).eq('status', status))
        .take(BATCH_SIZE * 5);

      for (const load of loads) {
        if (!load.firstStopDate || load.firstStopDate >= todayStr) continue;
        if (load.trackingStatus !== 'Pending') continue;

        // Route through applyLoadStatusUpdate so the Expired branch's leg
        // cascade fires. Direct ctx.db.patch here previously bypassed the
        // cascade and accumulated orphan PENDING legs.
        const result = await applyLoadStatusUpdate(ctx, {
          loadId: load._id,
          status: 'Expired',
        });
        await updateLoadCount(ctx, load.workosOrgId, result.previousStatus, result.nextStatus);
        expired++;

        if (expired >= BATCH_SIZE) break;
      }

      if (expired > 0) {
        console.log(`⏰ Auto-expired ${expired} stale ${status} loads for org ${args.orgId}`);
      }

      if (expired >= BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.loads.autoExpireStaleLoads, {
          orgId: args.orgId,
          statusIndex: statusIdx,
          phase: 'pending',
        });
      } else {
        await ctx.scheduler.runAfter(0, internal.loads.autoExpireStaleLoads, {
          orgId: args.orgId,
          statusIndex: (args.statusIndex ?? 0) + 1,
          phase: 'pending',
        });
      }

      return null;
    }

    // Phase 2: Expire In Transit loads with no activity for 3+ days
    if (phase === 'in-transit') {
      let expired = 0;
      const cutoff = now - STALE_IN_TRANSIT_THRESHOLD_MS;

      const loads = await ctx.db
        .query('loadInformation')
        .withIndex('by_org_tracking_status', (q) => q.eq('workosOrgId', args.orgId!).eq('trackingStatus', 'In Transit'))
        .take(BATCH_SIZE * 5);

      for (const load of loads) {
        if (!load.updatedAt || load.updatedAt >= cutoff) continue;

        // Route through applyLoadStatusUpdate so the Expired branch's leg
        // cascade fires. Same reasoning as the pending-phase loop above.
        const result = await applyLoadStatusUpdate(ctx, {
          loadId: load._id,
          status: 'Expired',
        });
        await updateLoadCount(ctx, load.workosOrgId, result.previousStatus, result.nextStatus);
        expired++;

        if (expired >= BATCH_SIZE) break;
      }

      if (expired > 0) {
        console.log(`⏰ Auto-expired ${expired} stale In Transit loads for org ${args.orgId}`);
      }

      // Re-schedule if there are more to process
      if (expired >= BATCH_SIZE) {
        await ctx.scheduler.runAfter(0, internal.loads.autoExpireStaleLoads, {
          orgId: args.orgId,
          phase: 'in-transit',
        });
      }
    }

    return null;
  },
});
