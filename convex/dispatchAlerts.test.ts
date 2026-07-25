/**
 * Alerts engine tests (split-plan §5.2): detection, dedupe (one open alert
 * per {assignment, kind} across cron ticks), auto-resolve when the
 * condition clears, event kinds from the guarded mutations, and the
 * capability-gated feed.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api, internal } from './_generated/api';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

const CLERK_ORG = 'org_clerk_alerts_A';
const WORKOS_ORG = 'org_workos_alerts_A';
const OWNER = 'user_alerts_owner';
const DISPATCHER = {
  subject: 'al_dispatcher',
  org_id: WORKOS_ORG,
  role: 'dispatcher',
  permissions: [...permissionsForLevel('loads', 'manage'), ...permissionsForLevel('fleet', 'view')],
};

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Alerts Carrier',
    clerkOrgId: CLERK_ORG,
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
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: OWNER,
    organizationId: orgId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });
  const driverId = await ctx.db.insert('drivers', {
    firstName: 'Rosa',
    lastName: 'Medina',
    email: 'r@t.co',
    phone: '+15550009900',
    licenseState: 'CA',
    licenseExpiration: '2030-01-01',
    licenseClass: 'A',
    hireDate: '2024-01-01',
    employmentStatus: 'Active',
    employmentType: 'Full-time',
    organizationId: orgId,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const customerId = await ctx.db.insert('customers', {
    name: 'Cust',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1',
    city: 'C',
    state: 'S',
    zip: 'Z',
    country: 'US',
    workosOrgId: 'org_broker_Y',
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'L-7001',
    orderNumber: 'O-7001',
    status: 'Assigned',
    trackingStatus: 'In Transit',
    customerId,
    fleet: 'Main',
    units: 'Pallets',
    workosOrgId: 'org_broker_Y',
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });
  const assignmentId = await ctx.db.insert('loadCarrierAssignments', {
    loadId,
    brokerOrgId: 'org_broker_Y',
    carrierOrgId: CLERK_ORG,
    status: 'IN_PROGRESS',
    assignedDriverId: driverId,
    offeredAt: now,
    createdBy: 'u',
  });
  // Stale ping: 31 minutes old → TRACKING_LOST condition.
  await ctx.db.insert('driverLocations', {
    driverId,
    organizationId: WORKOS_ORG,
    latitude: 37.5,
    longitude: -121.9,
    trackingType: 'LOAD_ROUTE',
    recordedAt: now - 31 * 60 * 1000,
    createdAt: now,
  });
  return { orgId, driverId, loadId, assignmentId };
}

function setup() {
  const t = convexTest(schema);
  const ready = t.run(insertFixtures);
  return { t, ready };
}

const openAlerts = (t: ReturnType<typeof convexTest>) =>
  t.run(async (ctx) =>
    (await ctx.db.query('dispatchAlerts').collect()).filter((a) => a.status === 'open'),
  );

describe('sweep detection', () => {
  it('raises TRACKING_LOST once (dedupe across ticks), then auto-resolves on a fresh ping', async () => {
    const { t, ready } = setup();
    const { driverId } = await ready;

    await t.mutation(internal.dispatchAlerts.sweep, {});
    await t.mutation(internal.dispatchAlerts.sweep, {});
    let open = await openAlerts(t);
    expect(open.filter((a) => a.kind === 'TRACKING_LOST')).toHaveLength(1);
    expect(open[0].detail).toContain('Rosa Medina');

    // Fresh ping → next sweep resolves it.
    await t.run(async (ctx) => {
      await ctx.db.insert('driverLocations', {
        driverId,
        organizationId: WORKOS_ORG,
        latitude: 37.5,
        longitude: -121.9,
        trackingType: 'LOAD_ROUTE',
        recordedAt: Date.now(),
        createdAt: Date.now(),
      });
    });
    await t.mutation(internal.dispatchAlerts.sweep, {});
    open = await openAlerts(t);
    expect(open.filter((a) => a.kind === 'TRACKING_LOST')).toHaveLength(0);
  });

  it('raises MISSED_APPOINTMENT for an expired window, resolves after check-in', async () => {
    const { t, ready } = setup();
    const { loadId, driverId } = await ready;
    const stopId = await t.run(async (ctx) => {
      // Keep tracking healthy so only the appointment fires.
      await ctx.db.insert('driverLocations', {
        driverId,
        organizationId: WORKOS_ORG,
        latitude: 37.5,
        longitude: -121.9,
        trackingType: 'LOAD_ROUTE',
        recordedAt: Date.now(),
        createdAt: Date.now(),
      });
      return await ctx.db.insert('loadStops', {
        loadId,
        internalId: 'L-7001',
        sequenceNumber: 1,
        stopType: 'PICKUP',
        loadingType: 'APPT',
        address: '9 Dock Rd',
        windowEndTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        workosOrgId: 'org_broker_Y',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await t.mutation(internal.dispatchAlerts.sweep, {});
    let open = await openAlerts(t);
    const appt = open.filter((a) => a.kind === 'MISSED_APPOINTMENT');
    expect(appt).toHaveLength(1);
    expect(appt[0].severity).toBe('high');

    await t.run((ctx) => ctx.db.patch(stopId, { checkedInAt: new Date().toISOString() }));
    await t.mutation(internal.dispatchAlerts.sweep, {});
    open = await openAlerts(t);
    expect(open.filter((a) => a.kind === 'MISSED_APPOINTMENT')).toHaveLength(0);
  });

  it('raises POD_MISSING for a recent completion without a POD', async () => {
    const { t, ready } = setup();
    const { assignmentId } = await ready;
    await t.run((ctx) =>
      ctx.db.patch(assignmentId, { status: 'COMPLETED', completedAt: Date.now() - 1000 }),
    );
    await t.mutation(internal.dispatchAlerts.sweep, { segment: 'COMPLETED' });
    const open = await openAlerts(t);
    const pod = open.filter((a) => a.kind === 'POD_MISSING');
    expect(pod).toHaveLength(1);
    expect(pod[0].detail).toContain('L-7001');
  });
});

describe('event kinds + feed', () => {
  it('declineOffer raises OFFER_DECLINED', async () => {
    const { t, ready } = setup();
    const { assignmentId } = await ready;
    await t.run((ctx) =>
      ctx.db.patch(assignmentId, { status: 'OFFERED', assignedDriverId: undefined }),
    );
    await t.withIdentity({ subject: OWNER }).mutation(api.loadCarrierAssignments.declineOffer, {
      assignmentId,
      carrierOrgId: CLERK_ORG,
    });
    const open = await openAlerts(t);
    expect(open.map((a) => a.kind)).toEqual(['OFFER_DECLINED']);
  });

  it('listAlerts is gated and enriched; dismissAlert closes and requires canDispatch', async () => {
    const { t, ready } = setup();
    await ready;
    await t.mutation(internal.dispatchAlerts.sweep, {});

    await expect(t.query(api.dispatchAlerts.listAlerts, {})).rejects.toThrow('Unauthenticated');

    const feed = await t
      .withIdentity(DISPATCHER as never)
      .query(api.dispatchAlerts.listAlerts, {});
    expect(feed).toHaveLength(1);
    expect(feed[0].driver?.firstName).toBe('Rosa');
    expect(feed[0].loadInternalId).toBe('L-7001');

    await t
      .withIdentity({ subject: OWNER })
      .mutation(api.dispatchAlerts.dismissAlert, { alertId: feed[0]._id as Id<'dispatchAlerts'> });
    const after = await t
      .withIdentity(DISPATCHER as never)
      .query(api.dispatchAlerts.listAlerts, {});
    expect(after).toHaveLength(0);
  });
});

describe('push pipeline (§5.7)', () => {
  it('registerPushToken upserts by token and re-homes to the caller', async () => {
    const { t, ready } = setup();
    await ready;
    const owner = t.withIdentity({ subject: OWNER });
    await owner.mutation(api.dispatchMobile.registerPushToken, {
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
    await owner.mutation(api.dispatchMobile.registerPushToken, {
      token: 'ExponentPushToken[abc]',
      platform: 'ios',
    });
    const staff = t.withIdentity(DISPATCHER as never);
    await staff.mutation(api.dispatchMobile.registerPushToken, {
      token: 'ExponentPushToken[abc]',
      platform: 'android',
    });
    const rows = await t.run((ctx) => ctx.db.query('dispatchPushTokens').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].userKey).toBe('al_dispatcher');
    expect(rows[0].platform).toBe('android');
  });

  it('pruneToken removes a dead device; unauthenticated registration fails loud', async () => {
    const { t, ready } = setup();
    await ready;
    await t.withIdentity({ subject: OWNER }).mutation(api.dispatchMobile.registerPushToken, {
      token: 'ExponentPushToken[dead]',
      platform: 'ios',
    });
    await t.mutation(internal.push.pruneToken, { token: 'ExponentPushToken[dead]' });
    expect(await t.run((ctx) => ctx.db.query('dispatchPushTokens').collect())).toHaveLength(0);
    await expect(
      t.mutation(api.dispatchMobile.registerPushToken, { token: 'x', platform: 'ios' }),
    ).rejects.toThrow('Unauthenticated');
  });
});

describe('appointment window adjustment (§5.4)', () => {
  it('re-times a stop, resolves the open missed-appointment alert, and audits', async () => {
    const { t, ready } = setup();
    const { loadId, driverId } = await ready;
    const stopId = await t.run(async (ctx) => {
      await ctx.db.insert('driverLocations', {
        driverId,
        organizationId: WORKOS_ORG,
        latitude: 37.5,
        longitude: -121.9,
        trackingType: 'LOAD_ROUTE',
        recordedAt: Date.now(),
        createdAt: Date.now(),
      });
      return await ctx.db.insert('loadStops', {
        loadId,
        internalId: 'L-7001',
        sequenceNumber: 1,
        stopType: 'PICKUP',
        loadingType: 'APPT',
        address: '9 Dock Rd',
        windowEndTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        workosOrgId: 'org_broker_Y',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await t.mutation(internal.dispatchAlerts.sweep, {});
    expect((await openAlerts(t)).map((a) => a.kind)).toContain('MISSED_APPOINTMENT');

    const newEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const res = await t
      .withIdentity(DISPATCHER as never)
      .mutation(api.dispatchMobile.adjustStopWindow, { stopId, windowEndTime: newEnd });
    expect(res.success).toBe(true);

    expect((await openAlerts(t)).map((a) => a.kind)).not.toContain('MISSED_APPOINTMENT');
    const stop = await t.run((ctx) => ctx.db.get(stopId));
    expect(stop?.windowEndTime).toBe(newEnd);
    const audits = await t.run((ctx) => ctx.db.query('auditLog').collect());
    expect(audits.some((a) => a.action === 'window_adjusted')).toBe(true);
  });

  it('warns on knock-on overlap, validates ordering, denies billing role', async () => {
    const { t, ready } = setup();
    const { loadId } = await ready;
    const mk = (seq: number, beginOffsetH: number) =>
      t.run((ctx) =>
        ctx.db.insert('loadStops', {
          loadId,
          internalId: 'L-7001',
          sequenceNumber: seq,
          stopType: seq === 1 ? 'PICKUP' : 'DELIVERY',
          loadingType: 'APPT',
          address: `${seq} Dock Rd`,
          windowBeginTime: new Date(Date.now() + beginOffsetH * 3600_000).toISOString(),
          windowEndTime: new Date(Date.now() + (beginOffsetH + 1) * 3600_000).toISOString(),
          workosOrgId: 'org_broker_Y',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    const s1 = await mk(1, 1);
    await mk(2, 2);

    // Push stop 1's end past stop 2's begin → knock-on warning.
    const res = await t.withIdentity({ subject: OWNER }).mutation(api.dispatchMobile.adjustStopWindow, {
      stopId: s1,
      windowEndTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
    });
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('2 Dock Rd');

    await expect(
      t.withIdentity({ subject: OWNER }).mutation(api.dispatchMobile.adjustStopWindow, {
        stopId: s1,
        windowBeginTime: new Date(Date.now() + 5 * 3600_000).toISOString(),
        windowEndTime: new Date(Date.now() + 4 * 3600_000).toISOString(),
      }),
    ).rejects.toThrow('Window must end after it begins');

    await expect(
      t
        .withIdentity({ subject: 'al_billing', org_id: WORKOS_ORG, role: 'billing', permissions: [
          ...permissionsForLevel('loads', 'view'),
          ...permissionsForLevel('accounting', 'manage'),
        ] } as never)
        .mutation(api.dispatchMobile.adjustStopWindow, {
          stopId: s1,
          windowEndTime: new Date(Date.now() + 3 * 3600_000).toISOString(),
        }),
    ).rejects.toThrow('Not authorized: missing canDispatch');
  });
});
