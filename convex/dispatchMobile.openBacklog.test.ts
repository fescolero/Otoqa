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
      windowBeginTime: new Date(startMs).toISOString(),
      windowEndTime: new Date(startMs + 3600_000).toISOString(),
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
  const stop = (
    await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', dispatched))
      .collect()
  )[0];
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
    startStopId: stop._id,
    endStopId: stop._id,
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
