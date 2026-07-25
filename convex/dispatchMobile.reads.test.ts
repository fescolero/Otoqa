/**
 * Tests for the Dispatch read wrappers (split-plan §4.5): fail-loud
 * dual-path reads that serve BOTH WorkOS staff and Clerk owner-operators,
 * with no client-supplied org id.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';

const CLERK_ORG = 'org_clerk_reads_A';
const WORKOS_ORG = 'org_workos_reads_A';
const OWNER = 'user_reads_owner';

const DISPATCHER_PERMS = [
  ...permissionsForLevel('loads', 'manage'),
  ...permissionsForLevel('fleet', 'view'),
];
const BILLING_PERMS = [
  ...permissionsForLevel('loads', 'view'),
  ...permissionsForLevel('fleet', 'view'),
  ...permissionsForLevel('accounting', 'manage'),
];

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Reads Carrier',
    clerkOrgId: CLERK_ORG,
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
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: OWNER,
    organizationId: orgId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });

  const mkDriver = (first: string, organizationId: string) =>
    ctx.db.insert('drivers', {
      firstName: first,
      lastName: 'Driver',
      email: `${first}@t.co`,
      phone: `+1555000${first.length}00`,
      licenseState: 'CA',
      licenseExpiration: '2030-01-01',
      licenseClass: 'A',
      hireDate: '2024-01-01',
      employmentStatus: 'Active',
      employmentType: 'Full-time',
      organizationId,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
  // One driver keyed by the org's CONVEX id (mobile-created), one by the
  // WORKOS id (web-created) — the merge behavior under test.
  const driverBusy = await mkDriver('Busy', orgId);
  const driverFree = await mkDriver('Free', WORKOS_ORG);

  await ctx.db.insert('driverLocations', {
    driverId: driverBusy,
    organizationId: WORKOS_ORG,
    latitude: 37.5,
    longitude: -121.9,
    trackingType: 'LOAD_ROUTE',
    recordedAt: now - 60_000,
    createdAt: now,
  });

  const customerId = await ctx.db.insert('customers', {
    name: 'Cust',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1',
    city: 'C',
    state: 'S',
    zip: 'Z',
    country: 'US',
    workosOrgId: 'org_broker_X',
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'L-9001',
    orderNumber: 'O-9001',
    status: 'Assigned',
    trackingStatus: 'In Transit',
    customerId,
    fleet: 'Main',
    units: 'Pallets',
    workosOrgId: 'org_broker_X',
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('loadStops', {
    loadId,
    internalId: 'L-9001',
    sequenceNumber: 1,
    stopType: 'PICKUP',
    loadingType: 'APPT',
    address: '1 Dock St',
    workosOrgId: 'org_broker_X',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('loadCarrierAssignments', {
    loadId,
    brokerOrgId: 'org_broker_X',
    carrierOrgId: CLERK_ORG,
    status: 'IN_PROGRESS',
    assignedDriverId: driverBusy,
    offeredAt: now,
    createdBy: 'u',
  });
  return { driverBusy, driverFree };
}

function setup() {
  const t = convexTest(schema);
  const ready = t.run(insertFixtures);
  return { t, ready };
}

const staffDispatcher = { subject: 's_d', org_id: WORKOS_ORG, role: 'dispatcher', permissions: DISPATCHER_PERMS };
const staffBilling = { subject: 's_b', org_id: WORKOS_ORG, role: 'billing', permissions: BILLING_PERMS };

describe('read wrappers — data correctness', () => {
  it('listActiveAssignments enriches load, stops, driver, location (staff dispatcher)', async () => {
    const { t, ready } = setup();
    const { driverBusy } = await ready;
    const rows = await t
      .withIdentity(staffDispatcher as never)
      .query(api.dispatchMobile.listActiveAssignments, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].load?.internalId).toBe('L-9001');
    expect(rows[0].stops).toHaveLength(1);
    expect(rows[0].driver?._id).toBe(driverBusy);
    expect(rows[0].driverLocation?.latitude).toBe(37.5);
  });

  it('listDrivers merges convex-id and workos-id driver rows (Clerk owner)', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t.withIdentity({ subject: OWNER }).query(api.dispatchMobile.listDrivers, {});
    expect(rows.map((r) => r.firstName).sort()).toEqual(['Busy', 'Free']);
    const busy = rows.find((r) => r.firstName === 'Busy');
    expect(busy?.currentLoad?.internalId).toBe('L-9001');
  });

  it('listAvailableDrivers excludes the in-progress driver', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t
      .withIdentity(staffDispatcher as never)
      .query(api.dispatchMobile.listAvailableDrivers, {});
    expect(rows.map((r) => r.firstName)).toEqual(['Free']);
  });

  it('listDriverLocations returns only recently-pinged drivers with their load', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await t
      .withIdentity(staffBilling as never)
      .query(api.dispatchMobile.listDriverLocations, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].driver.firstName).toBe('Busy');
    expect(rows[0].load?.internalId).toBe('L-9001');
  });
});

describe('read wrappers — fail loud', () => {
  it('unauthenticated throws (never empty)', async () => {
    const { t, ready } = setup();
    await ready;
    await expect(t.query(api.dispatchMobile.listActiveAssignments, {})).rejects.toThrow(
      'Unauthenticated',
    );
  });

  it('staff of another org throws (org derives from token, cross-org impossible)', async () => {
    const { t, ready } = setup();
    await ready;
    await expect(
      t
        .withIdentity({ subject: 's_x', org_id: 'org_workos_other', role: 'admin' } as never)
        .query(api.dispatchMobile.listActiveAssignments, {}),
    ).rejects.toThrow('Organization not provisioned');
  });

  it('Clerk caller with no owner membership throws', async () => {
    const { t, ready } = setup();
    await ready;
    await expect(
      t.withIdentity({ subject: 'user_random' }).query(api.dispatchMobile.listDrivers, {}),
    ).rejects.toThrow('Not authorized');
  });
});

describe('settlement wrappers — capability gate', () => {
  it('dispatcher role is denied settlements, loud', async () => {
    const { t, ready } = setup();
    await ready;
    await expect(
      t.withIdentity(staffDispatcher as never).query(api.dispatchMobile.listStatements, {}),
    ).rejects.toThrow('Not authorized: missing canViewSettlements');
  });

  it('billing role and Clerk owner both pass the gate (empty org → [])', async () => {
    const { t, ready } = setup();
    await ready;
    await expect(
      t.withIdentity(staffBilling as never).query(api.dispatchMobile.listStatements, {}),
    ).resolves.toEqual([]);
    await expect(
      t.withIdentity({ subject: OWNER }).query(api.dispatchMobile.listStatements, {}),
    ).resolves.toEqual([]);
  });

  it('details behind the same gate', async () => {
    const { t, ready } = setup();
    await ready;
    await expect(
      t.withIdentity(staffDispatcher as never).query(api.dispatchMobile.getStatementDetails, {
        settlementId: 'x',
        source: 'legacy',
      }),
    ).rejects.toThrow('Not authorized: missing canViewSettlements');
  });
});

describe('ranked assignment (§5.1)', () => {
  it('ranks free+near driver above busy one, with warns; conflict returns alreadyAssigned', async () => {
    const { t, ready } = setup();
    const { driverBusy, driverFree } = await ready;
    const dispatcher = t.withIdentity(staffDispatcher as never);

    // The fixture assignment is IN_PROGRESS with driverBusy assigned.
    const a = await t.run(async (ctx) => {
      const rows = await ctx.db.query('loadCarrierAssignments').collect();
      return rows[0];
    });

    const ranked = await dispatcher.query(api.dispatchMobile.suggestDriversForLoad, {
      assignmentId: a._id,
    });
    // Assigned driver excluded; Free ranked with a no-GPS warn.
    expect(ranked.map((r) => r.firstName)).toEqual(['Free']);
    expect(ranked[0].warns).toContain('No GPS data');

    // Conflict path: already assigned to Busy → no clobber.
    const res = await dispatcher.mutation(api.dispatchMobile.assignDriverToLoad, {
      assignmentId: a._id,
      driverId: driverFree,
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.alreadyAssigned.driverId).toBe(driverBusy);
  });

  it('assigns onto an AWARDED load and denies cross-org/billing-role callers', async () => {
    const { t, ready } = setup();
    const { driverFree } = await ready;
    const a = await t.run(async (ctx) => {
      const rows = await ctx.db.query('loadCarrierAssignments').collect();
      await ctx.db.patch(rows[0]._id, { status: 'AWARDED', assignedDriverId: undefined });
      return rows[0]._id;
    });

    await expect(
      t.withIdentity(staffBilling as never).mutation(api.dispatchMobile.assignDriverToLoad, {
        assignmentId: a,
        driverId: driverFree,
      }),
    ).rejects.toThrow('Not authorized: missing canDispatch');

    const res = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.dispatchMobile.assignDriverToLoad, { assignmentId: a, driverId: driverFree });
    expect(res.success).toBe(true);
    const after = await t.run((ctx) => ctx.db.get(a));
    expect(after?.assignedDriverName).toBe('Free Driver');
  });
});

describe('load creation (§5.6) — shared model, parity, self-assignment', () => {
  const stop = (seq: number, type: 'PICKUP' | 'DELIVERY') => ({
    sequenceNumber: seq,
    stopType: type,
    loadingType: 'APPT' as const,
    address: `${seq} Parity St`,
    windowBeginDate: '2026-08-01',
    windowBeginTime: '2026-08-01T08:00:00-07:00',
    windowEndDate: '2026-08-01',
    windowEndTime: '2026-08-01T10:00:00-07:00',
    commodityDescription: 'Produce',
    commodityUnits: 'Pallets' as const,
    pieces: 10,
  });
  const baseArgs = (internalId: string) => ({
    internalId,
    orderNumber: `ORD-${internalId}`,
    fleet: 'Main',
    units: 'Pallets' as const,
    commodityDescription: 'Produce',
    stops: [stop(1, 'PICKUP'), stop(2, 'DELIVERY')],
  });

  it('web path and mobile path produce identical load docs; mobile self-assigns AWARDED', async () => {
    const { t, ready } = setup();
    await ready;
    const customerId = await t.run(async (ctx) => {
      const c = await ctx.db.query('customers').first();
      return c!._id;
    });

    const webLoadId = await t
      .withIdentity({ subject: 'web_admin', org_id: WORKOS_ORG, role: 'admin' } as never)
      .mutation(api.loads.createLoad, {
        ...baseArgs('L-WEB-1'),
        customerId,
        workosOrgId: WORKOS_ORG,
        createdBy: 'web_admin',
      });

    const res = await t
      .withIdentity({ subject: OWNER })
      .mutation(api.dispatchMobile.createLoad, { ...baseArgs('L-MOB-1'), customerId });

    const [webLoad, mobLoad, assignment] = await t.run(async (ctx) => [
      await ctx.db.get(webLoadId),
      await ctx.db.get(res.loadId),
      await ctx.db.get(res.assignmentId),
    ]);
    const strip = (l: Record<string, unknown> | null) => {
      const { _id, _creationTime, createdAt, updatedAt, createdBy, internalId, orderNumber, ...rest } =
        l as Record<string, unknown>;
      return rest;
    };
    expect(strip(mobLoad)).toEqual(strip(webLoad));
    expect(assignment).toMatchObject({
      status: 'AWARDED',
      carrierOrgId: CLERK_ORG,
      brokerOrgId: WORKOS_ORG,
    });
    const stops = await t.run((ctx) =>
      ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', res.loadId))
        .collect(),
    );
    expect(stops).toHaveLength(2);
  });

  it('denies billing role; validates empty stops via the shared path', async () => {
    const { t, ready } = setup();
    await ready;
    const customerId = await t.run(async (ctx) => (await ctx.db.query('customers').first())!._id);
    await expect(
      t.withIdentity(staffBilling as never).mutation(api.dispatchMobile.createLoad, {
        ...baseArgs('L-DENY'),
        customerId,
      }),
    ).rejects.toThrow('Not authorized: missing canDispatch');
    await expect(
      t.withIdentity({ subject: OWNER }).mutation(api.dispatchMobile.createLoad, {
        ...baseArgs('L-EMPTY'),
        customerId,
        stops: [],
      }),
    ).rejects.toThrow('At least one stop is required');
  });
});
