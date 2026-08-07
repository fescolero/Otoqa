import { ConvexError, v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { computeFacilityEvidence, type EvidencePoint } from './lib/facilityEvidence';
import { EVIDENCE_MIN_CHECKINS, EVIDENCE_MIN_DISTINCT_DAYS } from './lib/facilityEvidence';
import { INNER_RING_METERS } from './lib/geo';
import {
  buildFencePolygon,
  POLYGON_MIN_FIXES,
  POLYGON_MIN_DISTINCT_DAYS,
} from './lib/polygonGeo';
import { logAudit } from './lib/audit';

/**
 * Facility geofence sizing — layers 1 & 2 of the auto-sizing plan.
 *
 * Layer 1 (refinement): a nightly cron re-derives each VERIFIED facility's
 * radius from the trimmed spread (p95) of real check-in/checkout GPS fixes
 * and nudges radiusMeters toward it — the Geotab/project44 approach of
 * sizing zones from observed fleet behavior. Manual radii are never
 * touched. Steps are bounded (±25%/night) so one odd day can't yank a
 * fence, and converging takes a few nights by design.
 *
 * Layer 2 (seed): a new facility with no radius gets a first estimate from
 * the geocoder's viewport for its address — roughly proportional to the
 * place's footprint — clamped to the same [150m, INNER_RING] band. It only
 * fills the gap until real visits exist; evidence then takes over.
 */

const REFINE_BATCH = 50;
const REFINE_MAX_STOPS = 200; // newest linked stops considered per facility
const REFINE_STEP_LIMIT = 0.25; // max ±25% change per night
const REFINE_MIN_DELTA_METERS = 25; // ignore sub-noise adjustments
export const SEED_MIN_METERS = 150;

export const refineAllFacilityRadii = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query('facilities')
      .paginate({ cursor: args.cursor ?? null, numItems: REFINE_BATCH });

    for (const facility of page.page) {
      if (facility.isDeleted) continue;
      if (facility.verificationState !== 'VERIFIED') continue;
      if (facility.radiusSource === 'manual') continue;

      // Newest linked stops, bounded — a facility with years of history
      // refines from its recent visits, which is also the right recency
      // bias (docks move, yards get reconfigured).
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_facility', (q) => q.eq('facilityId', facility._id))
        .order('desc')
        .take(REFINE_MAX_STOPS);

      const points: EvidencePoint[] = [];
      for (const stop of stops) {
        if (stop.checkinOverride || stop.isRedirected) continue;
        const dayKey = stop.checkedInAt?.slice(0, 10);
        if (typeof stop.checkinLatitude === 'number' && typeof stop.checkinLongitude === 'number') {
          points.push({ latitude: stop.checkinLatitude, longitude: stop.checkinLongitude, dayKey });
        }
        if (
          typeof stop.checkoutLatitude === 'number' &&
          typeof stop.checkoutLongitude === 'number'
        ) {
          points.push({ latitude: stop.checkoutLatitude, longitude: stop.checkoutLongitude, dayKey });
        }
      }

      const evidence = computeFacilityEvidence(points);
      if (
        !evidence ||
        evidence.count < EVIDENCE_MIN_CHECKINS ||
        evidence.distinctDays < EVIDENCE_MIN_DISTINCT_DAYS
      ) {
        continue; // not enough signal — leave whatever radius stands
      }

      // NOTE: no spread gate here (unlike pin suggestion). Refinement
      // serves big facilities too — their legitimately-large p95 becomes a
      // legitimately-large radius, capped at the arrival ring.
      const target = evidence.suggestedRadiusMeters;
      const current = facility.radiusMeters ?? INNER_RING_METERS;
      const next = Math.round(
        Math.min(current * (1 + REFINE_STEP_LIMIT), Math.max(current * (1 - REFINE_STEP_LIMIT), target)),
      );

      // Polygon fence: with enough signal, the hull of the trimmed fixes
      // (buffered like the radius) becomes the arrival boundary's true
      // shape. Rebuilt each night from current evidence; kept as-is when
      // tonight's data is too thin to justify one but one already exists.
      const polygon =
        evidence.count >= POLYGON_MIN_FIXES && evidence.distinctDays >= POLYGON_MIN_DISTINCT_DAYS
          ? buildFencePolygon(
              points.map((p) => ({ lat: p.latitude, lng: p.longitude })),
              { lat: evidence.medianLatitude, lng: evidence.medianLongitude },
              evidence.p95SpreadMeters,
              100,
            )
          : null;

      const radiusChanged = Math.abs(next - current) >= REFINE_MIN_DELTA_METERS;
      const polygonChanged =
        polygon !== null &&
        JSON.stringify(polygon) !== JSON.stringify(facility.geofencePolygon ?? null);
      if (!radiusChanged && !polygonChanged) continue;

      await ctx.db.patch(facility._id, {
        ...(radiusChanged ? { radiusMeters: next } : {}),
        ...(polygon !== null ? { geofencePolygon: polygon } : {}),
        radiusSource: 'learned',
        updatedAt: Date.now(),
      });
      await logAudit(ctx, {
        organizationId: facility.workosOrgId,
        entityType: 'facility',
        entityId: facility._id,
        entityName: facility.name,
        action: 'updated',
        performedBy: 'system:radius-refinement',
        description:
          `Geofence auto-refined${radiusChanged ? ` radius ${current}m → ${next}m` : ''}` +
          `${polygonChanged ? `${radiusChanged ? ',' : ''} polygon ${polygon!.length} vertices` : ''} ` +
          `(target ${target}m from ${evidence.count} fixes across ${evidence.distinctDays} days, ` +
          `p95 spread ${evidence.p95SpreadMeters}m)`,
        changesBefore: JSON.stringify({
          radiusMeters: current,
          polygonVertices: facility.geofencePolygon?.length ?? 0,
        }),
        changesAfter: JSON.stringify({
          radiusMeters: radiusChanged ? next : current,
          polygonVertices: polygon?.length ?? facility.geofencePolygon?.length ?? 0,
        }),
      });
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.facilityRadius.refineAllFacilityRadii, {
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

// ─── Layer 2: viewport seed ──────────────────────────────────────────────

/**
 * Radius estimate from a geocoder viewport: half the larger span, clamped.
 * Pure — exported for tests.
 */
export function radiusFromViewport(
  northeast: { lat: number; lng: number },
  southwest: { lat: number; lng: number },
): number {
  const latSpanM = Math.abs(northeast.lat - southwest.lat) * 111_320;
  const midLatRad = (((northeast.lat + southwest.lat) / 2) * Math.PI) / 180;
  const lngSpanM = Math.abs(northeast.lng - southwest.lng) * 111_320 * Math.cos(midLatRad);
  const half = Math.max(latSpanM, lngSpanM) / 2;
  return Math.round(Math.min(INNER_RING_METERS, Math.max(SEED_MIN_METERS, half)));
}

export const getFacilityForSeed = internalQuery({
  args: { facilityId: v.id('facilities') },
  handler: async (ctx, args) => {
    const facility = await ctx.db.get(args.facilityId);
    if (!facility || facility.isDeleted || facility.radiusMeters !== undefined) return null;
    return {
      addressLine1: facility.addressLine1,
      city: facility.city,
      state: facility.state,
      postalCode: facility.postalCode,
    };
  },
});

export const applySeedRadius = internalMutation({
  args: { facilityId: v.id('facilities'), radiusMeters: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const facility = await ctx.db.get(args.facilityId);
    // Still unset only — a human or the evidence path may have won the race.
    if (!facility || facility.isDeleted || facility.radiusMeters !== undefined) return null;
    await ctx.db.patch(args.facilityId, {
      radiusMeters: args.radiusMeters,
      radiusSource: 'seed',
      updatedAt: Date.now(),
    });
    await logAudit(ctx, {
      organizationId: facility.workosOrgId,
      entityType: 'facility',
      entityId: args.facilityId,
      entityName: facility.name,
      action: 'updated',
      performedBy: 'system:radius-seed',
      description: `Geofence radius seeded at ${args.radiusMeters}m from the address viewport (pre-visit estimate)`,
      changesAfter: JSON.stringify({ radiusMeters: args.radiusMeters }),
    });
    return null;
  },
});

/**
 * Geocode the facility's address and seed radiusMeters from the result's
 * viewport. Fire-and-forget from facilities.create; silently no-ops when
 * the key is missing, the address doesn't geocode, or a radius appeared in
 * the meantime.
 */
export const seedRadiusFromViewport = internalAction({
  args: { facilityId: v.id('facilities') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) return null;

    const facility = await ctx.runQuery(internal.facilityRadius.getFacilityForSeed, {
      facilityId: args.facilityId,
    });
    if (!facility) return null;

    const address = [facility.addressLine1, facility.city, facility.state, facility.postalCode]
      .filter(Boolean)
      .join(', ');
    if (!address) return null;

    try {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.append('address', address);
      url.searchParams.append('key', apiKey);
      const response = await fetch(url.toString());
      if (!response.ok) throw new ConvexError(`geocode HTTP ${response.status}`);
      const data = await response.json();
      if (data.status !== 'OK' || !data.results?.length) return null;

      // `bounds` (real feature extent) beats `viewport` (display box) when
      // the geocoder provides it — premises/POIs usually do.
      const geometry = data.results[0].geometry;
      const box = geometry.bounds ?? geometry.viewport;
      if (!box?.northeast || !box?.southwest) return null;

      await ctx.runMutation(internal.facilityRadius.applySeedRadius, {
        facilityId: args.facilityId,
        radiusMeters: radiusFromViewport(box.northeast, box.southwest),
      });
    } catch (e) {
      // Seeding is best-effort: the default ring keeps working without it.
      console.warn(`[facilityRadius] seed failed for ${args.facilityId}: ${e instanceof Error ? e.message : e}`);
    }
    return null;
  },
});
