import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

/**
 * R11 regression: a load a human deliberately returned to Open must not be
 * handed straight back by auto-assignment.
 *
 * Before the fix, `unassignResource` cleared primaryDriverId and set
 * status:'Open' — exactly what getOpenLoadsWithHcr selects for — so the next
 * sweep re-matched the same route rule and re-assigned the same driver,
 * within scheduleIntervalMinutes (default 60).
 */

const ORG = 'org_r11';
const USER = 'user_r11';
const HCR = '917DK';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedWorld(ctx: any, opts: { optOut?: boolean } = {}) {
  const now = Date.now();

  const customerId = await ctx.db.insert('customers', {
    name: 'C', companyType: 'Shipper', status: 'Active',
    addressLine1: '1 St', city: 'Town', state: 'CA', zip: '00000', country: 'USA',
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });

  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Dana', lastName: 'Rae',
    email: 'dana@t.co', phone: '+15550000001',
    licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
    hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
    organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });

  await ctx.db.insert('routeAssignments', {
    workosOrgId: ORG, hcr: HCR, driverId, priority: 1, isActive: true,
    createdBy: USER, createdAt: now, updatedAt: now,
  });

  await ctx.db.insert('autoAssignmentSettings', {
    workosOrgId: ORG, enabled: true, triggerOnCreate: true,
    scheduledEnabled: true, scheduleIntervalMinutes: 60,
    updatedBy: USER, updatedAt: now,
  });

  // An unassigned load carrying the HCR facet — the state unassignResource
  // leaves behind.
  const loadId: Id<'loadInformation'> = await ctx.db.insert('loadInformation', {
    internalId: 'LD-R11', orderNumber: 'ORD-R11', status: 'Open',
    trackingStatus: 'Pending', customerId, fleet: 'Default', units: 'Pallets',
    firstStopDate: '2026-09-14',
    ...(opts.optOut ? { autoAssignOptOut: true } : {}),
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });

  await ctx.db.insert('loadTags', {
    workosOrgId: ORG, loadId, facetKey: 'HCR',
    value: HCR, canonicalValue: HCR, firstStopDate: '2026-09-14',
  });

  // Two stops so assignDriverInternal can build a leg.
  for (const [seq, stopType] of [[1, 'PICKUP'], [2, 'DELIVERY']] as const) {
    await ctx.db.insert('loadStops', {
      loadId, internalId: 'LD-R11', sequenceNumber: seq, stopType,
      loadingType: 'APPT', status: 'Pending', address: `${seq} Main St`,
      workosOrgId: ORG,
      windowBeginDate: '2026-09-14', windowBeginTime: '2026-09-14T08:00:00-07:00',
      windowEndDate: '2026-09-14', windowEndTime: '2026-09-14T10:00:00-07:00',
      createdAt: now, updatedAt: now,
    });
  }

  return { loadId, driverId };
}

describe('R11 — auto-assignment respects a manual unassignment', () => {
  it('re-assigns an eligible Open load (control: the mechanism works)', async () => {
    const t = convexTest(schema);
    const { loadId, driverId } = await t.run((ctx) => seedWorld(ctx));

    const result = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId, userId: 'system',
    });

    expect(result.action).toBe('ASSIGNED_DRIVER');
    const load = await t.run((ctx) => ctx.db.get(loadId));
    expect(load?.primaryDriverId).toBe(driverId);
    expect(load?.status).toBe('Assigned');
  });

  it('declines a load flagged autoAssignOptOut, leaving it Open', async () => {
    const t = convexTest(schema);
    const { loadId } = await t.run((ctx) => seedWorld(ctx, { optOut: true }));

    const result = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId, userId: 'system',
    });

    expect(result.action).toBe('OPTED_OUT');
    const load = await t.run((ctx) => ctx.db.get(loadId));
    expect(load?.primaryDriverId).toBeUndefined();
    expect(load?.status).toBe('Open');
  });

  it('the sweep query does not even return an opted-out load', async () => {
    const t = convexTest(schema);
    await t.run((ctx) => seedWorld(ctx, { optOut: true }));

    const pending = await t.query(internal.autoAssignment.getOpenLoadsWithHcr, {
      workosOrgId: ORG,
    });

    expect(pending).toHaveLength(0);
  });

  it('unassignResource sets the flag, so the next sweep is a no-op', async () => {
    const t = convexTest(schema);
    const { loadId, driverId } = await t.run((ctx) => seedWorld(ctx));
    const asUser = t.withIdentity({ subject: USER, org_id: ORG });

    // Auto-assign, then a dispatcher pulls the driver off.
    await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId, userId: 'system' });
    await asUser.mutation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import('./_generated/api')).api.dispatchLegs.unassignResource as any,
      { loadId, userId: USER, workosOrgId: ORG },
    );

    const afterUnassign = await t.run((ctx) => ctx.db.get(loadId));
    expect(afterUnassign?.status).toBe('Open');
    expect(afterUnassign?.autoAssignOptOut).toBe(true);

    // The sweep must leave it alone — this is the regression.
    const result = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId, userId: 'system',
    });

    expect(result.action).toBe('OPTED_OUT');
    const load = await t.run((ctx) => ctx.db.get(loadId));
    expect(load?.status).toBe('Open');
    expect(load?.primaryDriverId).toBeUndefined();
    expect(load?.primaryDriverId).not.toBe(driverId);
  });

  it('setAutoAssignOptOut(false) makes the load eligible again', async () => {
    const t = convexTest(schema);
    const { loadId, driverId } = await t.run((ctx) => seedWorld(ctx, { optOut: true }));
    const asUser = t.withIdentity({ subject: USER, org_id: ORG });

    const { api } = await import('./_generated/api');
    await asUser.mutation(api.loads.setAutoAssignOptOut, { loadId, optOut: false });

    const result = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId, userId: 'system',
    });

    expect(result.action).toBe('ASSIGNED_DRIVER');
    const load = await t.run((ctx) => ctx.db.get(loadId));
    expect(load?.primaryDriverId).toBe(driverId);
  });
});
