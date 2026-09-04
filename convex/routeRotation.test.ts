import { convexTest } from 'convex-test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import { serviceDateOf } from './lib/assignHorizon';

/**
 * Re-sync: editing a rule releases the upcoming loads it auto-assigned
 * that no longer match it, and auto-assignment places them again — and
 * nothing else.
 *
 * The contract, load by load:
 *   - auto-assigned, upcoming, not started, no longer matching → released, re-placed
 *   - hand-assigned by a dispatcher (no provenance) → untouched
 *   - a leg already ACTIVE → held, IN_MOTION
 *   - pickup date in the past → held, PAST
 *   - unassigned by a dispatcher → provenance cleared, so not even a candidate
 *   - released but refused by the assignment decision (overlap, no rule) → left Open, reported
 */

const ORG = 'org_rotation';
const USER = 'user_rotation';
const HCR = '917DK';
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(n: number): string {
  return serviceDateOf(Date.now() + n * DAY_MS);
}

// Schema-typed test instance. `ReturnType<typeof convexTest>` alone loses
// the schema generic, and with it every table index in `t.run` callbacks.
const setup = () => convexTest(schema);
type T = ReturnType<typeof setup>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedOrg(ctx: any) {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'C', companyType: 'Shipper', status: 'Active',
    addressLine1: '1 St', city: 'Town', state: 'CA', zip: '00000', country: 'USA',
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  const mkDriver = (first: string, phone: string) =>
    ctx.db.insert('drivers', {
      firstName: first, lastName: 'Rae', email: `${first.toLowerCase()}@t.co`, phone,
      licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
      hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
  const driverA: Id<'drivers'> = await mkDriver('Dana', '+15550000001');
  const driverB: Id<'drivers'> = await mkDriver('Sam', '+15550000002');
  const routeId: Id<'routeAssignments'> = await ctx.db.insert('routeAssignments', {
    workosOrgId: ORG, hcr: HCR, driverId: driverA, priority: 1, isActive: true,
    name: 'Dana 917DK', createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('autoAssignmentSettings', {
    workosOrgId: ORG, enabled: true, triggerOnCreate: true,
    scheduledEnabled: true, scheduleIntervalMinutes: 60,
    updatedBy: USER, updatedAt: now,
  });
  return { customerId, driverA, driverB, routeId };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedLoad(
  ctx: any,
  customerId: Id<'customers'>,
  tag: string,
  serviceDate: string,
  hcr: string = HCR,
) {
  const now = Date.now();
  const loadId: Id<'loadInformation'> = await ctx.db.insert('loadInformation', {
    internalId: `LD-${tag}`, orderNumber: `ORD-${tag}`, status: 'Open',
    trackingStatus: 'Pending', customerId, fleet: 'Default', units: 'Pallets',
    firstStopDate: serviceDate,
    workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
  await ctx.db.insert('loadTags', {
    workosOrgId: ORG, loadId, facetKey: 'HCR', value: hcr, canonicalValue: hcr,
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

type World = Awaited<ReturnType<typeof buildWorld>>;

/** A rule on Dana with a spread of loads in every state the rotation
 *  must distinguish. */
async function buildWorld(t: T) {
  const seeded = await t.run(async (ctx) => {
    const org = await seedOrg(ctx);
    return {
      ...org,
      // Distinct days so Dana (and later Sam) never overlaps herself.
      robotNear: await seedLoad(ctx, org.customerId, 'R1', daysFromNow(2)),
      robotFar: await seedLoad(ctx, org.customerId, 'R2', daysFromNow(9)),
      human: await seedLoad(ctx, org.customerId, 'H', daysFromNow(4)),
      active: await seedLoad(ctx, org.customerId, 'A', daysFromNow(6)),
      past: await seedLoad(ctx, org.customerId, 'P', daysFromNow(-1)),
    };
  });
  const asUser = t.withIdentity({ subject: USER, org_id: ORG });

  // The robot places four of them.
  for (const loadId of [seeded.robotNear, seeded.robotFar, seeded.active, seeded.past]) {
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId, userId: 'system' });
    expect(r.action).toBe('ASSIGNED_DRIVER');
  }
  // A dispatcher places one by hand — on the same driver, which is the
  // case provenance exists to tell apart.
  const manual = await asUser.mutation(api.dispatchLegs.assignDriver, {
    loadId: seeded.human, driverId: seeded.driverA, userId: USER, workosOrgId: ORG,
  });
  expect(manual.status).toBe('SUCCESS');
  // One of the robot's loads has started.
  await t.run(async (ctx) => {
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', seeded.active))
      .collect();
    for (const leg of legs) await ctx.db.patch(leg._id, { status: 'ACTIVE' });
  });

  return { ...seeded, asUser };
}

async function loadState(t: T, id: Id<'loadInformation'>) {
  const load = await t.run((ctx) => ctx.db.get(id));
  return {
    driver: load?.primaryDriverId,
    route: load?.autoAssignedRouteId,
    status: load?.status,
  };
}

describe('provenance', () => {
  it('is stamped by auto-assignment and absent on a hand assignment', async () => {
    const t = setup();
    const w = await buildWorld(t);
    expect((await loadState(t, w.robotNear)).route).toBe(w.routeId);
    expect((await loadState(t, w.human)).route).toBeUndefined();
  });

  it('is cleared when a dispatcher reassigns or unassigns', async () => {
    const t = setup();
    const w = await buildWorld(t);

    await w.asUser.mutation(api.dispatchLegs.assignDriver, {
      loadId: w.robotNear, driverId: w.driverB, userId: USER, workosOrgId: ORG,
    });
    expect((await loadState(t, w.robotNear)).route).toBeUndefined();

    await w.asUser.mutation(api.dispatchLegs.unassignResource, {
      loadId: w.robotFar, userId: USER, workosOrgId: ORG,
    });
    const far = await loadState(t, w.robotFar);
    expect(far.status).toBe('Open');
    expect(far.route).toBeUndefined();
  });
});

describe('rotation on rule edit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const drain = (t: T) =>
    t.finishAllScheduledFunctions(vi.runAllTimers);

  async function rotateTo(t: T, w: World, driverId: Id<'drivers'>) {
    await w.asUser.mutation(api.routeAssignments.update, {
      id: w.routeId, driverId, reassignFutureLoads: true,
    });
    await drain(t);
  }

  it('previews the exact set before saving', async () => {
    const t = setup();
    const w = await buildWorld(t);

    const preview = await w.asUser.query(api.routeAssignments.previewRotation, {
      id: w.routeId, driverId: w.driverB,
    });
    expect(preview.eligible).toBe(2); // robotNear, robotFar
    expect(preview.held).toBe(2); // active, past — the hand-placed load is not in the set at all
    expect(Object.fromEntries(preview.byReason.map((r) => [r.reason, r.count]))).toEqual({
      IN_MOTION: 1,
      PAST: 1,
    });
  });

  it('moves the robot\'s upcoming loads to the new driver and nothing else', async () => {
    const t = setup();
    const w = await buildWorld(t);

    await rotateTo(t, w, w.driverB);

    // Moved, and still the rule's.
    for (const id of [w.robotNear, w.robotFar]) {
      const s = await loadState(t, id);
      expect(s.driver).toBe(w.driverB);
      expect(s.route).toBe(w.routeId);
      expect(s.status).toBe('Assigned');
    }
    // The dispatcher's load stays on Dana.
    expect((await loadState(t, w.human)).driver).toBe(w.driverA);
    // In motion and in the past stay on Dana too.
    expect((await loadState(t, w.active)).driver).toBe(w.driverA);
    expect((await loadState(t, w.past)).driver).toBe(w.driverA);

    // The legs followed the load.
    const legs = await t.run((ctx) =>
      ctx.db.query('dispatchLegs').withIndex('by_load', (q) => q.eq('loadId', w.robotNear)).collect());
    expect(legs.every((l) => l.driverId === w.driverB)).toBe(true);

    // And the outcome is on the rule for the UI.
    const rule = await t.run((ctx) => ctx.db.get(w.routeId));
    expect(rule?.lastRotation?.moved).toBe(2);
    expect(rule?.lastRotation?.held).toBe(2);
    expect(rule?.lastRotation?.considered).toBe(4);
  });

  it('does nothing unless asked', async () => {
    const t = setup();
    const w = await buildWorld(t);

    await w.asUser.mutation(api.routeAssignments.update, { id: w.routeId, driverId: w.driverB });
    await drain(t);

    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverA);
    const rule = await t.run((ctx) => ctx.db.get(w.routeId));
    expect(rule?.lastRotation).toBeUndefined();
  });

  it('a load the new driver is already booked across is released and left Open, with why', async () => {
    const t = setup();
    const w = await buildWorld(t);

    // Sam already has a hand-assigned load on robotNear's day.
    const clash = await t.run((ctx) => seedLoad(ctx, w.customerId, 'CLASH', daysFromNow(2)));
    await w.asUser.mutation(api.dispatchLegs.assignDriver, {
      loadId: clash, driverId: w.driverB, userId: USER, workosOrgId: ORG,
    });

    await rotateTo(t, w, w.driverB);

    // Released off Dana, refused for Sam: Open, in front of a dispatcher,
    // and NOT opted out — the sweep keeps trying.
    const near = await loadState(t, w.robotNear);
    expect(near.status).toBe('Open');
    expect(near.driver).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(w.robotNear)))?.autoAssignOptOut).toBeUndefined();
    expect((await loadState(t, w.robotFar)).driver).toBe(w.driverB); // re-placed
    expect((await loadState(t, clash)).driver).toBe(w.driverB); // untouched

    const rule = await t.run((ctx) => ctx.db.get(w.routeId));
    expect(rule?.lastRotation?.byReason).toContainEqual({ reason: 'OVERLAP_CONFLICT', count: 1 });
    const held = rule?.lastRotation?.heldLoads?.find((h) => h.reason === 'OVERLAP_CONFLICT');
    expect(held?.orderNumber).toBe('ORD-R1');
    expect(held?.detail).toMatch(/Sam Rae is already booked/);

    // Once the blocker is gone, the ordinary sweep places it.
    await w.asUser.mutation(api.dispatchLegs.unassignResource, {
      loadId: clash, userId: USER, workosOrgId: ORG,
    });
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: w.robotNear, userId: 'system' });
    expect(r.action).toBe('ASSIGNED_DRIVER');
    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverB);
  });

  it('re-sync moves whatever the rule owns that is not on its current driver', async () => {
    const t = setup();
    const w = await buildWorld(t);

    // Rule was edited earlier WITHOUT a rotation.
    await w.asUser.mutation(api.routeAssignments.update, { id: w.routeId, driverId: w.driverB });
    await drain(t);
    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverA);

    await w.asUser.mutation(api.routeAssignments.rotateLoads, { id: w.routeId });
    await drain(t);

    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverB);
    expect((await loadState(t, w.robotFar)).driver).toBe(w.driverB);
    expect((await loadState(t, w.human)).driver).toBe(w.driverA);

    // Running it again is a no-op: everything is already on target.
    await w.asUser.mutation(api.routeAssignments.rotateLoads, { id: w.routeId });
    await drain(t);
    const rule = await t.run((ctx) => ctx.db.get(w.routeId));
    expect(rule?.lastRotation?.moved).toBe(0);
    expect(rule?.lastRotation?.byReason).toContainEqual({ reason: 'IN_SYNC', count: 2 });
  });

  it('a rotated load is not the sweep\'s to undo', async () => {
    const t = setup();
    const w = await buildWorld(t);
    await rotateTo(t, w, w.driverB);

    // The sweep sees an Assigned load and leaves it.
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, {
      loadId: w.robotNear, userId: 'system',
    });
    expect(r.action).toBe('ALREADY_ASSIGNED');
    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverB);
  });

  it('re-sync all walks every active rule and records one org summary', async () => {
    const t = setup();
    const w = await buildWorld(t);

    // A second rule on another HCR, also on Dana, with one robot load.
    const { rule2, load2 } = await t.run(async (ctx) => {
      const now = Date.now();
      const rule2: Id<'routeAssignments'> = await ctx.db.insert('routeAssignments', {
        workosOrgId: ORG, hcr: '96036', driverId: w.driverA, priority: 1, isActive: true,
        name: 'Dana 96036', createdBy: USER, createdAt: now, updatedAt: now,
      });
      const load2 = await seedLoad(ctx, w.customerId, 'R3', daysFromNow(12));
      // seedLoad tags HCR 917DK; re-point this one at the second rule's HCR.
      const tag = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', load2))
        .first();
      if (tag) await ctx.db.patch(tag._id, { value: '96036', canonicalValue: '96036' });
      return { rule2, load2 };
    });
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: load2, userId: 'system' });
    expect(r.action).toBe('ASSIGNED_DRIVER');
    expect((await loadState(t, load2)).route).toBe(rule2);

    // Both rules rotated to Sam without moving loads.
    await w.asUser.mutation(api.routeAssignments.update, { id: w.routeId, driverId: w.driverB });
    await w.asUser.mutation(api.routeAssignments.update, { id: rule2, driverId: w.driverB });
    await drain(t);

    const before = await w.asUser.query(api.routeAssignments.previewOrgRotation, { workosOrgId: ORG });
    expect(before.outOfSync).toBe(3); // robotNear, robotFar, load2
    expect(before.rules).toBe(2);
    expect(before.blocked).toBe(2); // active (IN_MOTION), past (PAST)

    await w.asUser.mutation(api.routeAssignments.rotateAllLoads, { workosOrgId: ORG });
    await drain(t);

    for (const id of [w.robotNear, w.robotFar, load2]) {
      expect((await loadState(t, id)).driver).toBe(w.driverB);
    }
    expect((await loadState(t, w.human)).driver).toBe(w.driverA);

    const after = await w.asUser.query(api.routeAssignments.previewOrgRotation, { workosOrgId: ORG });
    expect(after.outOfSync).toBe(0);

    const settings = await w.asUser.query(api.routeAssignments.getSettings, { workosOrgId: ORG });
    expect(settings?.lastBulkRotation?.rules).toBe(2);
    expect(settings?.lastBulkRotation?.moved).toBe(3);
    expect(settings?.lastBulkRotation?.held).toBe(2);
    // And each rule still has its own breakdown.
    const rule = await t.run((ctx) => ctx.db.get(w.routeId));
    expect(rule?.lastRotation?.moved).toBe(2);
  });

  it('re-sync all resolves two rules trading drivers, without swapping anything', async () => {
    const t = setup();
    const w = await buildWorld(t);

    // A second rule on another HCR, on Sam, with a load on the SAME day
    // and window as robotNear (which is on Dana). Then the rules trade
    // drivers. Moved one at a time each load would be blocked by the
    // other; released first, then re-placed, neither is.
    const { rule2, load2 } = await t.run(async (ctx) => {
      const now = Date.now();
      const rule2: Id<'routeAssignments'> = await ctx.db.insert('routeAssignments', {
        workosOrgId: ORG, hcr: '96036', driverId: w.driverB, priority: 1, isActive: true,
        name: 'Sam 96036', createdBy: USER, createdAt: now, updatedAt: now,
      });
      const load2 = await seedLoad(ctx, w.customerId, 'X', daysFromNow(2), '96036');
      return { rule2, load2 };
    });
    expect((await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: load2, userId: 'system' })).action)
      .toBe('ASSIGNED_DRIVER');

    await w.asUser.mutation(api.routeAssignments.update, { id: w.routeId, driverId: w.driverB });
    await w.asUser.mutation(api.routeAssignments.update, { id: rule2, driverId: w.driverA });
    await drain(t);

    await w.asUser.mutation(api.routeAssignments.rotateAllLoads, { workosOrgId: ORG });
    await drain(t);

    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverB);
    expect((await loadState(t, load2)).driver).toBe(w.driverA);
    expect((await loadState(t, w.robotFar)).driver).toBe(w.driverB);

    const settings = await w.asUser.query(api.routeAssignments.getSettings, { workosOrgId: ORG });
    expect(settings?.lastBulkRotation?.moved).toBe(3);
    expect(settings?.lastBulkRotation?.byReason.find((r) => r.reason === 'OVERLAP_CONFLICT')).toBeUndefined();
  });

  it('a day change hands the load to whichever rule now covers that day', async () => {
    const t = setup();
    const w = await buildWorld(t);
    const nearDow = new Date(`${daysFromNow(2)}T00:00:00.000Z`).getUTCDay();
    const otherDays = [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== nearDow);

    // Dana's rule stops covering robotNear's weekday; Sam's new rule
    // covers exactly that weekday on the same HCR.
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert('routeAssignments', {
        workosOrgId: ORG, hcr: HCR, driverId: w.driverB, priority: 1, isActive: true,
        activeDays: [nearDow], name: 'Sam covers that day', createdBy: USER, createdAt: now, updatedAt: now,
      });
    });
    await w.asUser.mutation(api.routeAssignments.update, {
      id: w.routeId, activeDays: otherDays, reassignFutureLoads: true,
    });
    await drain(t);

    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverB);
    // robotFar's weekday may or may not be in otherDays; either way it is
    // on a driver whose rule covers it.
    const far = await t.run((ctx) => ctx.db.get(w.robotFar));
    expect(far?.status).toBe('Assigned');
  });

  it('a load no rule claims after the change is released and left Open, not opted out', async () => {
    const t = setup();
    const w = await buildWorld(t);
    // Pause the only rule and re-sync: its loads are released; nothing
    // takes them; they wait Open for a dispatcher or a new rule.
    await w.asUser.mutation(api.routeAssignments.update, { id: w.routeId, isActive: false, reassignFutureLoads: true });
    await drain(t);

    for (const id of [w.robotNear, w.robotFar]) {
      const load = await t.run((ctx) => ctx.db.get(id));
      expect(load?.status).toBe('Open');
      expect(load?.autoAssignOptOut).toBeUndefined();
    }
    expect((await loadState(t, w.human)).driver).toBe(w.driverA);
    const rule = await t.run((ctx) => ctx.db.get(w.routeId));
    expect(rule?.lastRotation?.byReason).toContainEqual({ reason: 'NO_MATCH', count: 2 });
  });

  it('deleting a rule releases the upcoming loads it placed, and another rule can take them', async () => {
    const t = setup();
    const w = await buildWorld(t);

    await w.asUser.mutation(api.routeAssignments.remove, { id: w.routeId });
    await drain(t);

    // Upcoming, not-started loads are Open again, without the opt-out flag;
    // the started one and the past one stay where they were.
    for (const id of [w.robotNear, w.robotFar]) {
      const load = await t.run((ctx) => ctx.db.get(id));
      expect(load?.status).toBe('Open');
      expect(load?.autoAssignedRouteId).toBeUndefined();
      expect(load?.autoAssignOptOut).toBeUndefined();
    }
    expect((await loadState(t, w.active)).driver).toBe(w.driverA);
    expect((await loadState(t, w.past)).driver).toBe(w.driverA);
    expect((await loadState(t, w.human)).driver).toBe(w.driverA);

    // A rule for Sam on the same HCR now claims them on the next sweep.
    const rule2 = await t.run((ctx) =>
      ctx.db.insert('routeAssignments', {
        workosOrgId: ORG, hcr: HCR, driverId: w.driverB, priority: 1, isActive: true,
        name: 'Sam 917DK', createdBy: USER, createdAt: Date.now(), updatedAt: Date.now(),
      }));
    const r = await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: w.robotNear, userId: 'system' });
    expect(r.action).toBe('ASSIGNED_DRIVER');
    expect((await loadState(t, w.robotNear))).toMatchObject({ driver: w.driverB, route: rule2 });
  });

  it('re-sync all clears a pre-provenance robot load no rule claims, unblocking the driver', async () => {
    const t = setup();
    const w = await buildWorld(t);
    // A load the sweep placed on Sam on robotNear's day, with its
    // provenance stripped (assigned before provenance existed), whose
    // rule then stopped covering that day. Dana's rule → Sam: robotNear
    // would be blocked by it.
    const { legacy } = await t.run(async (ctx) => {
      const now = Date.now();
      const legacyRule: Id<'routeAssignments'> = await ctx.db.insert('routeAssignments', {
        workosOrgId: ORG, hcr: '96036', driverId: w.driverB, priority: 1, isActive: true,
        name: 'Sam 96036', createdBy: USER, createdAt: now, updatedAt: now,
      });
      const legacy = await seedLoad(ctx, w.customerId, 'LEGACY', daysFromNow(2), '96036');
      return { legacy, legacyRule };
    });
    expect((await t.mutation(internal.autoAssignment.autoAssignLoad, { loadId: legacy, userId: 'system' })).action)
      .toBe('ASSIGNED_DRIVER');
    const nearDow = new Date(`${daysFromNow(2)}T00:00:00.000Z`).getUTCDay();
    await t.run(async (ctx) => {
      await ctx.db.patch(legacy, { autoAssignedRouteId: undefined, autoAssignedAt: undefined });
      const rule = (await ctx.db.query('routeAssignments').withIndex('by_org_hcr', (q) => q.eq('workosOrgId', ORG).eq('hcr', '96036')).first())!;
      await ctx.db.patch(rule._id, { activeDays: [0, 1, 2, 3, 4, 5, 6].filter((d) => d !== nearDow) });
    });
    await w.asUser.mutation(api.routeAssignments.update, { id: w.routeId, driverId: w.driverB });
    await drain(t);

    await w.asUser.mutation(api.routeAssignments.rotateAllLoads, { workosOrgId: ORG });
    await drain(t);

    const leg = await t.run((ctx) => ctx.db.get(legacy));
    expect(leg?.status).toBe('Open');
    expect(leg?.autoAssignOptOut).toBeUndefined();
    expect((await loadState(t, w.robotNear)).driver).toBe(w.driverB);
    const settings = await w.asUser.query(api.routeAssignments.getSettings, { workosOrgId: ORG });
    expect(settings?.lastBulkRotation?.byReason).toContainEqual({ reason: 'UNCLAIMED_RELEASED', count: 1 });
  });

  it('an overlap names the rule that placed the other load, or says none did', async () => {
    const t = setup();
    const w = await buildWorld(t);
    const clash = await t.run((ctx) => seedLoad(ctx, w.customerId, 'CLASH', daysFromNow(2)));
    await w.asUser.mutation(api.dispatchLegs.assignDriver, {
      loadId: clash, driverId: w.driverB, userId: USER, workosOrgId: ORG,
    });
    await rotateTo(t, w, w.driverB);
    const rule = await t.run((ctx) => ctx.db.get(w.routeId));
    const held = rule?.lastRotation?.heldLoads?.find((h) => h.reason === 'OVERLAP_CONFLICT');
    expect(held?.detail).toMatch(/Load #ORD-CLASH — not placed by a rule/);
  });
});
