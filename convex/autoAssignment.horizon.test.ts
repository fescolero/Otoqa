import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import { serviceDateOf } from './lib/assignHorizon';

/**
 * Assignment horizon, end to end: a load whose pickup is further out than
 * `assignAheadDays` is deferred (stays Open, BEYOND_HORIZON), on both the
 * on-create trigger and the sweep, and the sweep's load query is bounded
 * by the same line. Plus the settings guard that ties the horizon to the
 * scheduled sweep.
 *
 * Also the provenance half of the change: a successful auto-assignment
 * stamps the rule that made it onto the load.
 */

const ORG = 'org_horizon';
const USER = 'user_horizon';
const HCR = '917DK';
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(n: number): string {
  return serviceDateOf(Date.now() + n * DAY_MS);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedOrg(ctx: any, settings: { assignAheadDays?: number } = {}) {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'C', companyType: 'Shipper', status: 'Active',
    addressLine1: '1 St', city: 'Town', state: 'CA', zip: '00000', country: 'USA',
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  const driverId = await ctx.db.insert('drivers', {
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
    ...(settings.assignAheadDays !== undefined ? { assignAheadDays: settings.assignAheadDays } : {}),
    updatedBy: USER, updatedAt: now,
  });
  return { customerId, driverId, routeId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedLoad(ctx: any, customerId: Id<'customers'>, tag: string, serviceDate?: string) {
  const now = Date.now();
  const loadId: Id<'loadInformation'> = await ctx.db.insert('loadInformation', {
    internalId: `LD-${tag}`, orderNumber: `ORD-${tag}`, status: 'Open',
    trackingStatus: 'Pending', customerId, fleet: 'Default', units: 'Pallets',
    ...(serviceDate ? { firstStopDate: serviceDate } : {}),
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('loadTags', {
    workosOrgId: ORG, loadId, facetKey: 'HCR', value: HCR, canonicalValue: HCR,
    ...(serviceDate ? { firstStopDate: serviceDate } : {}),
  });
  for (const [seq, stopType] of [[1, 'PICKUP'], [2, 'DELIVERY']] as const) {
    await ctx.db.insert('loadStops', {
      loadId, internalId: `LD-${tag}`, sequenceNumber: seq, stopType, workosOrgId: ORG,
      loadingType: 'APPT', status: 'Pending', address: `${seq} Main St`,
      ...(serviceDate
        ? {
            windowBeginDate: serviceDate,
            windowBeginTime: `${serviceDate}T08:00:00-07:00`,
            windowEndDate: serviceDate,
            windowEndTime: `${serviceDate}T10:00:00-07:00`,
          }
        : {}),
      createdAt: now, updatedAt: now,
    });
  }
  return loadId;
}

describe('assignment horizon', () => {
  it('sweep path: a load beyond the horizon is deferred, one inside it is assigned', async () => {
    const t = convexTest(schema);
    const { farId, nearId, driverId, routeId } = await t.run(async (ctx) => {
      const { customerId, driverId, routeId } = await seedOrg(ctx, { assignAheadDays: 7 });
      return {
        farId: await seedLoad(ctx, customerId, 'FAR', daysFromNow(30)),
        nearId: await seedLoad(ctx, customerId, 'NEAR', daysFromNow(3)),
        driverId,
        routeId,
      };
    });

    const far = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: farId, userId: 'system' });
    expect(far.action).toBe('BEYOND_HORIZON');
    const farLoad = await t.run((ctx) => ctx.db.get(farId));
    expect(farLoad?.status).toBe('Open');
    expect(farLoad?.primaryDriverId).toBeUndefined();
    // Deferred is not opted out — the next sweep must still consider it.
    expect(farLoad?.autoAssignOptOut).toBeUndefined();

    const near = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: nearId, userId: 'system' });
    expect(near.action).toBe('ASSIGNED_DRIVER');
    const nearLoad = await t.run((ctx) => ctx.db.get(nearId));
    expect(nearLoad?.primaryDriverId).toBe(driverId);
    // Provenance: the rule that decided is stamped on the load.
    expect(nearLoad?.autoAssignedRouteId).toBe(routeId);
    expect(nearLoad?.autoAssignedAt).toBeTypeOf('number');
  });

  it('on-create path defers the same way', async () => {
    const t = convexTest(schema);
    const farId = await t.run(async (ctx) => {
      const { customerId } = await seedOrg(ctx, { assignAheadDays: 7 });
      return seedLoad(ctx, customerId, 'FAR', daysFromNow(30));
    });

    const r = await t.mutation(internal.autoAssignment.triggerAutoAssignmentForLoad, {
      loadId: farId, workosOrgId: ORG, userId: 'fourkites-sync',
    });
    expect(r?.action).toBe('BEYOND_HORIZON');
    const load = await t.run((ctx) => ctx.db.get(farId));
    expect(load?.status).toBe('Open');
  });

  it('the last day inside the horizon is due', async () => {
    const t = convexTest(schema);
    const edgeId = await t.run(async (ctx) => {
      const { customerId } = await seedOrg(ctx, { assignAheadDays: 7 });
      return seedLoad(ctx, customerId, 'EDGE', daysFromNow(7));
    });
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: edgeId, userId: 'system' });
    expect(r.action).toBe('ASSIGNED_DRIVER');
  });

  it('no horizon configured → legacy behavior, a load a month out is assigned', async () => {
    const t = convexTest(schema);
    const farId = await t.run(async (ctx) => {
      const { customerId } = await seedOrg(ctx);
      return seedLoad(ctx, customerId, 'FAR', daysFromNow(30));
    });
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: farId, userId: 'system' });
    expect(r.action).toBe('ASSIGNED_DRIVER');
  });

  it('an undated load is not deferred by the horizon', async () => {
    const t = convexTest(schema);
    const undatedId = await t.run(async (ctx) => {
      const { customerId } = await seedOrg(ctx, { assignAheadDays: 7 });
      return seedLoad(ctx, customerId, 'UNDATED');
    });
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: undatedId, userId: 'system' });
    // The unrestricted rule takes it; assignDriverInternal builds a leg
    // from the two (undated) stops.
    expect(r.action).not.toBe('BEYOND_HORIZON');
  });

  it('the sweep query is bounded by the horizon and keeps undated loads', async () => {
    const t = convexTest(schema);
    const { farId, nearId, undatedId } = await t.run(async (ctx) => {
      const { customerId } = await seedOrg(ctx, { assignAheadDays: 7 });
      return {
        farId: await seedLoad(ctx, customerId, 'FAR', daysFromNow(30)),
        nearId: await seedLoad(ctx, customerId, 'NEAR', daysFromNow(3)),
        undatedId: await seedLoad(ctx, customerId, 'UNDATED'),
      };
    });

    const bounded = await t.query(internal.autoAssignment.getOpenLoadsWithHcr, {
      workosOrgId: ORG, maxFirstStopDate: daysFromNow(7),
    });
    const ids = bounded.map((l) => l._id);
    expect(ids).toContain(nearId);
    expect(ids).toContain(undatedId);
    expect(ids).not.toContain(farId);

    const unbounded = await t.query(internal.autoAssignment.getOpenLoadsWithHcr, { workosOrgId: ORG });
    expect(unbounded.map((l) => l._id)).toContain(farId);
  });

  it('the scheduled sweep counts deferred loads as skipped, not errors', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const { customerId } = await seedOrg(ctx, { assignAheadDays: 7 });
      await seedLoad(ctx, customerId, 'FAR', daysFromNow(30));
      await seedLoad(ctx, customerId, 'NEAR', daysFromNow(3));
    });

    const run = await t.action(internal.autoAssignment.autoAssignPendingLoads, { workosOrgId: ORG });
    // The far load never reaches the mutation: the bounded query drops it.
    expect(run.processed).toBe(1);
    expect(run.assigned).toBe(1);
    expect(run.errors).toBe(0);
  });
});

describe('updateSettings — horizon', () => {
  const asUser = (t: ReturnType<typeof convexTest>) =>
    t.withIdentity({ subject: USER, org_id: ORG });

  it('stores, then clears with null', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));

    await asUser(t).mutation(api.routeAssignments.updateSettings, {
      workosOrgId: ORG, assignAheadDays: 14, updatedBy: USER,
    });
    let s = await asUser(t).query(api.routeAssignments.getSettings, { workosOrgId: ORG });
    expect(s?.assignAheadDays).toBe(14);

    await asUser(t).mutation(api.routeAssignments.updateSettings, {
      workosOrgId: ORG, assignAheadDays: null, updatedBy: USER,
    });
    s = await asUser(t).query(api.routeAssignments.getSettings, { workosOrgId: ORG });
    expect(s?.assignAheadDays).toBeUndefined();
  });

  it('refuses a horizon without the scheduled sweep (R2: nothing would ever retry)', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));

    await expect(
      asUser(t).mutation(api.routeAssignments.updateSettings, {
        workosOrgId: ORG, scheduledEnabled: false, assignAheadDays: 7, updatedBy: USER,
      }),
    ).rejects.toThrow(/Scheduled Processing/);

    // And turning the sweep off while a horizon is set.
    await asUser(t).mutation(api.routeAssignments.updateSettings, {
      workosOrgId: ORG, assignAheadDays: 7, updatedBy: USER,
    });
    await expect(
      asUser(t).mutation(api.routeAssignments.updateSettings, {
        workosOrgId: ORG, scheduledEnabled: false, updatedBy: USER,
      }),
    ).rejects.toThrow(/Scheduled Processing/);
  });

  it('rejects out-of-range values', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedOrg(ctx));
    await expect(
      asUser(t).mutation(api.routeAssignments.updateSettings, {
        workosOrgId: ORG, assignAheadDays: -1, updatedBy: USER,
      }),
    ).rejects.toThrow();
  });
});
