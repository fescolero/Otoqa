/**
 * listDrivers enrichment for the v8 Drivers list (design
 * `lib-dispatch/drivers.jsx`).
 *
 * The status field drives what a dispatcher does next, so each of the four
 * states gets a fixture proving it comes from a checkable condition rather
 * than a guess. "offline" in particular must not be confused with "idle" —
 * one means the truck is rolling blind, the other means it's free.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';

const WORKOS_ORG = 'org_workos_driverslist';
const BROKER_ORG = 'org_broker_driverslist';

const DISPATCHER_PERMS = [
  ...permissionsForLevel('loads', 'manage'),
  ...permissionsForLevel('fleet', 'view'),
];
const staff = {
  subject: 's_dl',
  org_id: WORKOS_ORG,
  role: 'dispatcher',
  permissions: DISPATCHER_PERMS,
};

const HOUR = 3600_000;

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();

  await ctx.db.insert('organizations', {
    name: 'Drivers List Carrier',
    workosOrgId: WORKOS_ORG,
    orgType: 'BROKER_CARRIER',
    billingEmail: 'b@t.co',
    billingAddress: { addressLine1: '1', city: 'C', state: 'S', zip: 'Z', country: 'US' },
    subscriptionPlan: 'E',
    subscriptionStatus: 'Active',
    billingCycle: 'Annual',
    createdAt: now,
    updatedAt: now,
  });

  const mkDriver = (first: string, truckId?: string) =>
    ctx.db.insert('drivers', {
      firstName: first,
      lastName: 'D',
      email: `${first}@t.co`,
      phone: `+1555${first.length}000000`,
      licenseState: 'CA',
      licenseExpiration: '2030-01-01',
      licenseClass: 'A',
      hireDate: '2024-01-01',
      employmentStatus: 'Active',
      employmentType: 'Full-time',
      organizationId: WORKOS_ORG,
      ...(truckId ? { currentTruckId: truckId as never } : {}),
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });

  const truckId = await ctx.db.insert('trucks', {
    unitId: 'T-77',
    vin: 'VIN-DL-1',
    status: 'Active',
    organizationId: WORKOS_ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });

  const rolling = await mkDriver('Rolling', truckId);
  const dark = await mkDriver('Dark');
  const overdue = await mkDriver('Overdue');
  const free = await mkDriver('Free');

  const customerId = await ctx.db.insert('customers', {
    name: 'Cust',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1',
    city: 'C',
    state: 'S',
    zip: 'Z',
    country: 'US',
    workosOrgId: BROKER_ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });

  const mkLoad = (internalId: string) =>
    ctx.db.insert('loadInformation', {
      internalId,
      orderNumber: internalId,
      status: 'Assigned',
      trackingStatus: 'In Transit',
      customerId,
      fleet: 'Main',
      units: 'Pallets',
      workosOrgId: BROKER_ORG,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });

  const mkStop = (loadId: string, seq: number, type: 'PICKUP' | 'DELIVERY', city: string) =>
    ctx.db.insert('loadStops', {
      loadId: loadId as never,
      internalId: 'S',
      sequenceNumber: seq,
      stopType: type,
      loadingType: 'APPT',
      address: `${seq} Dock St`,
      city,
      state: 'CA',
      workosOrgId: BROKER_ORG,
      createdAt: now,
      updatedAt: now,
    });

  const mkLeg = async (
    driverId: string,
    loadId: string,
    status: 'PENDING' | 'ACTIVE',
    scheduledStartMs: number,
    cities: [string, string],
    withTruck?: string,
  ) => {
    const start = await mkStop(loadId, 1, 'PICKUP', cities[0]);
    const end = await mkStop(loadId, 2, 'DELIVERY', cities[1]);
    return ctx.db.insert('dispatchLegs', {
      loadId: loadId as never,
      driverId: driverId as never,
      ...(withTruck ? { truckId: withTruck as never } : {}),
      sequence: 1,
      startStopId: start,
      endStopId: end,
      legLoadedMiles: 100,
      legEmptyMiles: 0,
      status,
      scheduledStartMs,
      workosOrgId: WORKOS_ORG,
      createdAt: now,
      updatedAt: now,
    });
  };

  // Rolling: ACTIVE leg, GPS fix a minute old.
  const loadA = await mkLoad('L-DL-A');
  await mkLeg(rolling, loadA, 'ACTIVE', now, ['Oakland', 'Fremont'], truckId);
  await ctx.db.insert('driverLocations', {
    driverId: rolling,
    organizationId: WORKOS_ORG,
    latitude: 37.8,
    longitude: -122.2,
    trackingType: 'LOAD_ROUTE',
    recordedAt: now - 60_000,
    createdAt: now,
  });

  // Dark: ACTIVE leg, but the last fix is two hours stale.
  const loadB = await mkLoad('L-DL-B');
  await mkLeg(dark, loadB, 'ACTIVE', now, ['Tracy', 'Modesto']);
  await ctx.db.insert('driverLocations', {
    driverId: dark,
    organizationId: WORKOS_ORG,
    latitude: 37.7,
    longitude: -121.4,
    trackingType: 'LOAD_ROUTE',
    recordedAt: now - 2 * HOUR,
    createdAt: now,
  });

  // Overdue: nothing active, but a PENDING leg that should have started.
  const loadC = await mkLoad('L-DL-C');
  await mkLeg(overdue, loadC, 'PENDING', now - HOUR, ['Stockton', 'Hayward']);

  // Free: no legs at all.
  return { rolling, dark, overdue, free, truckId };
}

function setup() {
  const t = convexTest(schema);
  return { t, ready: t.run(insertFixtures) };
}

const byName = (rows: { firstName: string }[], name: string) =>
  rows.find((r) => r.firstName === name)!;

describe('listDrivers — v8 fleet-list enrichment', () => {
  it('derives all four statuses from checkable conditions', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t.withIdentity(staff as never).query(api.dispatchMobile.listDrivers, {});

    expect(byName(rows, 'Rolling').status).toBe('moving');
    // Rolling blind is NOT the same as available — the whole point of the state.
    expect(byName(rows, 'Dark').status).toBe('offline');
    expect(byName(rows, 'Overdue').status).toBe('late');
    expect(byName(rows, 'Free').status).toBe('idle');
  });

  it('returns the running route so the row answers "what are they on?"', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t.withIdentity(staff as never).query(api.dispatchMobile.listDrivers, {});

    expect(byName(rows, 'Rolling').route).toEqual({ from: 'Oakland', to: 'Fremont' });
    expect(byName(rows, 'Rolling').currentLoad?.internalId).toBe('L-DL-A');
  });

  it('leaves the route null when no work is running — never fabricates a location', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t.withIdentity(staff as never).query(api.dispatchMobile.listDrivers, {});

    // A pending leg is not a route; GPS gives coordinates, not a city.
    expect(byName(rows, 'Overdue').route).toBeNull();
    expect(byName(rows, 'Free').route).toBeNull();
    expect(byName(rows, 'Free').currentLoad).toBeNull();
  });

  it('resolves the truck unit for the row label', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t.withIdentity(staff as never).query(api.dispatchMobile.listDrivers, {});

    expect(byName(rows, 'Rolling').truckUnitId).toBe('T-77');
    expect(byName(rows, 'Free').truckUnitId).toBeNull();
  });

  it('counts today’s scheduled legs, not lifetime loads', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t.withIdentity(staff as never).query(api.dispatchMobile.listDrivers, {});

    expect(byName(rows, 'Rolling').loadsToday).toBe(1);
    expect(byName(rows, 'Overdue').loadsToday).toBe(1);
    expect(byName(rows, 'Free').loadsToday).toBe(0);
  });

  it('carries the HOS estimate every row renders a bar from', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t.withIdentity(staff as never).query(api.dispatchMobile.listDrivers, {});

    for (const r of rows) {
      expect(r.hos).toBeDefined();
      expect(typeof r.hos.cycleRemainingHours).toBe('number');
      expect(typeof r.hosLabel).toBe('string');
    }
  });
});
