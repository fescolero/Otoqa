/**
 * Tests for bundled runs + auto-plan (Phase 3, "§5.1 at scale"):
 * dispatchMobile.suggestPlan / applyPlan.
 *
 * Geometry fixture (haversine-real coordinates):
 *   Oakland  (37.80, -122.27)
 *   Sacramento (38.58, -121.49)  ~75 mi from Oakland
 *   Los Angeles (34.05, -118.24) ~360 mi from Sacramento
 *
 * Coverage:
 *   - Chaining: drop→pickup within deadhead + time feasibility bundles
 *     into one run; far deadhead starts a new run; loads already
 *     assigned to a driver are excluded from planning entirely.
 *   - Unplannable loads (missing windows) surface with a reason.
 *   - Ranking: nearest fresh-ping driver tops each run; a driver
 *     suggested for one run is excluded from later runs in the plan.
 *   - applyPlan: assigns a whole run; conflicts are skipped-and-reported
 *     (never clobbered); org/authz fail-closed.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const CARRIER_EXT_ORG = 'org_clerk_carrier_plan';
const CARRIER_WORKOS_ORG = 'org_workos_carrier_plan';
const BROKER_ORG = 'org_workos_broker_plan';
const OWNER_CLERK_ID = 'user_plan_owner';
const MEMBER_CLERK_ID = 'user_plan_member';

const OAK = { lat: 37.8, lng: -122.27 };
const SAC = { lat: 38.58, lng: -121.49 };
const LA = { lat: 34.05, lng: -118.24 };

const H = 3600_000;

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const orgBoilerplate = {
    billingEmail: 'billing@test.com',
    billingAddress: {
      addressLine1: '1 Test St',
      city: 'Oakland',
      state: 'California',
      zip: '94601',
      country: 'USA',
    },
    subscriptionPlan: 'Enterprise',
    subscriptionStatus: 'Active',
    billingCycle: 'Annual',
    createdAt: now,
    updatedAt: now,
  };
  const carrierOrgDocId = await ctx.db.insert('organizations', {
    name: 'Plan Carrier LLC',
    clerkOrgId: CARRIER_EXT_ORG,
    workosOrgId: CARRIER_WORKOS_ORG,
    orgType: 'CARRIER',
    ...orgBoilerplate,
  });
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: OWNER_CLERK_ID,
    organizationId: carrierOrgDocId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: MEMBER_CLERK_ID,
    organizationId: carrierOrgDocId,
    role: 'MEMBER',
    createdAt: now,
    updatedAt: now,
  });

  const mkDriver = async (first: string, at: { lat: number; lng: number }) => {
    const id = await ctx.db.insert('drivers', {
      firstName: first,
      lastName: 'Driver',
      email: `${first}@t.co`,
      phone: `+1555${first.length}002200`,
      licenseState: 'CA',
      licenseExpiration: '2030-01-01',
      licenseClass: 'A',
      hireDate: '2024-01-01',
      employmentStatus: 'Active',
      employmentType: 'Full-time',
      organizationId: CARRIER_WORKOS_ORG,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert('driverLocations', {
      driverId: id,
      organizationId: CARRIER_WORKOS_ORG,
      latitude: at.lat,
      longitude: at.lng,
      trackingType: 'LOAD_ROUTE',
      recordedAt: now - 60_000,
      createdAt: now,
    });
    return id;
  };
  const driverOak = await mkDriver('Oak', OAK);
  const driverLa = await mkDriver('La', LA);

  const customerId = await ctx.db.insert('customers', {
    name: 'Plan Shipper',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 Test St',
    city: 'Oakland',
    state: 'California',
    zip: '94601',
    country: 'USA',
    workosOrgId: BROKER_ORG,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });

  const mkStop = (
    loadId: Id<'loadInformation'>,
    internalId: string,
    seq: number,
    type: 'PICKUP' | 'DELIVERY',
    at: { lat: number; lng: number } | null,
    windowBegin: number | null,
    windowEnd: number | null,
  ) =>
    ctx.db.insert('loadStops', {
      loadId,
      internalId,
      workosOrgId: BROKER_ORG,
      sequenceNumber: seq,
      stopType: type,
      loadingType: 'APPT',
      address: `${seq} Dock Rd`,
      ...(at ? { latitude: at.lat, longitude: at.lng } : {}),
      ...(windowBegin != null ? { windowBeginTime: new Date(windowBegin).toISOString() } : {}),
      ...(windowEnd != null ? { windowEndTime: new Date(windowEnd).toISOString() } : {}),
      createdAt: now,
      updatedAt: now,
    });

  const mkLoad = async (opts: {
    internalId: string;
    pickup: { at: { lat: number; lng: number } | null; open: number | null; close: number | null };
    drop: { at: { lat: number; lng: number } | null; open: number | null; close: number | null };
    assignedDriverId?: Id<'drivers'>;
  }) => {
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: opts.internalId,
      orderNumber: `ORD-${opts.internalId}`,
      status: 'Assigned',
      trackingStatus: 'Pending',
      customerId,
      customerName: 'Plan Shipper',
      fleet: 'Main',
      units: 'Pallets',
      workosOrgId: BROKER_ORG,
      createdBy: 'user_test',
      createdAt: now,
      updatedAt: now,
    });
    await mkStop(loadId, opts.internalId, 1, 'PICKUP', opts.pickup.at, opts.pickup.open, opts.pickup.close);
    await mkStop(loadId, opts.internalId, 2, 'DELIVERY', opts.drop.at, opts.drop.open, opts.drop.close);
    const assignmentId = await ctx.db.insert('loadCarrierAssignments', {
      loadId,
      brokerOrgId: BROKER_ORG,
      carrierOrgId: CARRIER_EXT_ORG,
      status: 'AWARDED',
      offeredAt: now,
      createdBy: 'user_test_broker',
      ...(opts.assignedDriverId ? { assignedDriverId: opts.assignedDriverId } : {}),
    });
    return { loadId, assignmentId };
  };

  // A: Oakland pickup T+1h..T+2h → Sacramento drop closing T+5h.
  const a = await mkLoad({
    internalId: 'PLAN-A',
    pickup: { at: OAK, open: now + 1 * H, close: now + 2 * H },
    drop: { at: SAC, open: now + 4 * H, close: now + 5 * H },
  });
  // B: Sacramento pickup T+6h..T+8h — chains after A (tiny deadhead,
  // arrival ≈ T+5h50m before the T+8h close).
  const b = await mkLoad({
    internalId: 'PLAN-B',
    pickup: { at: SAC, open: now + 6 * H, close: now + 8 * H },
    drop: { at: SAC, open: now + 9 * H, close: now + 10 * H },
  });
  // C: LA pickup T+1.5h — ~360 mi from A's drop, never chains.
  const c = await mkLoad({
    internalId: 'PLAN-C',
    pickup: { at: LA, open: now + 1.5 * H, close: now + 2.5 * H },
    drop: { at: LA, open: now + 4 * H, close: now + 5 * H },
  });
  // D: no windows at all → unplannable.
  const d = await mkLoad({
    internalId: 'PLAN-D',
    pickup: { at: OAK, open: null, close: null },
    drop: { at: SAC, open: null, close: null },
  });
  // E: already has a driver → excluded from planning.
  const e = await mkLoad({
    internalId: 'PLAN-E',
    pickup: { at: OAK, open: now + 1 * H, close: now + 2 * H },
    drop: { at: SAC, open: now + 4 * H, close: now + 5 * H },
    assignedDriverId: driverOak,
  });

  return { a, b, c, d, e, driverOak, driverLa };
}

function setup() {
  const t = convexTest(schema);
  const fixtures = t.run(insertFixtures);
  return { t, fixtures };
}

describe('suggestPlan', () => {
  it('bundles feasible drop→pickup chains, splits far deadheads, excludes assigned loads, reports unplannable', async () => {
    const { t, fixtures } = setup();
    const { a, b, c, d, e } = await fixtures;
    const plan = await t
      .withIdentity({ subject: OWNER_CLERK_ID })
      .query(api.dispatchMobile.suggestPlan, {});

    expect(plan.runs).toHaveLength(2);
    const runIds = plan.runs.map((r) => r.loads.map((l) => l.load?.internalId));
    expect(runIds).toContainEqual(['PLAN-A', 'PLAN-B']);
    expect(runIds).toContainEqual(['PLAN-C']);

    const chained = plan.runs.find((r) => r.loads.length === 2)!;
    expect(chained.deadheadMiles).toHaveLength(1);
    expect(chained.deadheadMiles[0]).toBeLessThan(20); // SAC→SAC hop
    expect(chained.loads.map((l) => l.assignmentId)).toEqual([a.assignmentId, b.assignmentId]);

    expect(plan.unplannable).toEqual([
      expect.objectContaining({
        assignmentId: d.assignmentId,
        reason: 'Missing appointment windows',
      }),
    ]);
    const allPlanned = plan.runs.flatMap((r) => r.loads.map((l) => l.assignmentId));
    expect(allPlanned).not.toContain(e.assignmentId);
    void c;
  });

  it('ranks the nearest fresh driver on top of each run and never double-books a driver across runs', async () => {
    const { t, fixtures } = setup();
    const { driverOak, driverLa } = await fixtures;
    const plan = await t
      .withIdentity({ subject: OWNER_CLERK_ID })
      .query(api.dispatchMobile.suggestPlan, {});

    const oakRun = plan.runs.find((r) => r.loads[0].load?.internalId === 'PLAN-A')!;
    const laRun = plan.runs.find((r) => r.loads[0].load?.internalId === 'PLAN-C')!;
    expect(oakRun.candidates[0]._id).toBe(driverOak);
    expect(laRun.candidates[0]._id).toBe(driverLa);
    // driverOak was suggested for the Oakland run → excluded from the LA run.
    expect(laRun.candidates.map((cand) => cand._id)).not.toContain(driverOak);
  });

  it('is deterministic for a fixed data snapshot', async () => {
    const { t, fixtures } = setup();
    await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });
    const p1 = await owner.query(api.dispatchMobile.suggestPlan, {});
    const p2 = await owner.query(api.dispatchMobile.suggestPlan, {});
    expect(p2.runs.map((r) => r.loads.map((l) => l.assignmentId))).toEqual(
      p1.runs.map((r) => r.loads.map((l) => l.assignmentId)),
    );
    expect(p2.runs.map((r) => r.candidates[0]?._id)).toEqual(p1.runs.map((r) => r.candidates[0]?._id));
  });

  it('fails closed: MEMBER and unauthenticated', async () => {
    const { t, fixtures } = setup();
    await fixtures;
    await expect(
      t.withIdentity({ subject: MEMBER_CLERK_ID }).query(api.dispatchMobile.suggestPlan, {}),
    ).rejects.toThrow('Not authorized');
    await expect(t.query(api.dispatchMobile.suggestPlan, {})).rejects.toThrow('Unauthenticated');
  });
});

describe('applyPlan', () => {
  it('assigns the whole run to the picked driver with cached name/phone', async () => {
    const { t, fixtures } = setup();
    const { a, b, driverLa } = await fixtures;
    const res = await t.withIdentity({ subject: OWNER_CLERK_ID }).mutation(api.dispatchMobile.applyPlan, {
      picks: [{ driverId: driverLa, assignmentIds: [a.assignmentId, b.assignmentId] }],
    });
    expect(res.results).toEqual([
      { assignmentId: a.assignmentId, success: true },
      { assignmentId: b.assignmentId, success: true },
    ]);
    const docA = await t.run((ctx) => ctx.db.get(a.assignmentId));
    expect(docA?.assignedDriverId).toBe(driverLa);
    expect(docA?.assignedDriverName).toBe('La Driver');
    expect(docA?.assignedDriverPhone).toBeTruthy();
  });

  it('skips-and-reports a conflicting load instead of clobbering, applies the rest', async () => {
    const { t, fixtures } = setup();
    const { a, b, driverOak, driverLa } = await fixtures;
    await t.run(async (ctx) => {
      await ctx.db.patch(b.assignmentId, {
        assignedDriverId: driverOak,
        assignedDriverName: 'Oak Driver',
      });
    });
    const res = await t.withIdentity({ subject: OWNER_CLERK_ID }).mutation(api.dispatchMobile.applyPlan, {
      picks: [{ driverId: driverLa, assignmentIds: [a.assignmentId, b.assignmentId] }],
    });
    expect(res.results).toEqual([
      { assignmentId: a.assignmentId, success: true },
      { assignmentId: b.assignmentId, success: false, reason: 'Already assigned to Oak Driver' },
    ]);
    const docB = await t.run((ctx) => ctx.db.get(b.assignmentId));
    expect(docB?.assignedDriverId).toBe(driverOak);
  });

  it('fails closed: MEMBER caller and unauthenticated', async () => {
    const { t, fixtures } = setup();
    const { a, driverOak } = await fixtures;
    await expect(
      t.withIdentity({ subject: MEMBER_CLERK_ID }).mutation(api.dispatchMobile.applyPlan, {
        picks: [{ driverId: driverOak, assignmentIds: [a.assignmentId] }],
      }),
    ).rejects.toThrow('Not authorized');
    await expect(
      t.mutation(api.dispatchMobile.applyPlan, {
        picks: [{ driverId: driverOak, assignmentIds: [a.assignmentId] }],
      }),
    ).rejects.toThrow('Unauthenticated');
  });
});
