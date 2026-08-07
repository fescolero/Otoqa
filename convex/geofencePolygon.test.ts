/**
 * Polygon geofences in the evaluator: when a fence polygon is snapshotted
 * onto the tracking state, ARRIVED/DEPARTED decisions follow the SHAPE —
 * not the radius the polygon replaces.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { evaluatePing } from './geofenceEvaluator';

const ORG = 'org_polygon_test';
const CENTER = { lat: 40.001, lng: -111.001 };
// Rectangle ~222m (N-S) × ~170m (E-W) centered on CENTER.
const RECT = [
  { lat: 40.0, lng: -111.0 },
  { lat: 40.002, lng: -111.0 },
  { lat: 40.002, lng: -111.002 },
  { lat: 40.0, lng: -111.002 },
];
// Inside the rectangle near its east edge — ~85m east of center.
const INSIDE_EDGE = { latitude: 40.001, longitude: -111.0001 };
// ~330m north of center: inside any default ring, OUTSIDE the rectangle.
const OUTSIDE_NORTH = { latitude: 40.004, longitude: -111.001 };
const FAR_AWAY = { latitude: 40.05, longitude: -111.001 };

async function seedTracking(
  ctx: MutationCtx,
  row: Record<string, unknown>,
): Promise<Id<'loadInformation'>> {
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
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'L-PG1',
    orderNumber: 'O-PG1',
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
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'P',
    lastName: 'G',
    email: 'p@t.co',
    phone: '+15305550600',
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2024-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const truckId = await ctx.db.insert('trucks', {
    unitId: 'T-PG',
    vin: '1FUJA6CK95LU00001',
    status: 'Active',
    organizationId: ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = await ctx.db.insert('driverSessions', {
    driverId,
    truckId,
    organizationId: ORG,
    startedAt: now - 3_600_000,
    status: 'active',
  });
  await ctx.db.insert('loadTrackingState', {
    loadId,
    sessionId,
    driverId,
    organizationId: ORG,
    approachingFired: true, // isolate ARRIVED/DEPARTED behavior
    arrivedFired: false,
    updatedAt: now,
    ...row,
  });
  return loadId;
}

describe('evaluatePing with polygon fences', () => {
  it('ARRIVED follows the polygon: fires inside it, not inside the old circle', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedTracking(ctx, {
        currentStopSequenceNumber: 2,
        currentStopLat: CENTER.lat,
        currentStopLng: CENTER.lng,
        currentStopArrivalRadiusMeters: 804, // circle would say "arrived" at OUTSIDE_NORTH
        currentStopPolygon: RECT,
      });

      // 330m from the pin — well inside the 804m circle, but outside the
      // rectangle. Polygon fence must NOT fire.
      await evaluatePing(ctx, {
        loadId,
        ping: { ...OUTSIDE_NORTH, recordedAt: 10_000 },
      });
      expect(await ctx.db.query('geofenceEvents').collect()).toHaveLength(0);

      // Inside the rectangle → ARRIVED.
      await evaluatePing(ctx, {
        loadId,
        ping: { ...INSIDE_EDGE, recordedAt: 20_000 },
      });
      const events = await ctx.db.query('geofenceEvents').collect();
      expect(events.map((e) => e.eventType)).toEqual(['ARRIVED']);
    });
  });

  it('DEPARTED follows the exit polygon with the two-ping confirm intact', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedTracking(ctx, {
        arrivedFired: true,
        departureWatch: {
          stopSequenceNumber: 1,
          lat: CENTER.lat,
          lng: CENTER.lng,
          armedAt: 1_000,
          exitRadiusMeters: 100, // circle would say "departed" at INSIDE_EDGE…
          exitPolygon: RECT, // …but the polygon keeps it inside
        },
      });

      // Inside the exit polygon (even though >100m radius) → no candidate.
      await evaluatePing(ctx, { loadId, ping: { ...INSIDE_EDGE, recordedAt: 10_000 } });
      let events = await ctx.db.query('geofenceEvents').collect();
      expect(events).toHaveLength(0);

      // Two successive pings outside the polygon → candidate then confirm,
      // DEPARTED stamped with the candidate's time.
      await evaluatePing(ctx, { loadId, ping: { ...OUTSIDE_NORTH, recordedAt: 20_000 } });
      await evaluatePing(ctx, { loadId, ping: { ...FAR_AWAY, recordedAt: 30_000 } });
      events = await ctx.db.query('geofenceEvents').collect();
      expect(events.map((e) => e.eventType)).toEqual(['DEPARTED']);
      expect(events[0].triggeredAt).toBe(20_000);
    });
  });

  it('falls back to circles when no polygon is snapshotted (regression guard)', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedTracking(ctx, {
        currentStopSequenceNumber: 2,
        currentStopLat: CENTER.lat,
        currentStopLng: CENTER.lng,
        currentStopArrivalRadiusMeters: 500,
      });
      await evaluatePing(ctx, { loadId, ping: { ...OUTSIDE_NORTH, recordedAt: 10_000 } });
      const events = await ctx.db.query('geofenceEvents').collect();
      expect(events.map((e) => e.eventType)).toEqual(['ARRIVED']); // 330m < 500m circle
    });
  });
});
