/**
 * Tests for the geofence session-timestamp feature (Phase 3):
 *   - geofenceEvaluator.evaluatePing — arrival one-shots, departure
 *     candidate/confirm debounce, accuracy gate, event dedup, loadCompleted
 *     row cleanup.
 *   - loadTrackingState helpers — setFrontierOnCheckIn watch placement,
 *     releaseFrontierOnLoadComplete keep-vs-delete, session-end cleanup.
 *   - driverSessions.buildSessionStopTimeline — event/manual composition
 *     and dwell math.
 *
 * Runs against the real schema via convex-test. Coordinates use ~0.009° of
 * latitude ≈ 1 km at the equator for easy distance reasoning.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { evaluatePing } from './geofenceEvaluator';
import {
  setFrontierOnCheckIn,
  releaseFrontierOnLoadComplete,
  deleteCompletedRowsForSession,
} from './loadTrackingState';
import { buildSessionStopTimeline } from './driverSessions';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_geofence';

// Stop at the origin; offsets in degrees latitude (1° ≈ 111.32 km).
const STOP = { lat: 40, lng: -75 };
const KM = 1 / 111.32; // ~1 km in degrees latitude
const AT_STOP = { latitude: STOP.lat, longitude: STOP.lng };
const KM_2 = { latitude: STOP.lat + 2 * KM, longitude: STOP.lng }; // ~2 km out (beyond 1207m exit ring)
const KM_6 = { latitude: STOP.lat + 6 * KM, longitude: STOP.lng }; // ~6 km out (inside 8047m outer ring)

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Test',
    lastName: 'Driver',
    email: 'driver@test.com',
    phone: '+15550001111',
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
    unitId: 'T-100',
    vin: 'VIN-TEST-100',
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
    name: 'Test Shipper',
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
    internalId: 'L-1001',
    orderNumber: 'ORD-1001',
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

  const insertStop = (sequenceNumber: number, stopType: 'PICKUP' | 'DELIVERY', lat: number, lng: number) =>
    ctx.db.insert('loadStops', {
      loadId,
      internalId: 'L-1001',
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
  const stop1Id = await insertStop(1, 'PICKUP', STOP.lat, STOP.lng);
  // Stop 2 is ~50 km north — far outside every ring of stop 1.
  const stop2Id = await insertStop(2, 'DELIVERY', STOP.lat + 50 * KM, STOP.lng);

  return { driverId, truckId, sessionId, customerId, loadId, stop1Id, stop2Id };
}

/** Tracking row aimed at STOP for both watches (as after a check-in). */
function trackingRow(f: { loadId: Id<'loadInformation'>; sessionId: Id<'driverSessions'>; driverId: Id<'drivers'> }) {
  return {
    loadId: f.loadId,
    sessionId: f.sessionId,
    driverId: f.driverId,
    organizationId: ORG,
    currentStopSequenceNumber: 2,
    currentStopLat: STOP.lat + 50 * KM,
    currentStopLng: STOP.lng,
    approachingFired: false,
    arrivedFired: false,
    departureStopSequenceNumber: 1,
    departureStopLat: STOP.lat,
    departureStopLng: STOP.lng,
    updatedAt: Date.now(),
  };
}

describe('geofenceEvaluator.evaluatePing — arrival watch', () => {
  it('fires APPROACHING then ARRIVED once each, and never re-fires', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', {
        ...trackingRow(f),
        // Aim the arrival watch at STOP itself for this test.
        currentStopSequenceNumber: 2,
        currentStopLat: STOP.lat,
        currentStopLng: STOP.lng,
        departureStopSequenceNumber: undefined,
        departureStopLat: undefined,
        departureStopLng: undefined,
      });

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_6, recordedAt: 1_000 } });
      let events = await ctx.db.query('geofenceEvents').collect();
      expect(events.map((e) => e.eventType)).toEqual(['APPROACHING']);
      expect(events[0].triggeredAt).toBe(1_000);

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 2_000 } });
      events = await ctx.db.query('geofenceEvents').collect();
      expect(events.map((e) => e.eventType).sort()).toEqual(['APPROACHING', 'ARRIVED']);

      // Another ping at the stop: flags are set, nothing new fires.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 3_000 } });
      events = await ctx.db.query('geofenceEvents').collect();
      expect(events).toHaveLength(2);
    });
  });

  it('dedupes events even when the fired flags were reset', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const stateId = await ctx.db.insert('loadTrackingState', {
        ...trackingRow(f),
        currentStopSequenceNumber: 2,
        currentStopLat: STOP.lat,
        currentStopLng: STOP.lng,
        departureStopSequenceNumber: undefined,
        departureStopLat: undefined,
        departureStopLng: undefined,
      });

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 1_000 } });
      // Simulate a frontier re-init (e.g. repeated check-in) resetting flags.
      await ctx.db.patch(stateId, { approachingFired: false, arrivedFired: false });
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 2_000 } });

      const events = await ctx.db.query('geofenceEvents').collect();
      expect(events.filter((e) => e.eventType === 'ARRIVED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'APPROACHING')).toHaveLength(1);
    });
  });

  it('does nothing when no tracking state exists', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 1_000 } });
      expect(await ctx.db.query('geofenceEvents').collect()).toHaveLength(0);
    });
  });
});

describe('geofenceEvaluator.evaluatePing — departure watch', () => {
  it('confirms departure on the second consecutive outside ping, stamped with the first', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', trackingRow(f));

      // First outside ping: candidate only, no event yet.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 10_000 } });
      let events = await ctx.db.query('geofenceEvents').collect();
      expect(events.filter((e) => e.eventType === 'DEPARTED')).toHaveLength(0);
      let state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureCandidateAt).toBe(10_000);

      // Second outside ping: DEPARTED fires with the candidate timestamp.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 20_000 } });
      events = await ctx.db.query('geofenceEvents').collect();
      const departed = events.filter((e) => e.eventType === 'DEPARTED');
      expect(departed).toHaveLength(1);
      expect(departed[0].triggeredAt).toBe(10_000);
      expect(departed[0].stopSequenceNumber).toBe(1);

      // Watch cleared; further outside pings do nothing.
      state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureStopLat).toBeUndefined();
      expect(state.departureCandidateAt).toBeUndefined();
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 30_000 } });
      expect(
        (await ctx.db.query('geofenceEvents').collect()).filter((e) => e.eventType === 'DEPARTED'),
      ).toHaveLength(1);
    });
  });

  it('resets the candidate when a ping re-enters the ring (GPS jitter)', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', trackingRow(f));

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 10_000 } });
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 20_000 } });

      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureCandidateAt).toBeUndefined();
      expect(
        (await ctx.db.query('geofenceEvents').collect()).filter((e) => e.eventType === 'DEPARTED'),
      ).toHaveLength(0);
    });
  });

  it('ignores low-accuracy pings for departure decisions', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', trackingRow(f));

      await evaluatePing(ctx, {
        loadId: f.loadId,
        ping: { ...KM_2, recordedAt: 10_000, accuracy: 250 },
      });
      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureCandidateAt).toBeUndefined();
    });
  });

  it('deletes a loadCompleted row once the final departure confirms', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', {
        ...trackingRow(f),
        currentStopSequenceNumber: undefined,
        currentStopLat: undefined,
        currentStopLng: undefined,
        loadCompleted: true,
      });

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 10_000 } });
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 20_000 } });

      expect(await ctx.db.query('loadTrackingState').collect()).toHaveLength(0);
      const departed = (await ctx.db.query('geofenceEvents').collect()).filter(
        (e) => e.eventType === 'DEPARTED',
      );
      expect(departed).toHaveLength(1);
    });
  });
});

describe('loadTrackingState frontier helpers', () => {
  it('check-in at stop 1 aims arrival at stop 2 and departure at stop 1', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const stop1 = (await ctx.db.get(f.stop1Id))!;

      await setFrontierOnCheckIn(ctx, {
        stop: stop1,
        sessionId: f.sessionId,
        driverId: f.driverId,
        organizationId: ORG,
        now: Date.now(),
      });

      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.currentStopSequenceNumber).toBe(2);
      expect(state.departureStopSequenceNumber).toBe(1);
      expect(state.approachingFired).toBe(false);
      expect(state.arrivedFired).toBe(false);
      expect(state.sessionId).toBe(f.sessionId);
    });
  });

  it('check-in at the final stop clears the arrival watch and re-stamps the session', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const stop1 = (await ctx.db.get(f.stop1Id))!;
      const stop2 = (await ctx.db.get(f.stop2Id))!;
      await setFrontierOnCheckIn(ctx, {
        stop: stop1,
        sessionId: f.sessionId,
        driverId: f.driverId,
        organizationId: ORG,
        now: Date.now(),
      });

      // Relay driver takes over with a different session (handoff case).
      const relaySessionId = await ctx.db.insert('driverSessions', {
        driverId: f.driverId,
        truckId: f.truckId,
        organizationId: ORG,
        startedAt: Date.now(),
        status: 'active',
      });
      await setFrontierOnCheckIn(ctx, {
        stop: stop2,
        sessionId: relaySessionId,
        driverId: f.driverId,
        organizationId: ORG,
        now: Date.now(),
      });

      const states = await ctx.db.query('loadTrackingState').collect();
      expect(states).toHaveLength(1); // patched, not duplicated
      expect(states[0].currentStopSequenceNumber).toBeUndefined();
      expect(states[0].departureStopSequenceNumber).toBe(2);
      expect(states[0].sessionId).toBe(relaySessionId);
    });
  });

  it('release on load complete keeps the row while a departure watch is pending, else deletes', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);

      // Pending departure watch → row survives with loadCompleted.
      const withWatch = await ctx.db.insert('loadTrackingState', trackingRow(f));
      await releaseFrontierOnLoadComplete(ctx, f.loadId, Date.now());
      const kept = await ctx.db.get(withWatch);
      expect(kept?.loadCompleted).toBe(true);
      expect(kept?.currentStopSequenceNumber).toBeUndefined();

      // No departure watch → row deleted.
      await ctx.db.delete(withWatch);
      await ctx.db.insert('loadTrackingState', {
        ...trackingRow(f),
        departureStopSequenceNumber: undefined,
        departureStopLat: undefined,
        departureStopLng: undefined,
      });
      await releaseFrontierOnLoadComplete(ctx, f.loadId, Date.now());
      expect(await ctx.db.query('loadTrackingState').collect()).toHaveLength(0);
    });
  });

  it('session-end cleanup deletes only loadCompleted rows of that session', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', { ...trackingRow(f), loadCompleted: true });

      // A second, mid-flight load for the same session must survive.
      const otherLoadId = await ctx.db.insert('loadInformation', {
        internalId: 'L-1002',
        orderNumber: 'ORD-1002',
        status: 'Assigned',
        trackingStatus: 'In Transit',
        customerId: f.customerId,
        fleet: 'Test Fleet',
        units: 'Pallets',
        workosOrgId: ORG,
        createdBy: 'user_test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert('loadTrackingState', { ...trackingRow(f), loadId: otherLoadId });

      await deleteCompletedRowsForSession(ctx, f.sessionId);

      const remaining = await ctx.db.query('loadTrackingState').collect();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].loadId).toBe(otherLoadId);
    });
  });
});

describe('driverSessions.buildSessionStopTimeline', () => {
  async function insertEvent(
    ctx: MutationCtx,
    f: { loadId: Id<'loadInformation'>; sessionId: Id<'driverSessions'>; driverId: Id<'drivers'> },
    eventType: 'APPROACHING' | 'ARRIVED' | 'DEPARTED',
    stopSequenceNumber: number,
    triggeredAt: number,
  ) {
    await ctx.db.insert('geofenceEvents', {
      sessionId: f.sessionId,
      loadId: f.loadId,
      stopSequenceNumber,
      driverId: f.driverId,
      organizationId: ORG,
      eventType,
      triggeredAt,
      latitude: STOP.lat,
      longitude: STOP.lng,
      distanceMeters: 0,
    });
  }

  it('composes geofence events with manual taps and computes dwell from geofence bounds', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      const base = session.startedAt;

      await insertEvent(ctx, f, 'APPROACHING', 1, base + 5 * 60_000);
      await insertEvent(ctx, f, 'ARRIVED', 1, base + 10 * 60_000);
      await insertEvent(ctx, f, 'DEPARTED', 1, base + 160 * 60_000);
      await ctx.db.patch(f.stop1Id, {
        checkedInAt: new Date(base + 20 * 60_000).toISOString(),
        checkedOutAt: new Date(base + 150 * 60_000).toISOString(),
      });

      const rows = await buildSessionStopTimeline(ctx, session);
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.sequenceNumber).toBe(1);
      expect(row.stopType).toBe('PICKUP');
      expect(row.loadInternalId).toBe('L-1001');
      expect(row.arrivedAt).toBe(base + 10 * 60_000);
      expect(row.departedAt).toBe(base + 160 * 60_000);
      expect(row.checkedInAt).toBe(base + 20 * 60_000);
      expect(row.checkedOutAt).toBe(base + 150 * 60_000);
      // Geofence bounds win: 160 − 10 = 150 minutes.
      expect(row.dwellMinutes).toBe(150);
    });
  });

  it('falls back to manual taps for dwell when geofence timestamps are missing', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      const base = session.startedAt;

      // Manual taps only (no GPS coverage), attributed via the session leg.
      await ctx.db.insert('dispatchLegs', {
        loadId: f.loadId,
        driverId: f.driverId,
        sessionId: f.sessionId,
        sequence: 1,
        startStopId: f.stop1Id,
        endStopId: f.stop2Id,
        legLoadedMiles: 0,
        legEmptyMiles: 0,
        status: 'ACTIVE',
        workosOrgId: ORG,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.patch(f.stop1Id, {
        checkedInAt: new Date(base + 30 * 60_000).toISOString(),
        checkedOutAt: new Date(base + 75 * 60_000).toISOString(),
      });

      const rows = await buildSessionStopTimeline(ctx, session);
      expect(rows).toHaveLength(1);
      expect(rows[0].arrivedAt).toBeNull();
      expect(rows[0].departedAt).toBeNull();
      expect(rows[0].dwellMinutes).toBe(45);
    });
  });

  it('excludes stops whose taps fall outside the session window', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;

      await ctx.db.insert('dispatchLegs', {
        loadId: f.loadId,
        driverId: f.driverId,
        sessionId: f.sessionId,
        sequence: 1,
        startStopId: f.stop1Id,
        endStopId: f.stop2Id,
        legLoadedMiles: 0,
        legEmptyMiles: 0,
        status: 'ACTIVE',
        workosOrgId: ORG,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // Tap from a previous shift, hours before this session started.
      await ctx.db.patch(f.stop1Id, {
        checkedInAt: new Date(session.startedAt - 5 * 60 * 60_000).toISOString(),
      });

      const rows = await buildSessionStopTimeline(ctx, session);
      expect(rows).toHaveLength(0);
    });
  });
});
