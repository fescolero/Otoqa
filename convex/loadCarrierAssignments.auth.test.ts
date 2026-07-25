/**
 * Authorization tests for the carrier-side assignment mutations
 * (split-plan §0 security hotfix): acceptOffer, declineOffer,
 * assignDriver, startLoad, completeLoad.
 *
 * These were unauthenticated public mutations — the only "check" was
 * comparing a client-supplied carrierOrgId string. The hotfix adds
 * assertCallerInCarrierOrg, which must:
 *   - fail closed for unauthenticated and unrelated callers,
 *   - accept org-claim tokens (WorkOS web/staff) for the carrier org,
 *   - accept Clerk mobile owner-mode callers via userIdentityLinks by
 *     clerkUserId AND via the phone fallback, for roles OWNER and ADMIN
 *     (exact parity with carrierMobile.getUserRoles — old field builds
 *     must keep working),
 *   - reject MEMBER links, other orgs, and soft-deleted orgs,
 *   - leave the existing status-transition rules untouched.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const CARRIER_EXT_ORG = 'org_clerk_carrier_1';
const OTHER_EXT_ORG = 'org_clerk_carrier_2';
const BROKER_ORG = 'org_workos_broker_1';

const OWNER_CLERK_ID = 'user_clerk_owner';
const ADMIN_PHONE = '+17605550123';
const MEMBER_CLERK_ID = 'user_clerk_member';

type Fixtures = {
  assignmentId: Id<'loadCarrierAssignments'>;
  loadId: Id<'loadInformation'>;
};

async function insertFixtures(
  ctx: MutationCtx,
  opts: { status?: 'OFFERED' | 'AWARDED' | 'IN_PROGRESS'; deletedOrg?: boolean } = {},
): Promise<Fixtures> {
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
    name: 'Test Carrier LLC',
    clerkOrgId: CARRIER_EXT_ORG,
    orgType: 'CARRIER',
    ...orgBoilerplate,
    ...(opts.deletedOrg ? { isDeleted: true, deletionReason: 'test' } : {}),
  });
  const otherOrgDocId = await ctx.db.insert('organizations', {
    name: 'Other Carrier LLC',
    clerkOrgId: OTHER_EXT_ORG,
    orgType: 'CARRIER',
    ...orgBoilerplate,
  });

  // OWNER linked by Clerk user id (getUserRoles Method 1).
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: OWNER_CLERK_ID,
    organizationId: carrierOrgDocId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });
  // ADMIN linked by phone only — subject won't match (Method 2 fallback).
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: 'user_clerk_admin_stale_id',
    phone: ADMIN_PHONE,
    organizationId: carrierOrgDocId,
    role: 'ADMIN',
    createdAt: now,
    updatedAt: now,
  });
  // MEMBER of the carrier org — must NOT unlock the mutations.
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: MEMBER_CLERK_ID,
    organizationId: carrierOrgDocId,
    role: 'MEMBER',
    createdAt: now,
    updatedAt: now,
  });
  // OWNER of a different org — must not cross org boundaries.
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: 'user_clerk_other_owner',
    organizationId: otherOrgDocId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });

  const customerId = await ctx.db.insert('customers', {
    name: 'Test Shipper',
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

  const loadId = await ctx.db.insert('loadInformation', {
    internalId: 'L-1001',
    orderNumber: 'ORD-1001',
    status: 'Assigned',
    trackingStatus: 'Pending',
    customerId,
    fleet: 'Main',
    units: 'Pallets',
    workosOrgId: BROKER_ORG,
    createdBy: 'user_test',
    createdAt: now,
    updatedAt: now,
  });

  const assignmentId = await ctx.db.insert('loadCarrierAssignments', {
    loadId,
    brokerOrgId: BROKER_ORG,
    carrierOrgId: CARRIER_EXT_ORG,
    status: opts.status ?? 'OFFERED',
    offeredAt: now,
    createdBy: 'user_test_broker',
  });

  return { assignmentId, loadId };
}

function setup(opts?: Parameters<typeof insertFixtures>[1]) {
  const t = convexTest(schema);
  const fixtures = t.run((ctx) => insertFixtures(ctx, opts));
  return { t, fixtures };
}

describe('assignment mutations fail closed', () => {
  it('rejects unauthenticated callers on every mutation', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;

    await expect(
      t.mutation(api.loadCarrierAssignments.assignDriver, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
        driverName: 'Attacker',
      }),
    ).rejects.toThrow('Unauthenticated');
    await expect(
      t.mutation(api.loadCarrierAssignments.startLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Unauthenticated');
    await expect(
      t.mutation(api.loadCarrierAssignments.completeLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Unauthenticated');
    await expect(
      t.mutation(api.loadCarrierAssignments.acceptOffer, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Unauthenticated');
    await expect(
      t.mutation(api.loadCarrierAssignments.declineOffer, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Unauthenticated');
  });

  it('rejects an authenticated caller with no link to the carrier org', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;
    const stranger = t.withIdentity({ subject: 'user_unrelated' });

    await expect(
      stranger.mutation(api.loadCarrierAssignments.startLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Not authorized for this carrier');
  });

  it("rejects another org's OWNER (cross-org)", async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;
    const otherOwner = t.withIdentity({ subject: 'user_clerk_other_owner' });

    await expect(
      otherOwner.mutation(api.loadCarrierAssignments.startLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Not authorized for this carrier');
  });

  it('rejects a MEMBER-role link (parity with getUserRoles owner gate)', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;
    const member = t.withIdentity({ subject: MEMBER_CLERK_ID });

    await expect(
      member.mutation(api.loadCarrierAssignments.startLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Not authorized for this carrier');
  });

  it('rejects an OWNER of a soft-deleted org', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED', deletedOrg: true });
    const { assignmentId } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    await expect(
      owner.mutation(api.loadCarrierAssignments.startLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Not authorized for this carrier');
  });

  it('rejects a mismatched org-claim token (claim must equal the external id)', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;
    const wrongOrg = t.withIdentity({ subject: 'user_staff', org_id: OTHER_EXT_ORG });

    await expect(
      wrongOrg.mutation(api.loadCarrierAssignments.startLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Not authorized for this carrier');
  });
});

describe('legitimate callers keep working (old-build parity)', () => {
  it('Clerk OWNER via by_clerk link: assignDriver succeeds without an org claim', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    const res = await owner.mutation(api.loadCarrierAssignments.assignDriver, {
      assignmentId,
      carrierOrgId: CARRIER_EXT_ORG,
      driverName: 'Jane Driver',
    });
    expect(res).toEqual({ success: true });

    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(assignment?.assignedDriverName).toBe('Jane Driver');
  });

  it('Clerk ADMIN via phone fallback: startLoad succeeds (stale clerkUserId, phone claim matches)', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId, loadId } = await fixtures;
    // Subject does NOT match any link; the token carries the verified phone.
    const admin = t.withIdentity({
      subject: 'user_clerk_admin_fresh_id',
      phone_number: '(760) 555-0123',
    } as never);

    const res = await admin.mutation(api.loadCarrierAssignments.startLoad, {
      assignmentId,
      carrierOrgId: CARRIER_EXT_ORG,
    });
    expect(res).toEqual({ success: true });

    const [assignment, load] = await t.run((ctx) =>
      Promise.all([ctx.db.get(assignmentId), ctx.db.get(loadId)]),
    );
    expect(assignment?.status).toBe('IN_PROGRESS');
    expect(load?.trackingStatus).toBe('In Transit');
  });

  it('WorkOS org-claim caller: acceptOffer succeeds', async () => {
    const { t, fixtures } = setup({ status: 'OFFERED' });
    const { assignmentId } = await fixtures;
    const staff = t.withIdentity({ subject: 'user_staff', org_id: CARRIER_EXT_ORG });

    const res = await staff.mutation(api.loadCarrierAssignments.acceptOffer, {
      assignmentId,
      carrierOrgId: CARRIER_EXT_ORG,
    });
    expect(res).toEqual({ success: true });

    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(assignment?.status).toBe('ACCEPTED');
  });

  it('declineOffer succeeds for the carrier OWNER', async () => {
    const { t, fixtures } = setup({ status: 'OFFERED' });
    const { assignmentId } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    const res = await owner.mutation(api.loadCarrierAssignments.declineOffer, {
      assignmentId,
      carrierOrgId: CARRIER_EXT_ORG,
    });
    expect(res).toEqual({ success: true });

    const assignment = await t.run((ctx) => ctx.db.get(assignmentId));
    expect(assignment?.status).toBe('DECLINED');
  });

  it('completeLoad succeeds for the carrier OWNER and cascades load status', async () => {
    const { t, fixtures } = setup({ status: 'IN_PROGRESS' });
    const { assignmentId, loadId } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    const res = await owner.mutation(api.loadCarrierAssignments.completeLoad, {
      assignmentId,
      carrierOrgId: CARRIER_EXT_ORG,
    });
    expect(res).toEqual({ success: true });

    const [assignment, load] = await t.run((ctx) =>
      Promise.all([ctx.db.get(assignmentId), ctx.db.get(loadId)]),
    );
    expect(assignment?.status).toBe('COMPLETED');
    expect(assignment?.paymentStatus).toBe('PENDING');
    expect(load?.status).toBe('Completed');
  });
});

describe('behavior parity — existing rules unchanged', () => {
  it('carrierOrgId arg mismatch still throws the original error before any auth lookup', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    await expect(
      owner.mutation(api.loadCarrierAssignments.startLoad, {
        assignmentId,
        carrierOrgId: OTHER_EXT_ORG,
      }),
    ).rejects.toThrow('Assignment does not belong to this carrier');
  });

  it('status-transition rules still enforced for an authorized caller', async () => {
    const { t, fixtures } = setup({ status: 'AWARDED' });
    const { assignmentId } = await fixtures;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });

    await expect(
      owner.mutation(api.loadCarrierAssignments.acceptOffer, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Cannot accept assignment with status: AWARDED');
    await expect(
      owner.mutation(api.loadCarrierAssignments.completeLoad, {
        assignmentId,
        carrierOrgId: CARRIER_EXT_ORG,
      }),
    ).rejects.toThrow('Can only complete in-progress loads');
  });
});
