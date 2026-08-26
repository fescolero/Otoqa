/**
 * Tests for the session-level yard geofence (convex/yardGeofence.ts):
 * stateless arrive/depart alternation per (session, yard), hysteresis
 * band, accuracy gate, backlog guard, radius override, and the
 * start-yard anchor stamped onto the session.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { evaluateYards } from './yardGeofence';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const ORG = 'org_test_yard';
const YARD = { lat: 34, lng: -117 };
const KM = 1 / 111.32; // ~1 km in degrees latitude

async function insertFixtures(ctx: MutationCtx, opts?: { startedAt?: number }) {
  const now = Date.now();
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Yard',
    lastName: 'Tester',
    email: 'yard@test.com',
    phone: '+15550002222',
    licenseState: 'CA',
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
    startedAt: opts?.startedAt ?? now - 60 * 60_000,
    status: 'active',
  });
  const yardId = await ctx.db.insert('yardLocations', {
    workosOrgId: ORG,
    name: 'Main Yard',
    locationType: 'YARD',
    latitude: YARD.lat,
    longitude: YARD.lng,
    // default radius (250 m entry / 375 m exit)
    isDeleted: false,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });
  return { driverId, sessionId, yardId };
}

function ping(kmFromYard: number, recordedAt: number, accuracy?: number) {
  return {
    latitude: YARD.lat + kmFromYard * KM,
    longitude: YARD.lng,
    recordedAt,
    accuracy,
  };
}

async function evalPing(
  ctx: MutationCtx,
  f: { sessionId: Id<'driverSessions'>; driverId: Id<'drivers'> },
  p: ReturnType<typeof ping>,
) {
  await evaluateYards(ctx, {
    sessionId: f.sessionId,
    driverId: f.driverId,
    organizationId: ORG,
    ping: p,
  });
}

async function eventTypes(ctx: MutationCtx) {
  return (await ctx.db.query('sessionGeofenceEvents').collect())
    .sort((a, b) => a.triggeredAt - b.triggeredAt)
    .map((e) => e.eventType);
}

describe('yardGeofence.evaluateYards', () => {
  it('alternates ARRIVED and DEPARTED across a shift, once per crossing', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await evalPing(ctx, f, ping(0.1, 1_000)); // 100 m — inside 250 m → ARRIVED
      await evalPing(ctx, f, ping(0.05, 2_000)); // still inside — no dup
      await evalPing(ctx, f, ping(0.5, 3_000)); // 500 m — outside 375 m → DEPARTED
      await evalPing(ctx, f, ping(5, 4_000)); // far away — no dup
      await evalPing(ctx, f, ping(0.1, 5_000)); // back inside → second ARRIVED
      expect(await eventTypes(ctx)).toEqual(['ARRIVED', 'DEPARTED', 'ARRIVED']);
    });
  });

  it('never opens with DEPARTED — a shift starting outside the yard stays silent', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await evalPing(ctx, f, ping(10, 1_000));
      await evalPing(ctx, f, ping(20, 2_000));
      expect(await eventTypes(ctx)).toEqual([]);
    });
  });

  it('the hysteresis band (between entry and exit ring) changes nothing', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await evalPing(ctx, f, ping(0.1, 1_000)); // ARRIVED
      await evalPing(ctx, f, ping(0.3, 2_000)); // 300 m — between 250 and 375 → no-op
      expect(await eventTypes(ctx)).toEqual(['ARRIVED']);
      await evalPing(ctx, f, ping(0.4, 3_000)); // past 375 → DEPARTED
      expect(await eventTypes(ctx)).toEqual(['ARRIVED', 'DEPARTED']);
    });
  });

  it('ignores low-accuracy pings and stale backlog pings', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await evalPing(ctx, f, ping(0.1, 1_000, 250)); // accuracy 250 m — ignored
      expect(await eventTypes(ctx)).toEqual([]);
      await evalPing(ctx, f, ping(0.1, 5_000, 5)); // ARRIVED at t=5000
      await evalPing(ctx, f, ping(0.5, 4_000, 5)); // OLDER outside ping — ignored
      expect(await eventTypes(ctx)).toEqual(['ARRIVED']);
    });
  });

  it('honors a per-yard radius override', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.patch(f.yardId, { radiusMeters: 1000 }); // 1 km entry / 1.5 km exit
      await evalPing(ctx, f, ping(0.8, 1_000)); // 800 m — inside 1 km → ARRIVED
      await evalPing(ctx, f, ping(1.2, 2_000)); // between 1 and 1.5 km → no-op
      await evalPing(ctx, f, ping(1.8, 3_000)); // outside 1.5 km → DEPARTED
      expect(await eventTypes(ctx)).toEqual(['ARRIVED', 'DEPARTED']);
    });
  });

  it('scopes to the org — another org\'s yard never fires', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const f = await insertFixtures(ctx);
      await ctx.db.insert('yardLocations', {
        workosOrgId: 'org_other',
        name: 'Other Org Yard',
        locationType: 'YARD',
        latitude: YARD.lat,
        longitude: YARD.lng,
        isDeleted: false,
        createdBy: 'user_test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await evalPing(ctx, f, ping(0.1, 1_000));
      const events = await ctx.db.query('sessionGeofenceEvents').collect();
      expect(events).toHaveLength(1); // only the own-org yard fired
      expect(events[0].yardId).toBe(f.yardId);
    });
  });
});

describe('yardGeofence — start-yard anchor', () => {
  it('stamps the fence a shift opened inside', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const startedAt = Date.now();
      const f = await insertFixtures(ctx, { startedAt });
      // First fix, 40 s after Start Shift, parked in the yard.
      await evalPing(ctx, f, ping(0.1, startedAt + 40_000));
      const session = await ctx.db.get(f.sessionId);
      expect(session?.startYardId).toBe(f.yardId);
    });
  });

  it('leaves it unset when the shift opens outside every fence', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const startedAt = Date.now();
      const f = await insertFixtures(ctx, { startedAt });
      await evalPing(ctx, f, ping(10, startedAt + 40_000));
      const session = await ctx.db.get(f.sessionId);
      expect(session?.startYardId).toBeUndefined();
    });
  });

  it('a yard entered later in the shift cannot claim the slot', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const startedAt = Date.now();
      const f = await insertFixtures(ctx, { startedAt });
      await evalPing(ctx, f, ping(10, startedAt + 40_000)); // opened on the road
      await evalPing(ctx, f, ping(0.1, startedAt + 3 * 60 * 60_000)); // yard at hour 3
      expect(await eventTypes(ctx)).toEqual(['ARRIVED']); // the event still fires
      const session = await ctx.db.get(f.sessionId);
      expect(session?.startYardId).toBeUndefined(); // but the anchor stays empty
    });
  });

  it('stamps once — coming back to the start yard never re-stamps', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const startedAt = Date.now();
      const f = await insertFixtures(ctx, { startedAt });
      const other = await ctx.db.insert('yardLocations', {
        workosOrgId: ORG,
        name: 'Second Yard',
        locationType: 'PARKING',
        latitude: YARD.lat + 50 * KM, // 50 km away — its own fence entirely
        longitude: YARD.lng,
        isDeleted: false,
        createdBy: 'user_test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await evalPing(ctx, f, ping(0.1, startedAt + 40_000)); // opens in Main Yard
      await evalPing(ctx, f, ping(5, startedAt + 30 * 60_000)); // leaves
      await evalPing(ctx, f, ping(50, startedAt + 90 * 60_000)); // arrives at Second Yard
      await evalPing(ctx, f, ping(0.1, startedAt + 8 * 60 * 60_000)); // home again
      const session = await ctx.db.get(f.sessionId);
      expect(session?.startYardId).toBe(f.yardId);
      expect(other).not.toBe(f.yardId);
    });
  });

  it('a ping recorded before the shift started is not an anchor', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const startedAt = Date.now();
      const f = await insertFixtures(ctx, { startedAt });
      // Backlog fix from the previous shift, synced late under this session.
      await evalPing(ctx, f, ping(0.1, startedAt - 20 * 60_000));
      const session = await ctx.db.get(f.sessionId);
      expect(session?.startYardId).toBeUndefined();
    });
  });
});
