/**
 * boardCapacity — the capacity-first Board sections (§5.9).
 *
 * Two claims worth pinning: the open-truck list is bounded by fleet size and
 * empties as work is assigned (otherwise the section is just another backlog
 * list), and runs chain by the same rules suggestPlan uses (they share
 * shapeBacklog/chainIntoRuns precisely so they can't drift apart).
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';

const WORKOS_ORG = 'org_workos_capacity';
const BROKER_ORG = 'org_broker_capacity';

const DISPATCHER_PERMS = [
  ...permissionsForLevel('loads', 'manage'),
  ...permissionsForLevel('fleet', 'view'),
];
const staff = {
  subject: 's_cap',
  org_id: WORKOS_ORG,
  role: 'dispatcher',
  permissions: DISPATCHER_PERMS,
};

const HOUR = 3600_000;
// Fixed geography: Oakland → Fremont is ~20mi, well inside the 150mi chain cap.
const OAKLAND = { lat: 37.8044, lng: -122.2712 };
const FREMONT = { lat: 37.5485, lng: -121.9886 };
const SAN_JOSE = { lat: 37.3382, lng: -121.8863 };

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();

  await ctx.db.insert('organizations', {
    name: 'Capacity Carrier',
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

  const mkDriver = (first: string) =>
    ctx.db.insert('drivers', {
      firstName: first,
      lastName: 'D',
      email: `${first}@t.co`,
      phone: `+1555${first.length}111111`,
      licenseState: 'CA',
      licenseExpiration: '2030-01-01',
      licenseClass: 'A',
      hireDate: '2024-01-01',
      employmentStatus: 'Active',
      employmentType: 'Full-time',
      organizationId: WORKOS_ORG,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });

  const idleNear = await mkDriver('IdleNear');
  const idleFar = await mkDriver('IdleFar');
  const busy = await mkDriver('Busy');

  const at = (driverId: string, p: { lat: number; lng: number }) =>
    ctx.db.insert('driverLocations', {
      driverId: driverId as never,
      organizationId: WORKOS_ORG,
      latitude: p.lat,
      longitude: p.lng,
      trackingType: 'LOAD_ROUTE',
      recordedAt: now - 60_000,
      createdAt: now,
    });
  await at(idleNear, OAKLAND);
  await at(idleFar, SAN_JOSE);

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

  const iso = (ms: number) => new Date(ms).toISOString();

  /** One unassigned AWARDED load with a pickup and a delivery. */
  const mkBacklogLoad = async (
    internalId: string,
    trip: string,
    from: { p: { lat: number; lng: number }; city: string; startMs: number },
    to: { p: { lat: number; lng: number }; city: string; endMs: number },
  ) => {
    const loadId = await ctx.db.insert('loadInformation', {
      internalId,
      orderNumber: internalId,
      status: 'Assigned',
      trackingStatus: 'Pending',
      customerId,
      customerName: 'Cust',
      effectiveMiles: 20,
      fleet: 'Main',
      units: 'Pallets',
      workosOrgId: BROKER_ORG,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('loadStops', {
      loadId,
      internalId,
      sequenceNumber: 1,
      stopType: 'PICKUP',
      loadingType: 'APPT',
      address: '1 Dock St',
      city: from.city,
      state: 'CA',
      latitude: from.p.lat,
      longitude: from.p.lng,
      windowBeginTime: iso(from.startMs),
      windowEndTime: iso(from.startMs + 2 * HOUR),
      workosOrgId: BROKER_ORG,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('loadStops', {
      loadId,
      internalId,
      sequenceNumber: 2,
      stopType: 'DELIVERY',
      loadingType: 'APPT',
      address: '2 Dock St',
      city: to.city,
      state: 'CA',
      latitude: to.p.lat,
      longitude: to.p.lng,
      windowBeginTime: iso(to.endMs),
      windowEndTime: iso(to.endMs + HOUR),
      workosOrgId: BROKER_ORG,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('loadCarrierAssignments', {
      loadId,
      brokerOrgId: BROKER_ORG,
      carrierOrgId: WORKOS_ORG,
      status: 'AWARDED',
      offeredAt: now,
      createdBy: 'u',
    });
    // HCR contract facets — what the run cards identify themselves by.
    await ctx.db.insert('loadTags', {
      workosOrgId: WORKOS_ORG,
      loadId,
      facetKey: 'HCR',
      canonicalValue: '925L0',
      value: '925L0',
    });
    await ctx.db.insert('loadTags', {
      workosOrgId: WORKOS_ORG,
      loadId,
      facetKey: 'TRIP',
      canonicalValue: trip,
      value: trip,
    });
    return loadId;
  };

  // Two loads that chain: Oakland→Fremont, then Fremont→San Jose later.
  await mkBacklogLoad(
    'L-CAP-1',
    '211',
    { p: OAKLAND, city: 'Oakland', startMs: now + HOUR },
    { p: FREMONT, city: 'Fremont', endMs: now + 3 * HOUR },
  );
  await mkBacklogLoad(
    'L-CAP-2',
    '212',
    { p: FREMONT, city: 'Fremont', startMs: now + 6 * HOUR },
    { p: SAN_JOSE, city: 'San Jose', endMs: now + 8 * HOUR },
  );

  // Busy driver: an ACTIVE leg on its own load, so he must not appear as open.
  const busyLoad = await ctx.db.insert('loadInformation', {
    internalId: 'L-CAP-BUSY',
    orderNumber: 'L-CAP-BUSY',
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
  const s1 = await ctx.db.insert('loadStops', {
    loadId: busyLoad,
    internalId: 'L-CAP-BUSY',
    sequenceNumber: 1,
    stopType: 'PICKUP',
    loadingType: 'APPT',
    address: '9 Dock St',
    city: 'Tracy',
    state: 'CA',
    workosOrgId: BROKER_ORG,
    createdAt: now,
    updatedAt: now,
  });
  const s2 = await ctx.db.insert('loadStops', {
    loadId: busyLoad,
    internalId: 'L-CAP-BUSY',
    sequenceNumber: 2,
    stopType: 'DELIVERY',
    loadingType: 'APPT',
    address: '10 Dock St',
    city: 'Modesto',
    state: 'CA',
    workosOrgId: BROKER_ORG,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('dispatchLegs', {
    loadId: busyLoad,
    driverId: busy,
    sequence: 1,
    startStopId: s1,
    endStopId: s2,
    legLoadedMiles: 50,
    legEmptyMiles: 0,
    status: 'ACTIVE',
    scheduledStartMs: now,
    workosOrgId: WORKOS_ORG,
    createdAt: now,
    updatedAt: now,
  });

  return { idleNear, idleFar, busy };
}

function setup() {
  const t = convexTest(schema);
  return { t, ready: t.run(insertFixtures) };
}

const call = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity(staff as never).query(api.dispatchMobile.boardCapacity, {});

describe('boardCapacity — open trucks', () => {
  it('lists only drivers with no work — bounded by fleet, not backlog', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    expect(res.openTrucks.map((d) => d.firstName).sort()).toEqual(['IdleFar', 'IdleNear']);
  });

  it('excludes a driver on an ACTIVE leg', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    // The section must empty out as work is assigned; a busy truck appearing
    // here would make it just another list of everyone.
    expect(res.openTrucks.some((d) => d.firstName === 'Busy')).toBe(false);
  });

  it('carries the HOS estimate each truck card renders', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    for (const truck of res.openTrucks) {
      expect(typeof truck.hos.cycleRemainingHours).toBe('number');
      expect(typeof truck.hosLabel).toBe('string');
    }
  });
});

describe('boardCapacity — suggestions', () => {
  it('ranks nearest work first, in real miles', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    const near = res.openTrucks.find((d) => d.firstName === 'IdleNear')!;
    expect(near.suggestions.length).toBeGreaterThan(0);
    // Sitting in Oakland, the Oakland-origin run is essentially at the door.
    expect(near.suggestions[0].deadheadMi).toBeLessThan(5);
    expect(near.suggestions[0].from).toBe('Oakland');
  });

  it('gives a driver with no GPS fix suggestions ordered by start time', async () => {
    const { t, ready } = setup();
    const { idleNear } = await ready;
    // Strip the fix and re-read: distance is unknowable, so it must fall back
    // rather than invent a position.
    await t.run(async (ctx) => {
      const fixes = await ctx.db
        .query('driverLocations')
        .withIndex('by_driver_time', (q) => q.eq('driverId', idleNear))
        .collect();
      for (const f of fixes) await ctx.db.delete(f._id);
    });
    const res = await call(t);

    const near = res.openTrucks.find((d) => d.firstName === 'IdleNear')!;
    expect(near.suggestions.length).toBeGreaterThan(0);
    expect(near.suggestions[0].deadheadMi).toBeNull();
  });

  it('caps suggestions at three per truck', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    for (const truck of res.openTrucks) {
      expect(truck.suggestions.length).toBeLessThanOrEqual(3);
    }
  });
});

describe('boardCapacity — bundled runs', () => {
  it('chains the two backlog loads into one run', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    expect(res.runs).toHaveLength(1);
    expect(res.runs[0].loadCount).toBe(2);
    expect(res.runs[0].assignmentIds).toHaveLength(2);
  });

  it('reads the route end to end, squashing the repeated waypoint', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    const run = res.runs[0];
    expect(run.from).toBe('Oakland');
    expect(run.to).toBe('San Jose');
    // The drop and the next pickup are both Fremont — one waypoint, not two.
    expect(run.via).toEqual(['Fremont']);
  });

  it('reports the unassigned backlog it was built from', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    expect(res.unassignedCount).toBe(2);
  });
});

describe('boardCapacity — contract identity', () => {
  it('carries the HCR and trip numbers the run cards lead with', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    const run = res.runs[0];
    // On HCR work the cities repeat all day; this is what tells one run from
    // the next, so it has to reach the client.
    expect(run.hcrs).toEqual(['925L0']);
    expect(run.trips.sort()).toEqual(['211', '212']);
  });

  it('passes them onto truck suggestions too', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await call(t);

    const suggestion = res.openTrucks.flatMap((tr) => tr.suggestions)[0];
    expect(suggestion.hcrs).toEqual(['925L0']);
    expect(suggestion.trips.length).toBe(2);
  });
});
