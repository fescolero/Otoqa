import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';

/**
 * R9 — auto-assignment declines an overlap where a human may proceed.
 *
 * The manual path deliberately never blocks: a dispatcher looking at the
 * driver's board may knowingly double-book. Auto-assignment has no such
 * judgment, so it refuses and leaves the load Open.
 */

const ORG = 'org_overlap';
const USER = 'user_overlap';
const HCR = '917DK';
const DAY = '2026-09-14';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function stops(ctx: any, loadId: Id<'loadInformation'>, id: string, from: string, to: string) {
  const now = Date.now();
  const spec = [
    [1, 'PICKUP', from],
    [2, 'DELIVERY', to],
  ] as const;
  for (const [seq, stopType, time] of spec) {
    await ctx.db.insert('loadStops', {
      loadId, internalId: id, sequenceNumber: seq, stopType, workosOrgId: ORG,
      loadingType: 'APPT', status: 'Pending', address: `${seq} Main St`,
      windowBeginDate: DAY, windowBeginTime: `${DAY}T${time}:00-07:00`,
      windowEndDate: DAY, windowEndTime: `${DAY}T${time}:00-07:00`,
      createdAt: now, updatedAt: now,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seed(ctx: any) {
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
    name: 'route', createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('autoAssignmentSettings', {
    workosOrgId: ORG, enabled: true, triggerOnCreate: true,
    scheduledEnabled: true, scheduleIntervalMinutes: 60,
    updatedBy: USER, updatedAt: now,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mkLoad = async (id: string, from: string, to: string): Promise<Id<'loadInformation'>> => {
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: id, orderNumber: id, status: 'Open', trackingStatus: 'Pending',
      customerId, fleet: 'Default', units: 'Pallets', firstStopDate: DAY,
      workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert('loadTags', {
      workosOrgId: ORG, loadId, facetKey: 'HCR', value: HCR,
      canonicalValue: HCR, firstStopDate: DAY,
    });
    await stops(ctx, loadId, id, from, to);
    return loadId;
  };

  // Two loads whose windows overlap (08:00-12:00 and 10:00-14:00).
  const first = await mkLoad('LD-A', '08', '12');
  const second = await mkLoad('LD-B', '10', '14');
  return { driverId, first, second };
}

describe('R9 — overlap handling splits by caller', () => {
  it('auto-assignment declines the second load and leaves it Open', async () => {
    const t = convexTest(schema);
    const { first, second } = await t.run(seed);

    const a = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId: first, userId: 'system',
    });
    expect(a.action).toBe('ASSIGNED_DRIVER');

    const b = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId: second, userId: 'system',
    });

    expect(b.action).toBe('OVERLAP_CONFLICT');
    expect(b.message).toMatch(/already booked/i);
    const load = await t.run((ctx) => ctx.db.get(second));
    expect(load?.status).toBe('Open');
    expect(load?.primaryDriverId).toBeUndefined();
  });

  it('the manual path still proceeds, reporting the overlap as insight', async () => {
    const t = convexTest(schema);
    const { driverId, first, second } = await t.run(seed);
    const asUser = t.withIdentity({ subject: USER, org_id: ORG });

    await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: first, userId: 'system' });

    const res = await asUser.mutation(api.dispatchLegs.assignDriver, {
      loadId: second, driverId, userId: USER, workosOrgId: ORG,
    });

    expect(res.status).toBe('SUCCESS');
    expect(res.status === 'SUCCESS' && res.overlaps?.length).toBeTruthy();
    expect((await t.run((ctx) => ctx.db.get(second)))?.status).toBe('Assigned');
  });

  it('declining writes nothing — no leg is left behind', async () => {
    const t = convexTest(schema);
    const { second, first } = await t.run(seed);

    await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: first, userId: 'system' });
    await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: second, userId: 'system' });

    const legs = await t.run((ctx) =>
      ctx.db.query('dispatchLegs').withIndex('by_load', (q) => q.eq('loadId', second)).collect());
    expect(legs).toHaveLength(0);
  });

  it('a non-overlapping load still assigns', async () => {
    const t = convexTest(schema);
    const { first } = await t.run(seed);
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId: first, userId: 'system',
    });
    expect(r.action).toBe('ASSIGNED_DRIVER');
  });
});

describe('R9 — the sweep reports why, not just how many', () => {
  it('breaks the run down by outcome', async () => {
    const t = convexTest(schema);
    await t.run(seed);

    const summary = await t.action(internal.autoAssignment.autoAssignPendingLoads, {
      workosOrgId: ORG,
    });

    expect(summary.processed).toBe(2);
    expect(summary.assigned).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.errors).toBe(0);
    expect(summary.byAction).toEqual(
      expect.arrayContaining([
        { action: 'ASSIGNED_DRIVER', count: 1 },
        { action: 'OVERLAP_CONFLICT', count: 1 },
      ]),
    );
  });

  it('the cron persists that breakdown for the settings page', async () => {
    const t = convexTest(schema);
    await t.run(seed);

    await t.action(internal.autoAssignmentCron.runScheduledAutoAssignment, {});

    const settings = await t.run((ctx) =>
      ctx.db.query('autoAssignmentSettings')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', ORG)).first());

    expect(settings?.lastRun).toBeDefined();
    expect(settings?.lastRun?.assigned).toBe(1);
    expect(settings?.lastRun?.byAction).toEqual(
      expect.arrayContaining([{ action: 'OVERLAP_CONFLICT', count: 1 }]),
    );
  });
});
