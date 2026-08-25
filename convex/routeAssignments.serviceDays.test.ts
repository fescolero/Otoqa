import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';

/**
 * Feature A end-to-end: a route's service days decide whether
 * auto-assignment takes a load, evaluated against the load's own service
 * date. Plus the mutation-level guards on the calendar fields.
 *
 * 2026-09-14 is a Monday, 2026-09-19 a Saturday.
 */

const ORG = 'org_svcdays';
const USER = 'user_svcdays';
const HCR = '917DK';
const MON = '2026-09-14';
const SAT = '2026-09-19';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seed(ctx: any, o: { serviceDate?: string; activeDays?: number[] }) {
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
  await ctx.db.insert('routeAssignments', {
    workosOrgId: ORG, hcr: HCR, driverId, priority: 1, isActive: true,
    ...(o.activeDays ? { activeDays: o.activeDays } : {}),
    name: 'route', createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('autoAssignmentSettings', {
    workosOrgId: ORG, enabled: true, triggerOnCreate: true,
    scheduledEnabled: true, scheduleIntervalMinutes: 60,
    updatedBy: USER, updatedAt: now,
  });

  const loadId: Id<'loadInformation'> = await ctx.db.insert('loadInformation', {
    internalId: 'LD-SD', orderNumber: 'ORD-SD', status: 'Open',
    trackingStatus: 'Pending', customerId, fleet: 'Default', units: 'Pallets',
    ...(o.serviceDate ? { firstStopDate: o.serviceDate } : {}),
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('loadTags', {
    workosOrgId: ORG, loadId, facetKey: 'HCR', value: HCR, canonicalValue: HCR,
    ...(o.serviceDate ? { firstStopDate: o.serviceDate } : {}),
  });
  for (const [seq, stopType] of [[1, 'PICKUP'], [2, 'DELIVERY']] as const) {
    await ctx.db.insert('loadStops', {
      loadId, internalId: 'LD-SD', sequenceNumber: seq, stopType, workosOrgId: ORG,
      loadingType: 'APPT', status: 'Pending', address: `${seq} Main St`,
      ...(o.serviceDate
        ? {
            windowBeginDate: o.serviceDate,
            windowBeginTime: `${o.serviceDate}T08:00:00-07:00`,
            windowEndDate: o.serviceDate,
            windowEndTime: `${o.serviceDate}T10:00:00-07:00`,
          }
        : {}),
      createdAt: now, updatedAt: now,
    });
  }
  return { loadId, driverId };
}

describe('feature A — route service days, end to end', () => {
  it('assigns when the load falls on an active day', async () => {
    const t = convexTest(schema);
    const { loadId, driverId } = await t.run((ctx) =>
      seed(ctx, { serviceDate: MON, activeDays: [1, 3, 5] }));

    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId, userId: 'system' });

    expect(r.action).toBe('ASSIGNED_DRIVER');
    expect((await t.run((ctx) => ctx.db.get(loadId)))?.primaryDriverId).toBe(driverId);
  });

  it('declines a Saturday load on a Mon/Wed/Fri route and leaves it Open', async () => {
    const t = convexTest(schema);
    const { loadId } = await t.run((ctx) =>
      seed(ctx, { serviceDate: SAT, activeDays: [1, 3, 5] }));

    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId, userId: 'system' });

    expect(r.action).toBe('DAY_RESTRICTED');
    const load = await t.run((ctx) => ctx.db.get(loadId));
    expect(load?.status).toBe('Open');
    expect(load?.primaryDriverId).toBeUndefined();
  });

  it('an unrestricted route still assigns on a Saturday', async () => {
    const t = convexTest(schema);
    const { loadId } = await t.run((ctx) => seed(ctx, { serviceDate: SAT }));
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId, userId: 'system' });
    expect(r.action).toBe('ASSIGNED_DRIVER');
  });

  it('a restricted route reports NO_SERVICE_DATE for an undated load', async () => {
    const t = convexTest(schema);
    const { loadId } = await t.run((ctx) => seed(ctx, { activeDays: [1, 3, 5] }));

    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId, userId: 'system' });

    expect(r.action).toBe('NO_SERVICE_DATE');
    expect((await t.run((ctx) => ctx.db.get(loadId)))?.status).toBe('Open');
  });

  it('calendar declines count as skipped, never as errors', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seed(ctx, { serviceDate: SAT, activeDays: [1, 3, 5] }));

    const summary = await t.action(internal.autoAssignment.autoAssignPendingLoads, {
      workosOrgId: ORG,
    });

    expect(summary.assigned).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.errors).toBe(0);
  });
});

describe('feature A — calendar field validation', () => {
  const asUser = (t: ReturnType<typeof convexTest>) =>
    t.withIdentity({ subject: USER, org_id: ORG });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const newRoute = async (t: any, activeDays?: number[]) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const driverId = await t.run(async (ctx: any) => {
      const now = Date.now();
      return ctx.db.insert('drivers', {
        firstName: 'D', lastName: 'R', email: 'd@t.co', phone: '+15550000002',
        licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
        hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
        organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      });
    });
    return asUser(t).mutation(api.routeAssignments.create, {
      workosOrgId: ORG, hcr: HCR, driverId, createdBy: USER,
      ...(activeDays ? { activeDays } : {}),
    });
  };

  it('rejects an empty day list rather than reading it as "every day"', async () => {
    const t = convexTest(schema);
    await expect(newRoute(t, [])).rejects.toThrow(/at least one day/i);
  });

  it('rejects out-of-range days', async () => {
    const t = convexTest(schema);
    await expect(newRoute(t, [1, 7])).rejects.toThrow(/0 \(Sunday\) through 6/i);
  });

  it('stores all seven days as absent — one representation of unrestricted', async () => {
    const t = convexTest(schema);
    const id = await newRoute(t, [0, 1, 2, 3, 4, 5, 6]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.activeDays).toBeUndefined();
  });

  it('deduplicates and sorts the day list', async () => {
    const t = convexTest(schema);
    const id = await newRoute(t, [5, 1, 1, 3]);
    expect((await t.run((ctx) => ctx.db.get(id)))?.activeDays).toEqual([1, 3, 5]);
  });

  it('rejects a malformed exclusion date', async () => {
    const t = convexTest(schema);
    const id = await newRoute(t);
    await expect(
      asUser(t).mutation(api.routeAssignments.update, { id, customExclusions: ['12/25/2026'] }),
    ).rejects.toThrow(/YYYY-MM-DD/);
  });

  it('update clears a restriction by sending all seven days', async () => {
    const t = convexTest(schema);
    const id = await newRoute(t, [1, 3, 5]);
    await asUser(t).mutation(api.routeAssignments.update, {
      id, activeDays: [0, 1, 2, 3, 4, 5, 6],
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.activeDays).toBeUndefined();
  });
});

describe('feature A — two rules may share an HCR + Trip on different days', () => {
  const asUser = (t: ReturnType<typeof convexTest>) =>
    t.withIdentity({ subject: USER, org_id: ORG });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const driver = async (t: any, email: string) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    t.run(async (ctx: any) => {
      const now = Date.now();
      return ctx.db.insert('drivers', {
        firstName: 'D', lastName: 'R', email, phone: '+15550000003',
        licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
        hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
        organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      });
    });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rule = async (t: any, email: string, activeDays?: number[], name?: string) =>
    asUser(t).mutation(api.routeAssignments.create, {
      workosOrgId: ORG, hcr: '96036', tripNumber: '5',
      driverId: await driver(t, email), createdBy: USER,
      ...(activeDays ? { activeDays } : {}),
      ...(name ? { name } : {}),
    });

  it('allows a second rule whose days do not cross the first', async () => {
    const t = convexTest(schema);
    await rule(t, 'a@t.co', [1, 3, 5], 'Dana MWF');
    await expect(rule(t, 'b@t.co', [2, 4], 'Sam TuTh')).resolves.toBeDefined();
  });

  it('rejects a second rule that claims a day already covered', async () => {
    const t = convexTest(schema);
    await rule(t, 'a@t.co', [1, 3, 5], 'Dana MWF');
    await expect(rule(t, 'b@t.co', [3, 4], 'Sam WeTh')).rejects.toThrow(/Dana MWF.*Wed/s);
  });

  it('an unrestricted rule collides with everything', async () => {
    const t = convexTest(schema);
    await rule(t, 'a@t.co', undefined, 'Every day');
    await expect(rule(t, 'b@t.co', [2], 'Sam Tue')).rejects.toThrow(/Every day/);
  });

  it('a paused rule reserves nothing', async () => {
    const t = convexTest(schema);
    const first = await rule(t, 'a@t.co', [1, 3, 5], 'Dana MWF');
    await asUser(t).mutation(api.routeAssignments.update, { id: first, isActive: false });
    await expect(rule(t, 'b@t.co', [1, 3, 5], 'Sam MWF')).resolves.toBeDefined();
  });

  it('update cannot edit a rule into a collision', async () => {
    const t = convexTest(schema);
    await rule(t, 'a@t.co', [1, 3, 5], 'Dana MWF');
    const second = await rule(t, 'b@t.co', [2, 4], 'Sam TuTh');
    await expect(
      asUser(t).mutation(api.routeAssignments.update, { id: second, activeDays: [4, 5] }),
    ).rejects.toThrow(/Dana MWF.*Fri/s);
  });

  it('update can still edit a rule that stays disjoint', async () => {
    const t = convexTest(schema);
    await rule(t, 'a@t.co', [1, 3, 5], 'Dana MWF');
    const second = await rule(t, 'b@t.co', [2, 4], 'Sam TuTh');
    await expect(
      asUser(t).mutation(api.routeAssignments.update, { id: second, activeDays: [2, 4, 6] }),
    ).resolves.toBeDefined();
  });
});
