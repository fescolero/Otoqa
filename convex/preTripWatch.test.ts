/**
 * Tests for pre-trip geofence arming — "the session starts the tracking."
 *
 *   - loadTrackingState.armPreTripWatchForDriver: arms an arrival-only
 *     watch at the first stop of the driver's next PENDING leg; one watch
 *     at a time; never touches mid-load rows; deletes stale pre-trip rows;
 *     re-binds rows left on a previous session.
 *   - geofenceEvaluator.evaluatePing over a pre-trip row: session pings
 *     fire APPROACHING/ARRIVED for stop 1 before any check-in.
 *   - setFrontierOnCheckIn graduates the pre-trip row into a normal
 *     mid-load frontier (preTrip cleared, departure watch armed).
 *   - driverLocations.ingestBatch lazily arms on session-only batches.
 *
 * Data-isolation invariant under test throughout: only the driver's next
 * leg ever gets a fence, and the only per-load artifacts produced pre-trip
 * are geofenceEvents at that load's own facility.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { evaluatePing } from './geofenceEvaluator';
import { armPreTripWatchForDriver, setFrontierOnCheckIn } from './loadTrackingState';
import { ingestBatch } from './driverLocations';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_pretrip';

const STOP = { lat: 40, lng: -75 };
const KM = 1 / 111.32; // ~1 km in degrees latitude

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Pre',
    lastName: 'Trip',
    email: 'pretrip@test.com',
    phone: '+15550002222',
    licenseState: 'PA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2024-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: ORG,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });
  const truckId = await ctx.db.insert('trucks', {
    unitId: 'T-200',
    vin: 'VIN-TEST-200',
    status: 'Active',
    organizationId: ORG,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = await ctx.db.insert('driverSessions', {
    driverId,
    truckId,
    organizationId: ORG,
    startedAt: now - 60 * 60_000,
    status: 'active',
  });
  const customerId = await ctx.db.insert('customers', {
    name: 'Pretrip Shipper',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 Dock St',
    city: 'Philadelphia',
    state: 'Pennsylvania',
    zip: '19106',
    country: 'USA',
    workosOrgId: ORG,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });
  return { driverId, truckId, sessionId, customerId, now };
}

async function insertLoadWithStops(
  ctx: MutationCtx,
  f: { customerId: Id<'customers'> },
  internalId: string,
  stop1: { lat: number; lng: number } = STOP,
) {
  const now = Date.now();
  const loadId = await ctx.db.insert('loadInformation', {
    internalId,
    orderNumber: `ORD-${internalId}`,
    status: 'Assigned',
    trackingStatus: 'In Transit',
    customerId: f.customerId,
    fleet: 'Test Fleet',
    units: 'Pallets',
    workosOrgId: ORG,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });
  const insertStop = (
    sequenceNumber: number,
    stopType: 'PICKUP' | 'DELIVERY',
    lat: number,
    lng: number,
  ) =>
    ctx.db.insert('loadStops', {
      loadId,
      internalId,
      sequenceNumber,
      stopType,
      loadingType: 'APPT',
      address: `${sequenceNumber} Dock St`,
      city: 'Philadelphia',
      state: 'PA',
      latitude: lat,
      longitude: lng,
      workosOrgId: ORG,
      createdBy: 'user_test',
      createdAt: now,
      updatedAt: now,
    });
  const stop1Id = await insertStop(1, 'PICKUP', stop1.lat, stop1.lng);
  const stop2Id = await insertStop(2, 'DELIVERY', stop1.lat + 50 * KM, stop1.lng);
  return { loadId, stop1Id, stop2Id };
}

function insertLeg(
  ctx: MutationCtx,
  args: {
    loadId: Id<'loadInformation'>;
    driverId: Id<'drivers'>;
    startStopId: Id<'loadStops'>;
    endStopId: Id<'loadStops'>;
    status: 'PENDING' | 'ACTIVE' | 'COMPLETED';
    plannedStartAt?: number;
  },
) {
  return ctx.db.insert('dispatchLegs', {
    loadId: args.loadId,
    driverId: args.driverId,
    sequence: 1,
    startStopId: args.startStopId,
    endStopId: args.endStopId,
    legLoadedMiles: 0,
    legEmptyMiles: 0,
    status: args.status,
    plannedStartAt: args.plannedStartAt,
    workosOrgId: ORG,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

async function getRows(ctx: MutationCtx, loadId: Id<'loadInformation'>) {
  return ctx.db
    .query('loadTrackingState')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();
}

describe('armPreTripWatchForDriver', () => {
  it('arms an arrival-only watch at stop 1 of the next pending leg', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const load = await insertLoadWithStops(ctx, f, 'L-2001');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
      });

      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await armPreTripWatchForDriver(ctx, session, Date.now());

      const rows = await getRows(ctx, load.loadId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.preTrip).toBe(true);
      expect(row.sessionId).toBe(f.sessionId);
      expect(row.driverId).toBe(f.driverId);
      expect(row.currentStopSequenceNumber).toBe(1);
      expect(row.currentStopLat).toBe(STOP.lat);
      expect(row.currentStopLng).toBe(STOP.lng);
      expect(row.departureWatch).toBeUndefined();
      expect(row.approachingFired).toBe(false);
      expect(row.arrivedFired).toBe(false);
    });
  });

  it('arms only the NEXT pending leg by plannedStartAt — the later load gets no fence', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      const loadA = await insertLoadWithStops(ctx, f, 'L-2002');
      const loadB = await insertLoadWithStops(ctx, f, 'L-2003');
      await insertLeg(ctx, {
        loadId: loadA.loadId,
        driverId: f.driverId,
        startStopId: loadA.stop1Id,
        endStopId: loadA.stop2Id,
        status: 'PENDING',
        plannedStartAt: session.startedAt + 4 * 60 * 60_000,
      });
      await insertLeg(ctx, {
        loadId: loadB.loadId,
        driverId: f.driverId,
        startStopId: loadB.stop1Id,
        endStopId: loadB.stop2Id,
        status: 'PENDING',
        plannedStartAt: session.startedAt + 60 * 60_000,
      });

      await armPreTripWatchForDriver(ctx, session, Date.now());

      // B is sooner → B armed, A untouched.
      expect(await getRows(ctx, loadB.loadId)).toHaveLength(1);
      expect(await getRows(ctx, loadA.loadId)).toHaveLength(0);
    });
  });

  it('does not arm when the driver has an ACTIVE leg, and deletes stale pre-trip rows', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      const active = await insertLoadWithStops(ctx, f, 'L-2004');
      const queued = await insertLoadWithStops(ctx, f, 'L-2005');
      await insertLeg(ctx, {
        loadId: active.loadId,
        driverId: f.driverId,
        startStopId: active.stop1Id,
        endStopId: active.stop2Id,
        status: 'ACTIVE',
      });
      await insertLeg(ctx, {
        loadId: queued.loadId,
        driverId: f.driverId,
        startStopId: queued.stop1Id,
        endStopId: queued.stop2Id,
        status: 'PENDING',
      });
      // Stale pre-trip row from before the driver went active on `active`.
      await ctx.db.insert('loadTrackingState', {
        loadId: queued.loadId,
        sessionId: f.sessionId,
        driverId: f.driverId,
        organizationId: ORG,
        currentStopSequenceNumber: 1,
        currentStopLat: STOP.lat,
        currentStopLng: STOP.lng,
        approachingFired: false,
        arrivedFired: false,
        preTrip: true,
        updatedAt: Date.now(),
      });

      await armPreTripWatchForDriver(ctx, session, Date.now());

      expect(await getRows(ctx, queued.loadId)).toHaveLength(0);
      expect(await getRows(ctx, active.loadId)).toHaveLength(0);
    });
  });

  it('ignores pending legs planned outside the shift window', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      const load = await insertLoadWithStops(ctx, f, 'L-2006');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
        // Tomorrow's load — outside startedAt + 18h.
        plannedStartAt: session.startedAt + 30 * 60 * 60_000,
      });

      await armPreTripWatchForDriver(ctx, session, Date.now());

      expect(await getRows(ctx, load.loadId)).toHaveLength(0);
    });
  });

  it('never clobbers an existing mid-load frontier for the same load', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      const load = await insertLoadWithStops(ctx, f, 'L-2007');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
      });
      // Another driver is mid-load (pre-handoff): row without preTrip.
      const otherDriverId = await ctx.db.insert('drivers', {
        firstName: 'Other',
        lastName: 'Driver',
        email: 'other@test.com',
        phone: '+15550003333',
        licenseState: 'PA',
        licenseExpiration: '2030-01-01',
        licenseClass: 'A',
        hireDate: '2024-01-01',
        employmentStatus: 'Active',
        employmentType: 'Full-time',
        organizationId: ORG,
        createdBy: 'user_test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      const otherSessionId = await ctx.db.insert('driverSessions', {
        driverId: otherDriverId,
        truckId: f.truckId,
        organizationId: ORG,
        startedAt: Date.now() - 30 * 60_000,
        status: 'active',
      });
      const midLoadRowId = await ctx.db.insert('loadTrackingState', {
        loadId: load.loadId,
        sessionId: otherSessionId,
        driverId: otherDriverId,
        organizationId: ORG,
        currentStopSequenceNumber: 2,
        currentStopLat: STOP.lat + 50 * KM,
        currentStopLng: STOP.lng,
        approachingFired: false,
        arrivedFired: false,
        updatedAt: Date.now(),
      });

      await armPreTripWatchForDriver(ctx, session, Date.now());

      const row = (await ctx.db.get(midLoadRowId)) as Doc<'loadTrackingState'>;
      expect(row.preTrip).toBeUndefined();
      expect(row.driverId).toBe(otherDriverId);
      expect(row.currentStopSequenceNumber).toBe(2);
      expect(await getRows(ctx, load.loadId)).toHaveLength(1);
    });
  });

  it('re-binds a pre-trip row left on a previous session', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const load = await insertLoadWithStops(ctx, f, 'L-2008');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
      });
      const oldSessionId = await ctx.db.insert('driverSessions', {
        driverId: f.driverId,
        truckId: f.truckId,
        organizationId: ORG,
        startedAt: Date.now() - 26 * 60 * 60_000,
        endedAt: Date.now() - 12 * 60 * 60_000,
        status: 'completed',
        endReason: 'driver_manual',
      });
      await ctx.db.insert('loadTrackingState', {
        loadId: load.loadId,
        sessionId: oldSessionId,
        driverId: f.driverId,
        organizationId: ORG,
        currentStopSequenceNumber: 1,
        currentStopLat: STOP.lat,
        currentStopLng: STOP.lng,
        approachingFired: true,
        arrivedFired: false,
        preTrip: true,
        updatedAt: Date.now(),
      });

      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await armPreTripWatchForDriver(ctx, session, Date.now());

      const rows = await getRows(ctx, load.loadId);
      expect(rows).toHaveLength(1);
      expect(rows[0].sessionId).toBe(f.sessionId);
      expect(rows[0].preTrip).toBe(true);
    });
  });

  it('is a read-only no-op when the watch is already correctly armed', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const load = await insertLoadWithStops(ctx, f, 'L-2009');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
      });
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await armPreTripWatchForDriver(ctx, session, 111_111);
      const before = (await getRows(ctx, load.loadId))[0];
      await armPreTripWatchForDriver(ctx, session, 222_222);
      const after = (await getRows(ctx, load.loadId))[0];
      expect(after.updatedAt).toBe(before.updatedAt);
    });
  });
});

describe('pre-trip watch + evaluator', () => {
  it('session pings fire APPROACHING and ARRIVED for stop 1 before any check-in', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const load = await insertLoadWithStops(ctx, f, 'L-2010');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
      });
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await armPreTripWatchForDriver(ctx, session, Date.now());

      const t0 = Date.now();
      // ~6 km out — inside the outer ring, outside the inner.
      await evaluatePing(ctx, {
        loadId: load.loadId,
        sessionId: f.sessionId,
        ping: { latitude: STOP.lat + 6 * KM, longitude: STOP.lng, recordedAt: t0 },
      });
      // At the stop.
      await evaluatePing(ctx, {
        loadId: load.loadId,
        sessionId: f.sessionId,
        ping: { latitude: STOP.lat, longitude: STOP.lng, recordedAt: t0 + 5 * 60_000 },
      });

      const events = await ctx.db
        .query('geofenceEvents')
        .withIndex('by_load', (q) => q.eq('loadId', load.loadId))
        .collect();
      const types = events.map((e) => e.eventType).sort();
      expect(types).toEqual(['APPROACHING', 'ARRIVED']);
      const arrived = events.find((e) => e.eventType === 'ARRIVED')!;
      expect(arrived.stopSequenceNumber).toBe(1);
      expect(arrived.sessionId).toBe(f.sessionId);
      expect(arrived.triggeredAt).toBe(t0 + 5 * 60_000);
    });
  });

  it('first check-in graduates the pre-trip row into a mid-load frontier', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const load = await insertLoadWithStops(ctx, f, 'L-2011');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
      });
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await armPreTripWatchForDriver(ctx, session, Date.now());

      const stop1 = (await ctx.db.get(load.stop1Id)) as Doc<'loadStops'>;
      await setFrontierOnCheckIn(ctx, {
        stop: stop1,
        sessionId: f.sessionId,
        driverId: f.driverId,
        organizationId: ORG,
        now: Date.now(),
      });

      const rows = await getRows(ctx, load.loadId);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.preTrip).toBeUndefined();
      expect(row.currentStopSequenceNumber).toBe(2);
      expect(row.departureWatch?.stopSequenceNumber).toBe(1);
    });
  });
});

describe('ingestBatch lazy arming', () => {
  it('a session-only batch arms the next pending leg and schedules its evaluation', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const load = await insertLoadWithStops(ctx, f, 'L-2012');
      await insertLeg(ctx, {
        loadId: load.loadId,
        driverId: f.driverId,
        startStopId: load.stop1Id,
        endStopId: load.stop2Id,
        status: 'PENDING',
      });

      const outcome = await ingestBatch(
        ctx,
        [
          {
            driverId: f.driverId,
            sessionId: f.sessionId,
            latitude: STOP.lat + 6 * KM,
            longitude: STOP.lng,
            trackingType: 'SESSION_ROUTE',
            recordedAt: Date.now(),
          },
        ],
        ORG,
      );
      expect(outcome.inserted).toBe(1);

      const rows = await getRows(ctx, load.loadId);
      expect(rows).toHaveLength(1);
      expect(rows[0].preTrip).toBe(true);
      expect(rows[0].currentStopSequenceNumber).toBe(1);
    });
  });

  it('a session-only batch does NOT arm anything when the driver has no pending legs', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const load = await insertLoadWithStops(ctx, f, 'L-2013');

      await ingestBatch(
        ctx,
        [
          {
            driverId: f.driverId,
            sessionId: f.sessionId,
            latitude: STOP.lat,
            longitude: STOP.lng,
            trackingType: 'SESSION_ROUTE',
            recordedAt: Date.now(),
          },
        ],
        ORG,
      );

      expect(await getRows(ctx, load.loadId)).toHaveLength(0);
    });
  });
});
