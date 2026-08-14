/**
 * Tests for geofence auto-advance — the tap-less fallback layer.
 *
 *   - Evaluator: ARRIVED arms the stop's exit watch itself (no check-in
 *     needed); DEPARTED advances the arrival watch to the next unvisited
 *     stop when no tap moved it. A full trip detects end-to-end with zero
 *     driver taps.
 *   - Normal tap flow unchanged: a check-in that already advanced the
 *     watch is not clobbered by the departure auto-advance.
 *   - runTapGraceCheck: stamps autoArrivedAt/autoDepartedAt + advances
 *     stop status with GPS attribution, never touches the manual fields,
 *     logs one missed-tap console event per stop, and no-ops when the
 *     driver tapped in time.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { evaluatePing, runTapGraceCheck, TAP_GRACE_MS } from './geofenceEvaluator';
import { armPreTripWatchForDriver, setFrontierOnCheckIn } from './loadTrackingState';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_autoadvance';

const STOP = { lat: 40, lng: -75 };
const KM = 1 / 111.32;
const STOP2 = { lat: STOP.lat + 50 * KM, lng: STOP.lng };

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Auto',
    lastName: 'Advance',
    email: 'auto@test.com',
    phone: '+15550004444',
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
    unitId: 'T-300',
    vin: 'VIN-TEST-300',
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
    name: 'AutoAdvance Shipper',
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
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'L-3001',
    orderNumber: 'ORD-3001',
    status: 'Assigned',
    trackingStatus: 'In Transit',
    customerId,
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
      internalId: 'L-3001',
      sequenceNumber,
      stopType,
      loadingType: 'APPT',
      status: 'Pending',
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
  const stop1Id = await insertStop(1, 'PICKUP', STOP.lat, STOP.lng);
  const stop2Id = await insertStop(2, 'DELIVERY', STOP2.lat, STOP2.lng);
  await ctx.db.insert('dispatchLegs', {
    loadId,
    driverId,
    sequence: 1,
    startStopId: stop1Id,
    endStopId: stop2Id,
    legLoadedMiles: 0,
    legEmptyMiles: 0,
    status: 'PENDING',
    workosOrgId: ORG,
    createdAt: now,
    updatedAt: now,
  });
  return { driverId, truckId, sessionId, customerId, loadId, stop1Id, stop2Id };
}

async function getRow(ctx: MutationCtx, loadId: Id<'loadInformation'>) {
  return ctx.db
    .query('loadTrackingState')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .first();
}

async function eventsFor(ctx: MutationCtx, loadId: Id<'loadInformation'>) {
  return ctx.db
    .query('geofenceEvents')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();
}

describe('geofence auto-advance', () => {
  it('detects a full tap-less trip end-to-end: arrive → depart → next stop arrives', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await armPreTripWatchForDriver(ctx, session, Date.now());

      const t0 = Date.now();
      const ping = (lat: number, lng: number, at: number) =>
        evaluatePing(ctx, {
          loadId: f.loadId,
          sessionId: f.sessionId,
          ping: { latitude: lat, longitude: lng, recordedAt: at },
        });

      // At stop 1 — ARRIVED fires, exit watch arms itself.
      await ping(STOP.lat, STOP.lng, t0);
      let row = (await getRow(ctx, f.loadId))!;
      expect(row.arrivedFired).toBe(true);
      expect(row.departureWatch?.stopSequenceNumber).toBe(1);
      expect(row.departureWatch?.armedAt).toBe(t0);
      expect(row.preTrip).toBeUndefined();

      // Two pings out past the exit ring — candidate then confirm.
      await ping(STOP.lat + 2 * KM, STOP.lng, t0 + 10 * 60_000);
      await ping(STOP.lat + 3 * KM, STOP.lng, t0 + 12 * 60_000);

      row = (await getRow(ctx, f.loadId))!;
      expect(row.departureWatch).toBeUndefined();
      // Arrival watch auto-advanced to stop 2.
      expect(row.currentStopSequenceNumber).toBe(2);
      expect(row.arrivedFired).toBe(false);

      // At stop 2 — ARRIVED fires for the delivery too.
      await ping(STOP2.lat, STOP2.lng, t0 + 60 * 60_000);
      row = (await getRow(ctx, f.loadId))!;
      expect(row.arrivedFired).toBe(true);
      expect(row.departureWatch?.stopSequenceNumber).toBe(2);

      const events = await eventsFor(ctx, f.loadId);
      const byType = (seq: number, type: string) =>
        events.find((e) => e.stopSequenceNumber === seq && e.eventType === type);
      expect(byType(1, 'ARRIVED')?.triggeredAt).toBe(t0);
      expect(byType(1, 'DEPARTED')?.triggeredAt).toBe(t0 + 10 * 60_000);
      expect(byType(2, 'ARRIVED')).toBeDefined();
    });
  });

  it('does not clobber an arrival watch a manual check-in already advanced', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      await armPreTripWatchForDriver(ctx, session, Date.now());

      const t0 = Date.now();
      await evaluatePing(ctx, {
        loadId: f.loadId,
        sessionId: f.sessionId,
        ping: { latitude: STOP.lat, longitude: STOP.lng, recordedAt: t0 },
      });

      // Driver taps check-in — the normal flow advances the watch to stop 2
      // and re-arms the exit watch with the tap time.
      const stop1 = (await ctx.db.get(f.stop1Id)) as Doc<'loadStops'>;
      await ctx.db.patch(f.stop1Id, { checkedInAt: new Date(t0 + 2 * 60_000).toISOString() });
      await setFrontierOnCheckIn(ctx, {
        stop: stop1,
        sessionId: f.sessionId,
        driverId: f.driverId,
        organizationId: ORG,
        now: t0 + 2 * 60_000,
      });
      let row = (await getRow(ctx, f.loadId))!;
      expect(row.departureWatch?.armedAt).toBe(t0 + 2 * 60_000);

      // Exit pings — DEPARTED fires; the watch already points at stop 2, so
      // the departure half must skip its auto-advance (no flag reset).
      await evaluatePing(ctx, {
        loadId: f.loadId,
        sessionId: f.sessionId,
        ping: { latitude: STOP.lat + 2 * KM, longitude: STOP.lng, recordedAt: t0 + 10 * 60_000 },
      });
      await evaluatePing(ctx, {
        loadId: f.loadId,
        sessionId: f.sessionId,
        ping: { latitude: STOP.lat + 3 * KM, longitude: STOP.lng, recordedAt: t0 + 12 * 60_000 },
      });

      row = (await getRow(ctx, f.loadId))!;
      expect(row.currentStopSequenceNumber).toBe(2);
      const departed = (await eventsFor(ctx, f.loadId)).find((e) => e.eventType === 'DEPARTED');
      expect(departed?.stopSequenceNumber).toBe(1);
    });
  });

  it('grace check (checkin): stamps autoArrivedAt, advances status, logs one console event', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const detectedAt = Date.now() - TAP_GRACE_MS;

      await runTapGraceCheck(ctx, { stopId: f.stop1Id, kind: 'checkin', detectedAt });

      const stop = (await ctx.db.get(f.stop1Id)) as Doc<'loadStops'>;
      expect(stop.autoArrivedAt).toBe(detectedAt);
      expect(stop.status).toBe('In Transit');
      expect(stop.checkedInAt).toBeUndefined(); // manual field untouched

      const events = (await ctx.db.query('systemEvents').collect()).filter(
        (e) => e.code === 'geofence.missed_checkin',
      );
      expect(events).toHaveLength(1);
      expect(events[0].orgId).toBe(ORG);

      // Idempotent: a second firing changes nothing and logs nothing new.
      await runTapGraceCheck(ctx, { stopId: f.stop1Id, kind: 'checkin', detectedAt });
      const eventsAfter = (await ctx.db.query('systemEvents').collect()).filter(
        (e) => e.code === 'geofence.missed_checkin',
      );
      expect(eventsAfter).toHaveLength(1);
    });
  });

  it('grace check (checkin): no-op when the driver tapped within the window', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.patch(f.stop1Id, { checkedInAt: new Date().toISOString() });

      await runTapGraceCheck(ctx, { stopId: f.stop1Id, kind: 'checkin', detectedAt: Date.now() });

      const stop = (await ctx.db.get(f.stop1Id)) as Doc<'loadStops'>;
      expect(stop.autoArrivedAt).toBeUndefined();
      expect(stop.status).toBe('Pending'); // untouched
      expect(await ctx.db.query('systemEvents').collect()).toHaveLength(0);
    });
  });

  it('grace check (checkout): completes the stop; logs only when the driver had checked in', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const detectedAt = Date.now() - TAP_GRACE_MS;

      // Stop 1: driver checked in but never out → missed_checkout event.
      await ctx.db.patch(f.stop1Id, {
        checkedInAt: new Date(detectedAt - 30 * 60_000).toISOString(),
        status: 'In Transit',
      });
      await runTapGraceCheck(ctx, { stopId: f.stop1Id, kind: 'checkout', detectedAt });
      const stop1 = (await ctx.db.get(f.stop1Id)) as Doc<'loadStops'>;
      expect(stop1.autoDepartedAt).toBe(detectedAt);
      expect(stop1.status).toBe('Completed');
      expect(stop1.checkedOutAt).toBeUndefined();

      // Stop 2: fully passive (no check-in) → progress recorded, but the
      // missed_checkin event is the one coaching signal; no checkout event.
      await runTapGraceCheck(ctx, { stopId: f.stop2Id, kind: 'checkout', detectedAt });
      const stop2 = (await ctx.db.get(f.stop2Id)) as Doc<'loadStops'>;
      expect(stop2.autoDepartedAt).toBe(detectedAt);
      expect(stop2.status).toBe('Completed');

      const codes = (await ctx.db.query('systemEvents').collect()).map((e) => e.code);
      expect(codes).toEqual(['geofence.missed_checkout']);
    });
  });

  it('grace check never touches a canceled stop', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.patch(f.stop1Id, { status: 'Canceled' });

      await runTapGraceCheck(ctx, { stopId: f.stop1Id, kind: 'checkin', detectedAt: Date.now() });

      const stop = (await ctx.db.get(f.stop1Id)) as Doc<'loadStops'>;
      expect(stop.autoArrivedAt).toBeUndefined();
      expect(stop.status).toBe('Canceled');
      expect(await ctx.db.query('systemEvents').collect()).toHaveLength(0);
    });
  });
});
