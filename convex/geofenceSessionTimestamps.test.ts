/**
 * Tests for the geofence session-timestamp feature (Phase 3):
 *   - geofenceEvaluator.evaluatePing — arrival one-shots, departure
 *     candidate/confirm debounce, offline-backlog guards, accuracy gate,
 *     event dedup, session attribution, loadCompleted row cleanup.
 *   - loadTrackingState helpers — setFrontierOnCheckIn watch placement,
 *     releaseFrontierOnLoadComplete keep-vs-delete + session re-bind,
 *     handoff transfer, session-end cleanup, same-driver rollover.
 *   - driverSessions.buildSessionStopTimeline — event/manual composition,
 *     session-window attribution, and dwell math.
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
  transferFrontierToDriver,
  deleteCompletedRowsForSession,
  transferCompletedRowsToSession,
} from './loadTrackingState';
import { buildSessionStopTimeline } from './driverSessions';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_geofence';

// Stop at a fixed point; offsets in degrees latitude (1° ≈ 111.32 km).
const STOP = { lat: 40, lng: -75 };
const KM = 1 / 111.32; // ~1 km in degrees latitude
const AT_STOP = { latitude: STOP.lat, longitude: STOP.lng };
const KM_2 = { latitude: STOP.lat + 2 * KM, longitude: STOP.lng }; // ~2 km out (beyond 1207m exit ring)
const KM_6 = { latitude: STOP.lat + 6 * KM, longitude: STOP.lng }; // ~6 km out (inside 8047m outer ring)

// Watch armed at t=1000; test pings use later recordedAt values.
const ARMED_AT = 1_000;

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

/** Tracking row watching STOP for departure (as after a check-in there). */
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
    departureWatch: {
      stopSequenceNumber: 1,
      lat: STOP.lat,
      lng: STOP.lng,
      armedAt: ARMED_AT,
    },
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
        departureWatch: undefined,
      });

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_6, recordedAt: 10_000 } });
      let events = await ctx.db.query('geofenceEvents').collect();
      expect(events.map((e) => e.eventType)).toEqual(['APPROACHING']);
      expect(events[0].triggeredAt).toBe(10_000);

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 20_000 } });
      events = await ctx.db.query('geofenceEvents').collect();
      expect(events.map((e) => e.eventType).sort()).toEqual(['APPROACHING', 'ARRIVED']);

      // Another ping at the stop: flags are set, nothing new fires.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 30_000 } });
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
        departureWatch: undefined,
      });

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 10_000 } });
      // Simulate a frontier re-init (e.g. repeated check-in) resetting flags.
      await ctx.db.patch(stateId, { approachingFired: false, arrivedFired: false });
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 20_000 } });

      const events = await ctx.db.query('geofenceEvents').collect();
      expect(events.filter((e) => e.eventType === 'ARRIVED')).toHaveLength(1);
      expect(events.filter((e) => e.eventType === 'APPROACHING')).toHaveLength(1);
    });
  });

  it('attributes events to the triggering ping session, not the row session', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      // Row still points at yesterday's session; ping comes from a new one.
      const newSessionId = await ctx.db.insert('driverSessions', {
        driverId: f.driverId,
        truckId: f.truckId,
        organizationId: ORG,
        startedAt: Date.now(),
        status: 'active',
      });
      await ctx.db.insert('loadTrackingState', {
        ...trackingRow(f),
        currentStopSequenceNumber: 2,
        currentStopLat: STOP.lat,
        currentStopLng: STOP.lng,
        departureWatch: undefined,
      });

      await evaluatePing(ctx, {
        loadId: f.loadId,
        sessionId: newSessionId,
        ping: { ...AT_STOP, recordedAt: 10_000 },
      });

      const events = await ctx.db.query('geofenceEvents').collect();
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(event.sessionId).toBe(newSessionId);
    });
  });

  it('does nothing when no tracking state exists', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 10_000 } });
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
      expect(state.departureWatch?.candidateAt).toBe(10_000);

      // Second outside ping: DEPARTED fires with the candidate timestamp.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 20_000 } });
      events = await ctx.db.query('geofenceEvents').collect();
      const departed = events.filter((e) => e.eventType === 'DEPARTED');
      expect(departed).toHaveLength(1);
      expect(departed[0].triggeredAt).toBe(10_000);
      expect(departed[0].stopSequenceNumber).toBe(1);

      // Watch cleared; further outside pings do nothing.
      state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureWatch).toBeUndefined();
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 30_000 } });
      expect(
        (await ctx.db.query('geofenceEvents').collect()).filter((e) => e.eventType === 'DEPARTED'),
      ).toHaveLength(1);
    });
  });

  it('resets the candidate when a newer ping re-enters the ring (GPS jitter)', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', trackingRow(f));

      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 10_000 } });
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 20_000 } });

      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureWatch?.candidateAt).toBeUndefined();
      expect(
        (await ctx.db.query('geofenceEvents').collect()).filter((e) => e.eventType === 'DEPARTED'),
      ).toHaveLength(0);
    });
  });

  it('ignores pings recorded before the watch was armed (offline backlog)', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', trackingRow(f));

      // Two historical en-route pings, both outside the ring but recorded
      // BEFORE the check-in that armed the watch — must not fire DEPARTED.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: ARMED_AT - 500 } });
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: ARMED_AT - 100 } });

      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureWatch?.candidateAt).toBeUndefined();
      expect(
        (await ctx.db.query('geofenceEvents').collect()).filter((e) => e.eventType === 'DEPARTED'),
      ).toHaveLength(0);
    });
  });

  it('does not let a stale inside ping reset a newer candidate', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', trackingRow(f));

      // Live ping outside sets the candidate at t=20000.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...KM_2, recordedAt: 20_000 } });
      // Delayed batch delivers an older inside ping (t=15000) — no reset.
      await evaluatePing(ctx, { loadId: f.loadId, ping: { ...AT_STOP, recordedAt: 15_000 } });

      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.departureWatch?.candidateAt).toBe(20_000);
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
      expect(state.departureWatch?.candidateAt).toBeUndefined();
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
      const now = Date.now();

      await setFrontierOnCheckIn(ctx, {
        stop: stop1,
        sessionId: f.sessionId,
        driverId: f.driverId,
        organizationId: ORG,
        now,
      });

      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.currentStopSequenceNumber).toBe(2);
      expect(state.departureWatch?.stopSequenceNumber).toBe(1);
      expect(state.departureWatch?.armedAt).toBe(now);
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
      expect(states[0].departureWatch?.stopSequenceNumber).toBe(2);
      expect(states[0].sessionId).toBe(relaySessionId);
    });
  });

  it('re-check-in clears loadCompleted so the revived row is not deleted mid-load', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('loadTrackingState', { ...trackingRow(f), loadCompleted: true });
      const stop1 = (await ctx.db.get(f.stop1Id))!;

      await setFrontierOnCheckIn(ctx, {
        stop: stop1,
        sessionId: f.sessionId,
        driverId: f.driverId,
        organizationId: ORG,
        now: Date.now(),
      });

      const state = (await ctx.db.query('loadTrackingState').collect())[0];
      expect(state.loadCompleted).toBeUndefined();
    });
  });

  it('release on load complete keeps the row while a departure watch is pending, else deletes', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);

      // Pending departure watch → row survives with loadCompleted, and is
      // re-bound to the current session when one is passed.
      const laterSessionId = await ctx.db.insert('driverSessions', {
        driverId: f.driverId,
        truckId: f.truckId,
        organizationId: ORG,
        startedAt: Date.now(),
        status: 'active',
      });
      const withWatch = await ctx.db.insert('loadTrackingState', trackingRow(f));
      await releaseFrontierOnLoadComplete(ctx, f.loadId, Date.now(), laterSessionId);
      const kept = await ctx.db.get(withWatch);
      expect(kept?.loadCompleted).toBe(true);
      expect(kept?.sessionId).toBe(laterSessionId);
      expect(kept?.currentStopSequenceNumber).toBeUndefined();

      // No departure watch → row deleted.
      await ctx.db.delete(withWatch);
      await ctx.db.insert('loadTrackingState', { ...trackingRow(f), departureWatch: undefined });
      await releaseFrontierOnLoadComplete(ctx, f.loadId, Date.now());
      expect(await ctx.db.query('loadTrackingState').collect()).toHaveLength(0);
    });
  });

  it('handoff transfer re-binds driver + session and clears the departure watch', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const stateId = await ctx.db.insert('loadTrackingState', trackingRow(f));

      const relayDriverId = await ctx.db.insert('drivers', {
        firstName: 'Relay',
        lastName: 'Driver',
        email: 'relay@test.com',
        phone: '+15550002222',
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
      const relaySessionId = await ctx.db.insert('driverSessions', {
        driverId: relayDriverId,
        truckId: f.truckId,
        organizationId: ORG,
        startedAt: Date.now(),
        status: 'active',
      });

      const state = await ctx.db.get(stateId);
      await transferFrontierToDriver(ctx, state, relayDriverId, Date.now());

      const after = (await ctx.db.get(stateId))!;
      expect(after.driverId).toBe(relayDriverId);
      expect(after.sessionId).toBe(relaySessionId);
      expect(after.departureWatch).toBeUndefined();
      // Arrival watch preserved — the relay resumes toward the same stop.
      expect(after.currentStopSequenceNumber).toBe(2);
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

  it('same-driver rollover moves loadCompleted rows to the new session', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const rowId = await ctx.db.insert('loadTrackingState', {
        ...trackingRow(f),
        loadCompleted: true,
      });
      const newSessionId = await ctx.db.insert('driverSessions', {
        driverId: f.driverId,
        truckId: f.truckId,
        organizationId: ORG,
        startedAt: Date.now(),
        status: 'active',
      });

      await transferCompletedRowsToSession(ctx, f.sessionId, newSessionId, Date.now());

      const row = (await ctx.db.get(rowId))!;
      expect(row.sessionId).toBe(newSessionId);
      expect(row.loadCompleted).toBe(true);
      expect(row.departureWatch?.stopSequenceNumber).toBe(1); // watch survives
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

  function insertLeg(
    ctx: MutationCtx,
    f: {
      loadId: Id<'loadInformation'>;
      sessionId: Id<'driverSessions'>;
      driverId: Id<'drivers'>;
      stop1Id: Id<'loadStops'>;
      stop2Id: Id<'loadStops'>;
    },
  ) {
    return ctx.db.insert('dispatchLegs', {
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
      await insertLeg(ctx, f);
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

      await insertLeg(ctx, f);
      // Tap from a previous shift, hours before this session started.
      await ctx.db.patch(f.stop1Id, {
        checkedInAt: new Date(session.startedAt - 5 * 60 * 60_000).toISOString(),
      });

      const rows = await buildSessionStopTimeline(ctx, session);
      expect(rows).toHaveLength(0);
    });
  });

  it('does not attribute another session\'s taps to this session\'s row or dwell', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      const session = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;
      const base = session.startedAt;

      // This session has geofence events for stop 1 and then ENDS...
      await insertEvent(ctx, f, 'ARRIVED', 1, base + 10 * 60_000);
      await ctx.db.patch(f.sessionId, {
        status: 'completed',
        endedAt: base + 60 * 60_000,
      });
      const ended = (await ctx.db.get(f.sessionId)) as Doc<'driverSessions'>;

      // ...while the check-out tap happens hours later, in another shift.
      await ctx.db.patch(f.stop1Id, {
        checkedOutAt: new Date(base + 10 * 60 * 60_000).toISOString(),
      });

      const rows = await buildSessionStopTimeline(ctx, ended);
      expect(rows).toHaveLength(1);
      // Row exists (this session's ARRIVED), but the foreign tap is not
      // displayed and cannot inflate dwell.
      expect(rows[0].arrivedAt).toBe(base + 10 * 60_000);
      expect(rows[0].checkedOutAt).toBeNull();
      expect(rows[0].dwellMinutes).toBeNull();
    });
  });
});
