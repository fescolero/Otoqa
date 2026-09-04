import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';

/**
 * Effective dates on rules — how a rotation is planned ahead. The
 * outgoing rule ends on a date, the incoming one starts the next day,
 * both exist, both are audited, and the matcher hands each load to the
 * rule whose range covers its pickup date.
 *
 * 2026-09-14 is a Monday.
 */

const ORG = 'org_effective';
const USER = 'user_effective';
const HCR = '917DK';

const setup = () => convexTest(schema);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedOrg(ctx: any) {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'C', companyType: 'Shipper', status: 'Active',
    addressLine1: '1 St', city: 'Town', state: 'CA', zip: '00000', country: 'USA',
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  const mk = (first: string, phone: string) =>
    ctx.db.insert('drivers', {
      firstName: first, lastName: 'Rae', email: `${first.toLowerCase()}@t.co`, phone,
      licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
      hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
  const dana: Id<'drivers'> = await mk('Dana', '+15550000001');
  const sam: Id<'drivers'> = await mk('Sam', '+15550000002');
  await ctx.db.insert('autoAssignmentSettings', {
    workosOrgId: ORG, enabled: true, triggerOnCreate: true,
    scheduledEnabled: true, scheduleIntervalMinutes: 60,
    updatedBy: USER, updatedAt: now,
  });
  return { customerId, dana, sam };
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
    workosOrgId: ORG, loadId, facetKey: 'HCR', value: HCR, canonicalValue: HCR, firstStopDate: serviceDate,
  });
  for (const [seq, stopType] of [[1, 'PICKUP'], [2, 'DELIVERY']] as const) {
    await ctx.db.insert('loadStops', {
      loadId, internalId: `LD-${tag}`, sequenceNumber: seq, stopType, workosOrgId: ORG,
      loadingType: 'APPT', status: 'Pending', address: `${seq} Main St`,
      windowBeginDate: serviceDate, windowBeginTime: `${serviceDate}T${seq === 1 ? '08' : '10'}:00:00-07:00`,
      windowEndDate: serviceDate, windowEndTime: `${serviceDate}T${seq === 1 ? '09' : '11'}:00:00-07:00`,
      createdAt: now, updatedAt: now,
    });
  }
  return loadId;
}

describe('effective dates', () => {
  it('the matcher honors the range; outside it the load stays Open as day-restricted', async () => {
    const t = setup();
    const { before, on } = await t.run(async (ctx) => {
      const o = await seedOrg(ctx);
      const now = Date.now();
      await ctx.db.insert('routeAssignments', {
        workosOrgId: ORG, hcr: HCR, driverId: o.dana, priority: 1, isActive: true,
        effectiveFrom: '2026-09-14', name: 'from Mon', createdBy: USER, createdAt: now, updatedAt: now,
      });
      return {
        before: await seedLoad(ctx, o.customerId, 'B', '2026-09-13'),
        on: await seedLoad(ctx, o.customerId, 'O', '2026-09-14'),
      };
    });
    expect((await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: before, userId: 'system' })).action)
      .toBe('DAY_RESTRICTED');
    expect((await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: on, userId: 'system' })).action)
      .toBe('ASSIGNED_DRIVER');
  });

  it('two rules on the same trip and days may coexist when their ranges do not overlap', async () => {
    const t = setup();
    const { dana, sam } = await t.run((ctx) => seedOrg(ctx));
    const asUser = t.withIdentity({ subject: USER, org_id: ORG });
    await asUser.mutation(api.routeAssignments.create, {
      workosOrgId: ORG, hcr: HCR, driverId: dana, effectiveUntil: '2026-09-13', createdBy: USER,
    });
    // Disjoint: allowed.
    await asUser.mutation(api.routeAssignments.create, {
      workosOrgId: ORG, hcr: HCR, driverId: sam, effectiveFrom: '2026-09-14', createdBy: USER,
    });
    // Overlapping the second: refused.
    await expect(
      asUser.mutation(api.routeAssignments.create, {
        workosOrgId: ORG, hcr: HCR, driverId: dana, effectiveFrom: '2026-09-20', createdBy: USER,
      }),
    ).rejects.toThrow(/already covers/);
    // Inverted range: refused.
    await expect(
      asUser.mutation(api.routeAssignments.create, {
        workosOrgId: ORG, hcr: '00000', driverId: dana, effectiveFrom: '2026-09-20', effectiveUntil: '2026-09-01', createdBy: USER,
      }),
    ).rejects.toThrow(/on or before/);
  });

  it('a scheduled change splits the rule, audits both halves, and each load goes to its half', async () => {
    const t = setup();
    const { customerId, dana, sam } = await t.run((ctx) => seedOrg(ctx));
    const asUser = t.withIdentity({ subject: USER, org_id: ORG });
    const oldId = await asUser.mutation(api.routeAssignments.create, {
      workosOrgId: ORG, hcr: HCR, driverId: dana, name: 'Dana 917DK', createdBy: USER,
    });

    // Plan next week: Sam takes over from Monday the 14th.
    const newId = await asUser.mutation(api.routeAssignments.update, {
      id: oldId, driverId: sam, applyFrom: '2026-09-14',
    });
    expect(newId).not.toBe(oldId);

    const oldRule = await t.run((ctx) => ctx.db.get(oldId));
    const newRule = await t.run((ctx) => ctx.db.get(newId));
    expect(oldRule?.driverId).toBe(dana);
    expect(oldRule?.effectiveUntil).toBe('2026-09-13');
    expect(newRule?.driverId).toBe(sam);
    expect(newRule?.effectiveFrom).toBe('2026-09-14');
    expect(newRule?.effectiveUntil).toBeUndefined();
    expect(newRule?.name).toBe('Dana 917DK'); // carried over; rename separately

    // The list shows both.
    const list = await asUser.query(api.routeAssignments.list, { workosOrgId: ORG });
    expect(list.map((r) => r._id).sort()).toEqual([oldId, newId].sort());

    // Loads land on the half whose range covers them.
    const { sun, mon } = await t.run(async (ctx) => ({
      sun: await seedLoad(ctx, customerId, 'SUN', '2026-09-13'),
      mon: await seedLoad(ctx, customerId, 'MON', '2026-09-14'),
    }));
    await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: sun, userId: 'system' });
    await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: mon, userId: 'system' });
    expect((await t.run((ctx) => ctx.db.get(sun)))?.primaryDriverId).toBe(dana);
    expect((await t.run((ctx) => ctx.db.get(mon)))?.primaryDriverId).toBe(sam);

    // The audit trail says what happened, on both rules, in words.
    const oldHistory = await asUser.query(api.routeAssignments.history, { id: oldId });
    expect(oldHistory[0]?.description).toMatch(/now ends 2026-09-13/);
    expect(oldHistory[0]?.description).toMatch(/Driver: Dana Rae → Sam Rae/);
    const newHistory = await asUser.query(api.routeAssignments.history, { id: newId });
    expect(newHistory[0]?.action).toBe('created');
    expect(newHistory[0]?.description).toMatch(/active from 2026-09-14/);
  });

  it('an in-place edit records before and after in words', async () => {
    const t = setup();
    const { dana, sam } = await t.run((ctx) => seedOrg(ctx));
    const asUser = t.withIdentity({ subject: USER, org_id: ORG });
    const id = await asUser.mutation(api.routeAssignments.create, {
      workosOrgId: ORG, hcr: HCR, driverId: dana, activeDays: [1, 2, 3, 4, 5], createdBy: USER,
    });
    await asUser.mutation(api.routeAssignments.update, { id, driverId: sam, activeDays: [1, 2, 3] });

    const history = await asUser.query(api.routeAssignments.history, { id });
    expect(history[0]?.by).toBeTruthy();
    expect(history[0]?.description).toMatch(/Driver: Dana Rae → Sam Rae/);
    expect(history[0]?.description).toMatch(/Days: Mon\/Tue\/Wed\/Thu\/Fri → Mon\/Tue\/Wed/);
  });
});
