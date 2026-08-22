/**
 * Open TMS loads on the mobile board.
 *
 * The board read two sources — brokered carrier assignments and dispatch
 * legs. A `status: 'Open'` load has neither: no assignment because nobody
 * brokered it, no leg because creating one is what dispatching *is*. So the
 * entire population this app exists to assign was invisible, and the horizon
 * tiles reported zero while the backlog sat in the TMS.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';

const WORKOS_ORG = 'org_workos_openbacklog';

const DISPATCHER_PERMS = [
  ...permissionsForLevel('loads', 'manage'),
  ...permissionsForLevel('fleet', 'view'),
];
const staff = {
  subject: 's_ob',
  org_id: WORKOS_ORG,
  role: 'dispatcher',
  permissions: DISPATCHER_PERMS,
};

const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().split('T')[0];

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();

  await ctx.db.insert('organizations', {
    name: 'Open Backlog Carrier',
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

  const customerId = await ctx.db.insert('customers', {
    name: 'USPS',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1',
    city: 'C',
    state: 'S',
    zip: 'Z',
    country: 'US',
    workosOrgId: WORKOS_ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });

  const mkOpenLoad = async (internalId: string, firstStopDate: string, startMs: number) => {
    const loadId = await ctx.db.insert('loadInformation', {
      internalId,
      orderNumber: internalId,
      status: 'Open',
      trackingStatus: 'Pending',
      customerId,
      customerName: 'USPS',
      firstStopDate,
      fleet: 'Main',
      units: 'Pallets',
      workosOrgId: WORKOS_ORG,
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
      city: 'Moreno',
      state: 'CA',
      latitude: 33.9425,
      longitude: -117.2297,
      windowBeginTime: new Date(startMs).toISOString(),
      windowEndTime: new Date(startMs + 3600_000).toISOString(),
      workosOrgId: WORKOS_ORG,
      createdAt: now,
      updatedAt: now,
    });
    // A real load has somewhere to go, and the leg model requires both
    // endpoints — assignDriverInternal refuses a single-stop load.
    await ctx.db.insert('loadStops', {
      loadId,
      internalId,
      sequenceNumber: 2,
      stopType: 'DELIVERY',
      loadingType: 'APPT',
      address: '2 Dock St',
      city: 'Riverside',
      state: 'CA',
      latitude: 33.9806,
      longitude: -117.3755,
      windowBeginTime: new Date(startMs + 3 * 3600_000).toISOString(),
      windowEndTime: new Date(startMs + 4 * 3600_000).toISOString(),
      workosOrgId: WORKOS_ORG,
      createdAt: now,
      updatedAt: now,
    });
    return loadId;
  };

  // In the window: one soon, one a few days out.
  const soon = await mkOpenLoad('L-OPEN-SOON', day(0), now + 2 * 3600_000);
  const later = await mkOpenLoad('L-OPEN-LATER', day(3), now + 3 * 86_400_000);
  // Beyond the 14-day window — the board is bounded on purpose.
  await mkOpenLoad('L-OPEN-FAR', day(40), now + 40 * 86_400_000);

  // Open by status, but already dispatched via a leg: must not double up.
  const dispatched = await mkOpenLoad('L-OPEN-LEGGED', day(1), now + 86_400_000);
  const dispatchedStops = await ctx.db
    .query('loadStops')
    .withIndex('by_load', (q) => q.eq('loadId', dispatched))
    .collect();
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Manlio',
    lastName: 'D',
    email: 'm@t.co',
    phone: '+15550000001',
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
  await ctx.db.insert('dispatchLegs', {
    loadId: dispatched,
    driverId,
    sequence: 1,
    startStopId: dispatchedStops[0]._id,
    endStopId: dispatchedStops[1]._id,
    legLoadedMiles: 10,
    legEmptyMiles: 0,
    status: 'PENDING',
    scheduledStartMs: now + 86_400_000,
    workosOrgId: WORKOS_ORG,
    createdAt: now,
    updatedAt: now,
  });

  return { soon, later, dispatched, driverId };
}

function setup() {
  const t = convexTest(schema);
  return { t, ready: t.run(insertFixtures) };
}

const board = (t: ReturnType<typeof convexTest>) =>
  t.withIdentity(staff as never).query(api.dispatchMobile.listActiveAssignments, {});

describe('open TMS loads reach the board', () => {
  it('surfaces open loads that have no assignment and no leg', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await board(t);

    const ids = rows.map((r) => r.load?.internalId);
    expect(ids).toContain('L-OPEN-SOON');
    expect(ids).toContain('L-OPEN-LATER');
  });

  it('marks them unassigned, which is what puts them in the tiles', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await board(t);

    const soon = rows.find((r) => r.load?.internalId === 'L-OPEN-SOON')!;
    expect(soon.source).toBe('open');
    expect(soon.status).toBe('AWARDED');
    expect(soon.driver).toBeNull();
  });

  it('does not show a load twice when a leg already dispatched it', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await board(t);

    const legged = rows.filter((r) => r.load?.internalId === 'L-OPEN-LEGGED');
    expect(legged).toHaveLength(1);
    // It came from the leg, so it has its driver — not the open backlog.
    expect(legged[0].source).toBe('leg');
    expect(legged[0].driver).not.toBeNull();
  });

  it('stays bounded — far-future work is out of the window by design', async () => {
    const { t, ready } = setup();
    await ready;
    const rows = await board(t);

    // The design's premise: a phone never shows "all unassigned".
    expect(rows.map((r) => r.load?.internalId)).not.toContain('L-OPEN-FAR');
  });

  it('carries the loadId the assign sheet needs to commit', async () => {
    const { t, ready } = setup();
    const { soon } = await ready;
    const rows = await board(t);

    const row = rows.find((r) => r.load?.internalId === 'L-OPEN-SOON')!;
    // Open loads assign through assignDriverToLoadsWeb, which is keyed by
    // loadId — there is no carrier assignment to key on.
    expect((row as { loadId?: string }).loadId).toBe(soon);
  });
});

describe('open loads count toward the backlog', () => {
  it('boardCapacity counts them, so the success card cannot claim an empty backlog', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await t
      .withIdentity(staff as never)
      .query(api.dispatchMobile.boardCapacity, {});

    // Two open loads in-window and unlegged.
    expect(res.unassignedCount).toBe(2);
  });
});

describe('suggestDriversForOpenLoad', () => {
  it('ranks candidates for a load with no carrier assignment', async () => {
    const { t, ready } = setup();
    const { soon } = await ready;
    const ranked = await t
      .withIdentity(staff as never)
      .query(api.dispatchMobile.suggestDriversForOpenLoad, { loadId: soon });

    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]).toHaveProperty('hosLabel');
  });

  it('refuses a load outside the caller’s org', async () => {
    const { t, ready } = setup();
    const { soon } = await ready;
    await expect(
      t
        .withIdentity({ ...staff, org_id: 'org_someone_else' } as never)
        .query(api.dispatchMobile.suggestDriversForOpenLoad, { loadId: soon }),
    ).rejects.toThrow();
  });
});

describe('open loads reach the planner', () => {
  it('chains into runs and gets truck suggestions, not just board rows', async () => {
    const { t, ready } = setup();
    await ready;
    const res = await t
      .withIdentity(staff as never)
      .query(api.dispatchMobile.boardCapacity, {});

    // Previously the planner read only carrier assignments, so an all-open
    // backlog produced zero runs and every truck suggestion was empty.
    expect(res.runs.length).toBeGreaterThan(0);
    const loadIds = res.runs.flatMap((r) => r.loadIds);
    expect(loadIds.length).toBeGreaterThan(0);
    expect(res.runs.every((r) => r.assignmentIds.length === 0)).toBe(true);
  });

  it('suggestPlan proposes them with a loadId to commit against', async () => {
    const { t, ready } = setup();
    await ready;
    const plan = await t.withIdentity(staff as never).query(api.dispatchMobile.suggestPlan, {});

    const all = plan.runs.flatMap((r) => r.loads);
    expect(all.length).toBeGreaterThan(0);
    for (const l of all) {
      // Open work carries loadId and no assignmentId — the commit path
      // differs, so the reference has to say which it is.
      expect(l.ref.kind).toBe('load');
      expect(l.loadId).not.toBeNull();
      expect(l.assignmentId).toBeNull();
    }
  });

  it('applyPlan commits an open load by creating its leg', async () => {
    const { t, ready } = setup();
    const { soon, driverId } = await ready;

    const res = await t
      .withIdentity(staff as never)
      .mutation(api.dispatchMobile.applyPlan, {
        picks: [{ driverId, assignmentIds: [], loadIds: [soon] }],
      });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].success).toBe(true);
    expect(res.results[0].loadId).toBe(soon);

    // A leg is what dispatching means — and the board must now show it as
    // dispatched rather than still open.
    const legs = await t.run(async (ctx) =>
      ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', soon))
        .collect(),
    );
    expect(legs.length).toBeGreaterThan(0);
    expect(legs[0].driverId).toBe(driverId);
  });
});

describe('the planner refuses past-due work', () => {
  it('leaves a closed pickup window out of the runs', async () => {
    const { t, ready } = setup();
    await ready;
    // Push one open load's window into the past.
    await t.run(async (ctx) => {
      const load = await ctx.db
        .query('loadInformation')
        .withIndex('by_org_status_first_stop', (q) =>
          q.eq('workosOrgId', WORKOS_ORG).eq('status', 'Open'),
        )
        .collect()
        .then((ls) => ls.find((l) => l.internalId === 'L-OPEN-SOON')!);
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      const past = Date.now() - 6 * 3600_000;
      await ctx.db.patch(stops[0]._id, {
        windowBeginTime: new Date(past).toISOString(),
        windowEndTime: new Date(past + 3600_000).toISOString(),
      });
    });

    const res = await t
      .withIdentity(staff as never)
      .query(api.dispatchMobile.boardCapacity, {});

    // The board drops past-due entirely, so proposing a truck take it would
    // contradict the screen it's rendered on.
    const proposed = res.runs.flatMap((r) => r.loadIds);
    const stillOffered = res.openTrucks.flatMap((tr) => tr.suggestions.flatMap((sg) => sg.loadIds));
    expect(res.unassignedCount).toBe(1);
    expect(proposed).toHaveLength(1);
    expect(stillOffered.every((id) => proposed.includes(id))).toBe(true);
  });
});
