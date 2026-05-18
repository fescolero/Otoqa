import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';

/**
 * Integration tests for processVehicleStats — the V8-runtime mutation that
 * turns a Samsara Vehicle Stats GPS feed batch into driverLocations rows.
 *
 * Coverage:
 *   1. Happy path: vehicle mapped + active session + ACTIVE leg
 *      → pings land as LOAD_ROUTE with loadId, source='SAMSARA',
 *      speed converted from MPH to m/s, recordedAt from RFC 3339.
 *   2. No mapped truck → vehiclesSkipped++, no rows.
 *   3. Open session but no ACTIVE leg → SESSION_ROUTE pings, no loadId.
 */

const ORG = 'org_samsara_test';
const USER_SUBJECT = 'user_samsara_test';

interface SeededWorld {
  customerId: Id<'customers'>;
  driverId: Id<'drivers'>;
  truckId: Id<'trucks'>;
  loadId: Id<'loadInformation'>;
  loadStopId: Id<'loadStops'>;
  sessionId: Id<'driverSessions'>;
  legId: Id<'dispatchLegs'>;
}

async function seedWorld(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  opts: { samsaraVehicleId?: string; legStatus?: 'ACTIVE' | 'PENDING' } = {},
): Promise<SeededWorld> {
  const now = Date.now();

  const customerId = await ctx.db.insert('customers', {
    name: 'Samsara Test Customer',
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
    firstName: 'Bob',
    lastName: 'Driver',
    email: 'bob@test.com',
    phone: '+15555550100',
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
    unitId: 'TRUCK-1',
    vin: '1HGCM82633A123456',
    status: 'Active',
    organizationId: ORG,
    createdBy: USER_SUBJECT,
    samsaraVehicleId: opts.samsaraVehicleId,
    createdAt: now,
    updatedAt: now,
  });

  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'LD-SAM-1',
    orderNumber: 'LD-SAM-1',
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
    internalId: 'LD-SAM-1',
    sequenceNumber: 1,
    stopType: 'PICKUP',
    loadingType: 'APPT',
    address: '1 Pickup St',
    city: 'Pickupville',
    state: 'CA',
    windowBeginDate: '2026-05-17',
    windowBeginTime: '09:00:00-07:00',
    windowEndDate: '2026-05-17',
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
    startedAt: now - 60 * 60 * 1000, // started 1h ago
    status: 'active',
  });

  const legId = await ctx.db.insert('dispatchLegs', {
    loadId,
    driverId,
    truckId,
    sequence: 1,
    startStopId: loadStopId,
    endStopId: loadStopId,
    legLoadedMiles: 100,
    legEmptyMiles: 0,
    status: opts.legStatus ?? 'ACTIVE',
    sessionId,
    workosOrgId: ORG,
    createdAt: now,
    updatedAt: now,
  });

  return { customerId, driverId, truckId, loadId, loadStopId, sessionId, legId };
}

// ───────────────────────────────────────────────────────────────────────

describe('processVehicleStats', () => {
  it('ingests LOAD_ROUTE pings for a mapped truck with an ACTIVE leg', async () => {
    const t = convexTest(schema);
    const world = await t.run((ctx) =>
      seedWorld(ctx, { samsaraVehicleId: 'samsara-vehicle-1' }),
    );

    const result = await t.mutation(
      internal.samsaraIngestMutations.processVehicleStats,
      {
        workosOrgId: ORG,
        vehicleEntries: [
          {
            id: 'samsara-vehicle-1',
            name: 'Truck-1',
            gps: [
              {
                latitude: 41.823541,
                longitude: -87.658994,
                headingDegrees: 92.4,
                speedMilesPerHour: 60,
                time: '2026-05-17T16:00:00.000Z',
              },
              {
                latitude: 41.825,
                longitude: -87.650,
                headingDegrees: 88,
                speedMilesPerHour: 65,
                time: '2026-05-17T16:00:30.000Z',
              },
            ],
          },
        ],
      },
    );

    expect(result.pingsIngested).toBe(2);
    expect(result.vehiclesSkipped).toBe(0);
    expect(result.orphanPingsDropped).toBe(0);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('driverLocations')
        .withIndex('by_session_time', (q: any) =>
          q.eq('sessionId', world.sessionId),
        )
        .order('asc')
        .collect(),
    );

    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.source).toBe('SAMSARA');
      expect(r.trackingType).toBe('LOAD_ROUTE');
      expect(r.loadId).toBe(world.loadId);
      expect(r.driverId).toBe(world.driverId);
      expect(r.organizationId).toBe(ORG);
    }

    // MPH → m/s conversion: 60 mph × 0.44704 = 26.8224 m/s
    expect(rows[0].speed).toBeCloseTo(60 * 0.44704, 4);
    expect(rows[1].speed).toBeCloseTo(65 * 0.44704, 4);

    // recordedAt parsed from RFC 3339
    expect(rows[0].recordedAt).toBe(Date.parse('2026-05-17T16:00:00.000Z'));
    expect(rows[1].recordedAt).toBe(Date.parse('2026-05-17T16:00:30.000Z'));
  });

  it('skips vehicles not mapped to any Otoqa truck', async () => {
    const t = convexTest(schema);
    await t.run((ctx) =>
      // truck has no samsaraVehicleId — unmapped
      seedWorld(ctx, { samsaraVehicleId: undefined }),
    );

    const result = await t.mutation(
      internal.samsaraIngestMutations.processVehicleStats,
      {
        workosOrgId: ORG,
        vehicleEntries: [
          {
            id: 'orphan-samsara-id',
            name: 'Unmapped',
            gps: [
              {
                latitude: 1,
                longitude: 2,
                speedMilesPerHour: 50,
                time: '2026-05-17T16:00:00.000Z',
              },
            ],
          },
        ],
      },
    );

    expect(result.pingsIngested).toBe(0);
    expect(result.vehiclesSkipped).toBe(1);
    expect(result.orphanPingsDropped).toBe(0);

    const allRows = await t.run((ctx) =>
      ctx.db.query('driverLocations').collect(),
    );
    expect(allRows).toHaveLength(0);
  });

  it('ingests SESSION_ROUTE (no loadId) when no leg is ACTIVE', async () => {
    const t = convexTest(schema);
    const world = await t.run((ctx) =>
      seedWorld(ctx, {
        samsaraVehicleId: 'samsara-vehicle-1',
        legStatus: 'PENDING',
      }),
    );

    const result = await t.mutation(
      internal.samsaraIngestMutations.processVehicleStats,
      {
        workosOrgId: ORG,
        vehicleEntries: [
          {
            id: 'samsara-vehicle-1',
            name: 'Truck-1',
            gps: [
              {
                latitude: 41.0,
                longitude: -87.0,
                speedMilesPerHour: 30,
                time: '2026-05-17T16:00:00.000Z',
              },
            ],
          },
        ],
      },
    );

    expect(result.pingsIngested).toBe(1);
    const rows = await t.run((ctx) =>
      ctx.db
        .query('driverLocations')
        .withIndex('by_session_time', (q: any) =>
          q.eq('sessionId', world.sessionId),
        )
        .collect(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('SAMSARA');
    expect(rows[0].trackingType).toBe('SESSION_ROUTE');
    expect(rows[0].loadId).toBeUndefined();
  });
});
