import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';

/**
 * Tests for the driverLatestLocation denormalized cache maintained by
 * ingestBatch. Covers the upsert invariants:
 *   1. First ping inserts a row.
 *   2. Newer ping patches the row.
 *   3. Stale ping does NOT overwrite (recordedAt-guard).
 *   4. Latest stored regardless of loadId presence (consumers filter).
 */

const ORG = 'org_dll_test';
const USER_SUBJECT = 'user_dll_test';

interface World {
  driverId: Id<'drivers'>;
  truckId: Id<'trucks'>;
  loadId: Id<'loadInformation'>;
  loadStopId: Id<'loadStops'>;
  sessionId: Id<'driverSessions'>;
}

async function seed(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<World> {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'Test Customer',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 Test St',
    city: 'Testville',
    state: 'CA',
    zip: '00000',
    country: 'USA',
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Test',
    lastName: 'Driver',
    email: 'd@t.com',
    phone: '+15555550000',
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2020-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  const truckId = await ctx.db.insert('trucks', {
    unitId: 'TRUCK-DLL',
    vin: '1HGCM82633A111111',
    status: 'Active',
    organizationId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'LD-DLL-1',
    orderNumber: 'LD-DLL-1',
    status: 'Assigned',
    trackingStatus: 'In Transit',
    customerId,
    fleet: 'Default',
    units: 'Pallets',
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  const loadStopId = await ctx.db.insert('loadStops', {
    loadId,
    internalId: 'LD-DLL-1',
    sequenceNumber: 1,
    stopType: 'PICKUP',
    loadingType: 'APPT',
    address: '1 Pickup St',
    city: 'Pickupville',
    state: 'CA',
    windowBeginDate: '2026-05-19',
    windowBeginTime: '09:00:00-07:00',
    windowEndDate: '2026-05-19',
    windowEndTime: '11:00:00-07:00',
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
  const sessionId = await ctx.db.insert('driverSessions', {
    driverId,
    truckId,
    organizationId: ORG,
    startedAt: now - 60 * 60 * 1000,
    status: 'active',
  });
  await ctx.db.insert('dispatchLegs', {
    loadId,
    driverId,
    truckId,
    sequence: 1,
    startStopId: loadStopId,
    endStopId: loadStopId,
    legLoadedMiles: 100,
    legEmptyMiles: 0,
    status: 'ACTIVE',
    sessionId,
    workosOrgId: ORG,
    createdAt: now,
    updatedAt: now,
  });
  return { driverId, truckId, loadId, loadStopId, sessionId };
}

async function ingest(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any,
  world: World,
  recordedAt: number,
  withLoadId: boolean,
): Promise<void> {
  await t.mutation(internal.driverLocations.internalBatchInsertLocations, {
    locations: [
      {
        driverId: world.driverId,
        loadId: withLoadId ? world.loadId : undefined,
        sessionId: world.sessionId,
        latitude: 40.5,
        longitude: -122.3,
        recordedAt,
        trackingType: withLoadId ? 'LOAD_ROUTE' : 'SESSION_ROUTE',
        source: 'MOBILE' as const,
      },
    ],
    organizationId: ORG,
  });
}

describe('driverLatestLocation upsert via ingestBatch', () => {
  it('first ping inserts a row', async () => {
    const t = convexTest(schema);
    const world = await t.run(async (ctx) => seed(ctx));

    const t0 = Date.now() - 60_000;
    await ingest(t, world, t0, true);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query('driverLatestLocation')
        .withIndex('by_driver', (q: any) => q.eq('driverId', world.driverId))
        .first(),
    );
    expect(row).not.toBeNull();
    expect(row!.recordedAt).toBe(t0);
    expect(row!.loadId).toBe(world.loadId);
  });

  it('newer ping patches the row', async () => {
    const t = convexTest(schema);
    const world = await t.run(async (ctx) => seed(ctx));

    const t0 = Date.now() - 60_000;
    const t1 = t0 + 10_000;
    await ingest(t, world, t0, true);
    await ingest(t, world, t1, true);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('driverLatestLocation')
        .withIndex('by_driver', (q: any) => q.eq('driverId', world.driverId))
        .collect(),
    );
    expect(rows).toHaveLength(1); // upsert, not insert-each
    expect(rows[0].recordedAt).toBe(t1);
  });

  it('stale ping does NOT overwrite a fresher stored ping', async () => {
    const t = convexTest(schema);
    const world = await t.run(async (ctx) => seed(ctx));

    const t0 = Date.now() - 60_000;
    const tStale = t0 - 30_000; // 30s older than stored
    await ingest(t, world, t0, true);
    await ingest(t, world, tStale, true);

    const row = await t.run(async (ctx) =>
      ctx.db
        .query('driverLatestLocation')
        .withIndex('by_driver', (q: any) => q.eq('driverId', world.driverId))
        .first(),
    );
    expect(row!.recordedAt).toBe(t0); // still the fresher value
  });

  it('session-only ping (no loadId) is captured; getActiveDriverLocations filters it', async () => {
    const t = convexTest(schema);
    const world = await t.run(async (ctx) => seed(ctx));

    const t0 = Date.now() - 60_000;
    await ingest(t, world, t0, false); // sessionId only, no loadId

    const row = await t.run(async (ctx) =>
      ctx.db
        .query('driverLatestLocation')
        .withIndex('by_driver', (q: any) => q.eq('driverId', world.driverId))
        .first(),
    );
    expect(row).not.toBeNull();
    expect(row!.loadId).toBeUndefined();

    // getActiveDriverLocations filters loadId=null entries
    const asUser = t.withIdentity({ subject: USER_SUBJECT, org_id: ORG });
    const result = await asUser.query(api.driverLocations.getActiveDriverLocations, {
      organizationId: ORG,
      nowMs: Date.now(),
    });
    expect(result).toEqual([]);
  });
});
