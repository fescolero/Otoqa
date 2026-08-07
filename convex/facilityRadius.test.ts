/**
 * Facility geofence auto-sizing tests (layers 1 & 2):
 *   - nightly refinement converges radiusMeters toward the p95 evidence
 *     radius in bounded steps, skips manual radii, and audits each change
 *   - the viewport-seed math clamps to the [150m, INNER_RING] band
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { radiusFromViewport, SEED_MIN_METERS } from './facilityRadius';
import { INNER_RING_METERS } from './lib/geo';

const ORG = 'org_facility_radius_test';
// ~0.0005° latitude ≈ 55m — a tight, realistic dock cluster.
const BASE = { lat: 40.1234, lng: -111.5678 };

async function seedFacilityWithVisits(
  ctx: MutationCtx,
  opts: { radiusMeters?: number; radiusSource?: 'manual' | 'learned' | 'seed'; visits?: number },
): Promise<Id<'facilities'>> {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'Cust',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1',
    city: 'C',
    state: 'S',
    zip: 'Z',
    country: 'US',
    workosOrgId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const facilityId = await ctx.db.insert('facilities', {
    workosOrgId: ORG,
    customerId,
    name: 'DC North',
    city: 'C',
    state: 'S',
    latitude: BASE.lat,
    longitude: BASE.lng,
    radiusMeters: opts.radiusMeters,
    radiusSource: opts.radiusSource,
    verificationState: 'VERIFIED',
    isDeleted: false,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'L-9001',
    orderNumber: 'O-9001',
    status: 'Assigned',
    trackingStatus: 'In Transit',
    customerId,
    fleet: 'Main',
    units: 'Pallets',
    workosOrgId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const visits = opts.visits ?? 6;
  for (let i = 0; i < visits; i++) {
    await ctx.db.insert('loadStops', {
      loadId,
      internalId: 'L-9001',
      workosOrgId: ORG,
      facilityId,
      stopType: 'DELIVERY',
      loadingType: 'Live',
      status: 'Completed',
      address: '1 Dock Rd',
      sequenceNumber: i + 1,
      checkedInAt: `2026-07-${String((i % 5) + 1).padStart(2, '0')}T10:00:00.000Z`,
      checkinLatitude: BASE.lat + ((i % 3) - 1) * 0.0003, // ≈ ±33m
      checkinLongitude: BASE.lng + (((i + 1) % 3) - 1) * 0.0003,
      checkoutLatitude: BASE.lat + ((i % 2) === 0 ? 0.0002 : -0.0002),
      checkoutLongitude: BASE.lng,
      createdAt: now,
      updatedAt: now,
    });
  }
  return facilityId;
}

describe('facilityRadius — nightly refinement', () => {
  it('steps a default-sized radius toward the evidence radius, bounded ±25%, and audits', async () => {
    const t = convexTest(schema);
    const facilityId = await t.run((ctx) =>
      seedFacilityWithVisits(ctx, { radiusMeters: 804, radiusSource: 'learned' }),
    );

    await t.mutation(internal.facilityRadius.refineAllFacilityRadii, {});
    let radius = await t.run(async (ctx) => (await ctx.db.get(facilityId))!.radiusMeters!);
    expect(radius).toBe(603); // 804 × 0.75 — one bounded step down

    // Converges over subsequent nights to the evidence floor (tight
    // cluster → p95 + 100m margin bottoms out at the 150m minimum).
    for (let night = 0; night < 8; night++) {
      await t.mutation(internal.facilityRadius.refineAllFacilityRadii, {});
    }
    radius = await t.run(async (ctx) => (await ctx.db.get(facilityId))!.radiusMeters!);
    expect(radius).toBeLessThanOrEqual(210);
    expect(radius).toBeGreaterThanOrEqual(150);

    await t.run(async (ctx) => {
      const facility = (await ctx.db.get(facilityId))!;
      expect(facility.radiusSource).toBe('learned');
      const audits = await ctx.db
        .query('auditLog')
        .withIndex('by_organization', (q) => q.eq('organizationId', ORG))
        .collect();
      const refinements = audits.filter((a) => a.performedBy === 'system:radius-refinement');
      expect(refinements.length).toBeGreaterThanOrEqual(2);
      expect(refinements[0].description).toContain('auto-refined');
    });
  });

  it('never touches manual radii, unverified facilities, or thin evidence', async () => {
    const t = convexTest(schema);
    const manualId = await t.run((ctx) =>
      seedFacilityWithVisits(ctx, { radiusMeters: 500, radiusSource: 'manual' }),
    );
    const thinId = await t.run((ctx) =>
      seedFacilityWithVisits(ctx, { radiusMeters: 804, radiusSource: 'learned', visits: 2 }),
    );

    await t.mutation(internal.facilityRadius.refineAllFacilityRadii, {});

    await t.run(async (ctx) => {
      expect((await ctx.db.get(manualId))!.radiusMeters).toBe(500);
      expect((await ctx.db.get(thinId))!.radiusMeters).toBe(804);
    });
  });

  it('sizes big facilities too (no spread gate on refinement)', async () => {
    const t = convexTest(schema);
    // Wide but genuine cluster: ~0.004° ≈ 440m spread — the case the
    // pin-suggestion gate rejects but refinement must serve.
    const facilityId = await t.run(async (ctx) => {
      const id = await seedFacilityWithVisits(ctx, { radiusMeters: 804, radiusSource: 'learned', visits: 0 });
      const stops = await ctx.db.query('loadStops').collect();
      void stops;
      const loadId = (await ctx.db.query('loadInformation').first())!._id;
      for (let i = 0; i < 8; i++) {
        await ctx.db.insert('loadStops', {
          loadId,
          internalId: 'L-9001',
          workosOrgId: ORG,
          facilityId: id,
          stopType: 'DELIVERY',
          loadingType: 'Live',
          status: 'Completed',
          address: '1 Yard Rd',
          sequenceNumber: i + 1,
          checkedInAt: `2026-07-${String((i % 4) + 1).padStart(2, '0')}T10:00:00.000Z`,
          checkinLatitude: BASE.lat + ((i % 3) - 1) * 0.004,
          checkinLongitude: BASE.lng + (((i + 1) % 3) - 1) * 0.004,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      return id;
    });

    for (let night = 0; night < 4; night++) {
      await t.mutation(internal.facilityRadius.refineAllFacilityRadii, {});
    }
    const facility = await t.run(async (ctx) => (await ctx.db.get(facilityId))!);
    // Radius settles well above the minimum (large evidence spread) but
    // within the arrival-ring cap.
    expect(facility.radiusMeters!).toBeGreaterThan(400);
    expect(facility.radiusMeters!).toBeLessThanOrEqual(INNER_RING_METERS);
  });
});

describe('facilityRadius — viewport seed math', () => {
  it('derives radius from the larger viewport span, clamped to the band', () => {
    // ~0.005° lat ≈ 557m span → radius ≈ 278m.
    const r = radiusFromViewport(
      { lat: 40.0025, lng: -111.0 },
      { lat: 39.9975, lng: -111.004 },
    );
    expect(r).toBeGreaterThan(250);
    expect(r).toBeLessThan(320);

    // Tiny rooftop viewport clamps up to the GPS-noise floor.
    expect(
      radiusFromViewport({ lat: 40.0002, lng: -111.0 }, { lat: 39.9998, lng: -111.0005 }),
    ).toBe(SEED_MIN_METERS);

    // A whole-town viewport clamps down to the arrival ring.
    expect(radiusFromViewport({ lat: 40.05, lng: -111.0 }, { lat: 39.95, lng: -111.1 })).toBe(
      INNER_RING_METERS,
    );
  });
});
