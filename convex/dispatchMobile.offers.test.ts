/**
 * Tests for the Dispatch-app offer inbox (Phase 3 accept/decline):
 * dispatchMobile.listOffers / acceptOffer / declineOffer.
 *
 * Coverage:
 *   - listOffers: OFFERED + ACCEPTED for the caller's org only, newest
 *     first, load+stops enrichment; capability enforced (MEMBER fails).
 *   - acceptOffer / declineOffer: happy path transitions with PARITY
 *     against the legacy loadCarrierAssignments mutations (same fixture,
 *     both paths run, resulting docs compared field-for-field).
 *   - declineOffer raises exactly one open OFFER_DECLINED alert.
 *   - Fail-closed: unauthenticated, cross-org OWNER, wrong status,
 *     staff without loads:edit (billing preset).
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { permissionsForLevel } from '../lib/team-rbac';

const CARRIER_EXT_ORG = 'org_clerk_carrier_off';
const CARRIER_WORKOS_ORG = 'org_workos_carrier_off';
const OTHER_EXT_ORG = 'org_clerk_carrier_off2';
const BROKER_ORG = 'org_workos_broker_off';
const OWNER_CLERK_ID = 'user_offers_owner';
const OTHER_OWNER_CLERK_ID = 'user_offers_other_owner';
const MEMBER_CLERK_ID = 'user_offers_member';

const BILLING_PERMS = [
  ...permissionsForLevel('loads', 'view'),
  ...permissionsForLevel('accounting', 'manage'),
];

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
    name: 'Offers Carrier LLC',
    clerkOrgId: CARRIER_EXT_ORG,
    workosOrgId: CARRIER_WORKOS_ORG,
    orgType: 'CARRIER',
    ...orgBoilerplate,
  });
  const otherOrgDocId = await ctx.db.insert('organizations', {
    name: 'Other Carrier LLC',
    clerkOrgId: OTHER_EXT_ORG,
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
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: OTHER_OWNER_CLERK_ID,
    organizationId: otherOrgDocId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });

  const customerId = await ctx.db.insert('customers', {
    name: 'Offer Shipper',
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

  const mkLoad = async (internalId: string) =>
    ctx.db.insert('loadInformation', {
      internalId,
      orderNumber: `ORD-${internalId}`,
      status: 'Assigned',
      trackingStatus: 'Pending',
      customerId,
      customerName: 'Offer Shipper',
      fleet: 'Main',
      units: 'Pallets',
      workosOrgId: BROKER_ORG,
      createdBy: 'user_test',
      createdAt: now,
      updatedAt: now,
    });

  const mkOffer = async (opts: {
    internalId: string;
    status: 'OFFERED' | 'ACCEPTED' | 'AWARDED';
    carrierOrgId?: string;
    offeredAt?: number;
  }) => {
    const loadId = await mkLoad(opts.internalId);
    const assignmentId = await ctx.db.insert('loadCarrierAssignments', {
      loadId,
      brokerOrgId: BROKER_ORG,
      carrierOrgId: opts.carrierOrgId ?? CARRIER_EXT_ORG,
      status: opts.status,
      offeredAt: opts.offeredAt ?? now,
      createdBy: 'user_test_broker',
    });
    await ctx.db.insert('loadStops', {
      loadId,
      internalId: opts.internalId,
      workosOrgId: BROKER_ORG,
      sequenceNumber: 1,
      stopType: 'PICKUP',
      loadingType: 'APPT',
      address: '100 Dock Rd, Oakland, CA',
      windowBeginTime: new Date(now + 3600_000).toISOString(),
      windowEndTime: new Date(now + 2 * 3600_000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });
    return { loadId, assignmentId };
  };

  // Own org: newer OFFERED, older OFFERED, one ACCEPTED. Other org: one
  // OFFERED that must never surface. Plus a legacy-parity twin pair.
  const offerNew = await mkOffer({ internalId: 'OFF-2', status: 'OFFERED', offeredAt: now });
  const offerOld = await mkOffer({ internalId: 'OFF-1', status: 'OFFERED', offeredAt: now - 60_000 });
  const accepted = await mkOffer({ internalId: 'OFF-A', status: 'ACCEPTED', offeredAt: now - 120_000 });
  const foreign = await mkOffer({ internalId: 'OFF-X', status: 'OFFERED', carrierOrgId: OTHER_EXT_ORG });
  const twinA = await mkOffer({ internalId: 'TWIN-A', status: 'OFFERED', offeredAt: now - 5_000 });
  const twinB = await mkOffer({ internalId: 'TWIN-B', status: 'OFFERED', offeredAt: now - 5_000 });
  return { offerNew, offerOld, accepted, foreign, twinA, twinB };
}

function setup() {
  const t = convexTest(schema);
  const fixtures = t.run(insertFixtures);
  return { t, fixtures };
}

const stripIds = (doc: Record<string, unknown>) => {
  const { _id, _creationTime, loadId, acceptedAt, ...rest } = doc;
  return { ...rest, hasAcceptedAt: acceptedAt !== undefined };
};

describe('listOffers', () => {
  it('returns own-org OFFERED + ACCEPTED newest-first with load and stops, never foreign offers', async () => {
    const { t, fixtures } = setup();
    await fixtures;
    const rows = await t
      .withIdentity({ subject: OWNER_CLERK_ID })
      .query(api.dispatchMobile.listOffers, {});
    const ids = rows.map((r) => r.load?.internalId);
    expect(ids).toEqual(['OFF-2', 'TWIN-A', 'TWIN-B', 'OFF-1', 'OFF-A']);
    expect(ids).not.toContain('OFF-X');
    expect(rows[0].status).toBe('OFFERED');
    expect(rows[4].status).toBe('ACCEPTED');
    expect(rows[0].load?.customerName).toBe('Offer Shipper');
    expect(rows[0].stops).toHaveLength(1);
    expect(rows[0].stops[0].stopType).toBe('PICKUP');
  });

  it('MEMBER link fails closed (no canViewOperations)', async () => {
    const { t, fixtures } = setup();
    await fixtures;
    await expect(
      t.withIdentity({ subject: MEMBER_CLERK_ID }).query(api.dispatchMobile.listOffers, {}),
    ).rejects.toThrow('Not authorized');
  });

  it('unauthenticated fails closed', async () => {
    const { t, fixtures } = setup();
    await fixtures;
    await expect(t.query(api.dispatchMobile.listOffers, {})).rejects.toThrow('Unauthenticated');
  });
});

describe('acceptOffer', () => {
  it('OWNER accepts: OFFERED → ACCEPTED with acceptedAt, field-for-field parity with the legacy mutation', async () => {
    const { t, fixtures } = setup();
    const { twinA, twinB } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    await owner.mutation(api.dispatchMobile.acceptOffer, { assignmentId: twinA.assignmentId });
    await owner.mutation(api.loadCarrierAssignments.acceptOffer, {
      assignmentId: twinB.assignmentId,
      carrierOrgId: CARRIER_EXT_ORG,
    });

    const [docA, docB] = await t.run(async (ctx) => [
      await ctx.db.get(twinA.assignmentId),
      await ctx.db.get(twinB.assignmentId),
    ]);
    expect(docA?.status).toBe('ACCEPTED');
    expect(docA?.acceptedAt).toBeGreaterThan(0);
    expect(stripIds(docA as never)).toEqual(stripIds(docB as never));
  });

  it('rejects wrong status, cross-org owner, staff without loads:edit, unauthenticated', async () => {
    const { t, fixtures } = setup();
    const { accepted, offerNew } = await fixtures;

    await expect(
      t
        .withIdentity({ subject: OWNER_CLERK_ID })
        .mutation(api.dispatchMobile.acceptOffer, { assignmentId: accepted.assignmentId }),
    ).rejects.toThrow('Cannot accept assignment with status: ACCEPTED');

    await expect(
      t
        .withIdentity({ subject: OTHER_OWNER_CLERK_ID })
        .mutation(api.dispatchMobile.acceptOffer, { assignmentId: offerNew.assignmentId }),
    ).rejects.toThrow('Offer not found');

    await expect(
      t
        .withIdentity({
          subject: 'staff_billing',
          org_id: CARRIER_WORKOS_ORG,
          role: 'member',
          permissions: BILLING_PERMS,
        } as never)
        .mutation(api.dispatchMobile.acceptOffer, { assignmentId: offerNew.assignmentId }),
    ).rejects.toThrow('Not authorized');

    await expect(
      t.mutation(api.dispatchMobile.acceptOffer, { assignmentId: offerNew.assignmentId }),
    ).rejects.toThrow('Unauthenticated');
  });

  it('staff admin (org claim) can accept for the org', async () => {
    const { t, fixtures } = setup();
    const { offerNew } = await fixtures;
    const res = await t
      .withIdentity({ subject: 'staff_admin', org_id: CARRIER_WORKOS_ORG, role: 'admin' } as never)
      .mutation(api.dispatchMobile.acceptOffer, { assignmentId: offerNew.assignmentId });
    expect(res).toEqual({ success: true });
    const doc = await t.run((ctx) => ctx.db.get(offerNew.assignmentId));
    expect(doc?.status).toBe('ACCEPTED');
  });
});

describe('declineOffer', () => {
  it('OWNER declines: OFFERED → DECLINED, parity with legacy, one open OFFER_DECLINED alert each', async () => {
    const { t, fixtures } = setup();
    const { twinA, twinB } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    await owner.mutation(api.dispatchMobile.declineOffer, { assignmentId: twinA.assignmentId });
    await owner.mutation(api.loadCarrierAssignments.declineOffer, {
      assignmentId: twinB.assignmentId,
      carrierOrgId: CARRIER_EXT_ORG,
    });

    const [docA, docB, alertsA] = await t.run(async (ctx) => [
      await ctx.db.get(twinA.assignmentId),
      await ctx.db.get(twinB.assignmentId),
      await ctx.db
        .query('dispatchAlerts')
        .withIndex('by_dedupe', (q) =>
          q.eq('assignmentId', twinA.assignmentId).eq('kind', 'OFFER_DECLINED').eq('status', 'open'),
        )
        .collect(),
    ]);
    expect(docA?.status).toBe('DECLINED');
    expect(stripIds(docA as never)).toEqual(stripIds(docB as never));
    expect(alertsA).toHaveLength(1);
    expect(alertsA[0].severity).toBe('med');

    // Declined offers leave the inbox entirely.
    const rows = await owner.query(api.dispatchMobile.listOffers, {});
    expect(rows.map((r) => r.load?.internalId)).not.toContain('TWIN-A');
  });

  it('cannot decline twice (status guard)', async () => {
    const { t, fixtures } = setup();
    const { offerNew } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });
    await owner.mutation(api.dispatchMobile.declineOffer, { assignmentId: offerNew.assignmentId });
    await expect(
      owner.mutation(api.dispatchMobile.declineOffer, { assignmentId: offerNew.assignmentId }),
    ).rejects.toThrow('Cannot decline assignment with status: DECLINED');
  });
});
