import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { api, internal } from '../_generated/api';

/**
 * Provenance backfill: loads the robot assigned before provenance existed
 * get stamped with the rule that owns them; loads a person assigned do not.
 */

const ORG = 'org_backfill';
const USER = 'user_backfill';
const HCR = '917DK';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migration: any = (internal as any)['migrations/018_backfill_auto_assign_provenance'];

const setup = () => convexTest(schema);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedOrg(ctx: any) {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'C', companyType: 'Shipper', status: 'Active',
    addressLine1: '1 St', city: 'Town', state: 'CA', zip: '00000', country: 'USA',
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  const driverId: Id<'drivers'> = await ctx.db.insert('drivers', {
    firstName: 'Dana', lastName: 'Rae', email: 'dana@t.co', phone: '+15550000001',
    licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
    hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
    organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  const routeId: Id<'routeAssignments'> = await ctx.db.insert('routeAssignments', {
    workosOrgId: ORG, hcr: HCR, driverId, priority: 1, isActive: true,
    name: 'route', createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('autoAssignmentSettings', {
    workosOrgId: ORG, enabled: true, triggerOnCreate: true,
    scheduledEnabled: true, scheduleIntervalMinutes: 60,
    updatedBy: USER, updatedAt: now,
  });
  return { customerId, driverId, routeId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedLoad(ctx: any, customerId: Id<'customers'>, tag: string, serviceDate: string) {
  const now = Date.now();
  const loadId: Id<'loadInformation'> = await ctx.db.insert('loadInformation', {
    internalId: `LD-${tag}`, orderNumber: `ORD-${tag}`, status: 'Open',
    trackingStatus: 'Pending', customerId, fleet: 'Default', units: 'Pallets',
    firstStopDate: serviceDate,
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('loadTags', {
    workosOrgId: ORG, loadId, facetKey: 'HCR', value: HCR, canonicalValue: HCR,
    firstStopDate: serviceDate,
  });
  for (const [seq, stopType] of [[1, 'PICKUP'], [2, 'DELIVERY']] as const) {
    await ctx.db.insert('loadStops', {
      loadId, internalId: `LD-${tag}`, sequenceNumber: seq, stopType, workosOrgId: ORG,
      loadingType: 'APPT', status: 'Pending', address: `${seq} Main St`,
      windowBeginDate: serviceDate,
      windowBeginTime: `${serviceDate}T${seq === 1 ? '08' : '10'}:00:00-07:00`,
      windowEndDate: serviceDate,
      windowEndTime: `${serviceDate}T${seq === 1 ? '09' : '11'}:00:00-07:00`,
      createdAt: now, updatedAt: now,
    });
  }
  return loadId;
}

async function world() {
  const t = setup();
  const s = await t.run(async (ctx) => {
    const org = await seedOrg(ctx);
    return {
      ...org,
      robot: await seedLoad(ctx, org.customerId, 'R', '2026-10-05'),
      human: await seedLoad(ctx, org.customerId, 'H', '2026-10-06'),
    };
  });
  const asUser = t.withIdentity({ subject: USER, org_id: ORG });

  // The sweep places one (audit: performedBy 'system'); a dispatcher the other.
  const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: s.robot, userId: 'system' });
  expect(r.action).toBe('ASSIGNED_DRIVER');
  const m = await asUser.mutation(api.dispatchLegs.assignDriver, {
    loadId: s.human, driverId: s.driverId, userId: USER, workosOrgId: ORG,
  });
  expect(m.status).toBe('SUCCESS');

  // Simulate "assigned before provenance existed": strip the stamp.
  await t.run((ctx) =>
    ctx.db.patch(s.robot, { autoAssignedRouteId: undefined, autoAssignedAt: undefined }));

  return { t, ...s };
}

describe('018 — backfill auto-assignment provenance', () => {
  it('stamps the robot\'s load with its rule and leaves the dispatcher\'s alone', async () => {
    const w = await world();

    const totals = await w.t.action(migration.startBackfill, {});
    expect(totals).toMatchObject({ scanned: 2, stamped: 1, skippedHuman: 1 });

    const robot = await w.t.run((ctx) => ctx.db.get(w.robot));
    expect(robot?.autoAssignedRouteId).toBe(w.routeId);
    expect(robot?.autoAssignedAt).toBeTypeOf('number');

    const human = await w.t.run((ctx) => ctx.db.get(w.human));
    expect(human?.autoAssignedRouteId).toBeUndefined();
  });

  it('is idempotent and honors dryRun', async () => {
    const w = await world();

    const dry = await w.t.action(migration.startBackfill, { dryRun: true });
    expect(dry.stamped).toBe(1);
    expect((await w.t.run((ctx) => ctx.db.get(w.robot)))?.autoAssignedRouteId).toBeUndefined();

    await w.t.action(migration.startBackfill, { workosOrgId: ORG });
    const again = await w.t.action(migration.startBackfill, {});
    expect(again.scanned).toBe(1); // only the human load is still unstamped
    expect(again.stamped).toBe(0);
  });

  it('a backfilled load becomes a re-sync candidate once the rule rotates', async () => {
    const w = await world();
    await w.t.action(migration.startBackfill, {});

    const driverB = await w.t.run((ctx) =>
      ctx.db.insert('drivers', {
        firstName: 'Sam', lastName: 'Rae', email: 'sam@t.co', phone: '+15550000002',
        licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
        hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
        organizationId: ORG, createdBy: USER, createdAt: Date.now(), updatedAt: Date.now(),
      }));
    const asUser = w.t.withIdentity({ subject: USER, org_id: ORG });
    await asUser.mutation(api.routeAssignments.update, { id: w.routeId, driverId: driverB });

    const preview = await asUser.query(api.routeAssignments.previewOrgRotation, { workosOrgId: ORG });
    expect(preview.outOfSync).toBe(1);
  });
});
