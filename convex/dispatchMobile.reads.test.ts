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
