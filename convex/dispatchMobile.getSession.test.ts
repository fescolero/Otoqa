/**
 * Tests for the Dispatch-app session bootstrap (dispatchMobile.getSession)
 * and the dual-path capability guard (lib/auth.requireCapability) —
 * split-plan §3.3/§4.2/§4.3, decision D9.
 *
 * Capability truth table under test:
 *   staff admin        → everything (isPermitted admin bypass)
 *   staff dispatcher   → canDispatch only (loads:edit; fleet view-only;
 *                        accounting none per the D9 preset)
 *   staff billing      → canViewSettlements (accounting:*), no dispatch
 *   staff legacy token → everything (grandfather rule — no permissions
 *                        claim at all; §4.6 verification exists to retire
 *                        these before launch)
 *   Clerk OWNER/ADMIN  → everything ("Owner-operator" persona), resolved
 *                        by clerkUserId or phone fallback
 *   Clerk MEMBER/none  → authenticated but no org, all capabilities false
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import { requireCapability } from './lib/auth';
import { permissionsForLevel } from '../lib/team-rbac';
import type { MutationCtx } from './_generated/server';

const CARRIER_CLERK_ORG = 'org_clerk_carrier_A';
const CARRIER_WORKOS_ORG = 'org_workos_carrier_A';
const OWNER_CLERK_ID = 'user_owner_A';
const ADMIN_PHONE = '+15305550188';
const MEMBER_CLERK_ID = 'user_member_A';

// Claim sets matching the D9 presets (cumulative slugs, as WorkOS stores them).
const DISPATCHER_PERMS = [
  ...permissionsForLevel('loads', 'manage'),
  ...permissionsForLevel('fleet', 'view'),
  ...permissionsForLevel('partners', 'edit'),
  ...permissionsForLevel('fuel', 'view'),
  ...permissionsForLevel('reports', 'view'),
];
const BILLING_PERMS = [
  ...permissionsForLevel('loads', 'view'),
  ...permissionsForLevel('fleet', 'view'),
  ...permissionsForLevel('partners', 'edit'),
  ...permissionsForLevel('accounting', 'manage'),
  ...permissionsForLevel('fuel', 'edit'),
  ...permissionsForLevel('reports', 'manage'),
];

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Carrier A LLC',
    clerkOrgId: CARRIER_CLERK_ORG,
    workosOrgId: CARRIER_WORKOS_ORG,
    orgType: 'BROKER_CARRIER',
    billingEmail: 'billing@a.test',
    billingAddress: {
      addressLine1: '1 A St',
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
  });
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: OWNER_CLERK_ID,
    organizationId: orgId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: 'user_admin_A_stale',
    phone: ADMIN_PHONE,
    organizationId: orgId,
    role: 'ADMIN',
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: MEMBER_CLERK_ID,
    organizationId: orgId,
    role: 'MEMBER',
    createdAt: now,
    updatedAt: now,
  });
  return orgId;
}

function setup() {
  const t = convexTest(schema);
  const ready = t.run(insertFixtures);
  return { t, ready };
}

describe('getSession — WorkOS staff', () => {
  it('admin role: all capabilities via the admin bypass, org metadata resolved', async () => {
    const { t, ready } = setup();
    const orgConvexId = await ready;
    const s = await t
      .withIdentity({ subject: 'staff_admin', org_id: CARRIER_WORKOS_ORG, role: 'admin' } as never)
      .query(api.dispatchMobile.getSession, {});
    expect(s).toMatchObject({
      authenticated: true,
      provider: 'workos',
      persona: 'staff',
      orgExternalId: CARRIER_WORKOS_ORG,
      orgConvexId,
      orgName: 'Carrier A LLC',
      capabilities: { canDispatch: true, canViewSettlements: true, canManageDrivers: true },
    });
  });

  it('dispatcher preset: dispatch yes, settlements NO, driver management NO (D9)', async () => {
    const { t, ready } = setup();
    await ready;
    const s = await t
      .withIdentity({
        subject: 'staff_dispatcher',
        org_id: CARRIER_WORKOS_ORG,
        role: 'dispatcher',
        permissions: DISPATCHER_PERMS,
      } as never)
      .query(api.dispatchMobile.getSession, {});
    expect(s.capabilities).toEqual({
      canDispatch: true,
      canViewSettlements: false,
      canManageDrivers: false,
    });
  });

  it('billing preset: settlements yes, dispatch no', async () => {
    const { t, ready } = setup();
    await ready;
    const s = await t
      .withIdentity({
        subject: 'staff_billing',
        org_id: CARRIER_WORKOS_ORG,
        role: 'billing',
        permissions: BILLING_PERMS,
      } as never)
      .query(api.dispatchMobile.getSession, {});
    expect(s.capabilities).toEqual({
      canDispatch: false,
      canViewSettlements: true,
      canManageDrivers: false,
    });
  });

  it('legacy token with no permissions claim: grandfathered to everything (documented §4.6 risk)', async () => {
    const { t, ready } = setup();
    await ready;
    const s = await t
      .withIdentity({ subject: 'staff_legacy', org_id: CARRIER_WORKOS_ORG } as never)
      .query(api.dispatchMobile.getSession, {});
    expect(s.capabilities).toEqual({
      canDispatch: true,
      canViewSettlements: true,
      canManageDrivers: true,
    });
  });
});

describe('getSession — Clerk owner-operators', () => {
  it('OWNER by clerkUserId: owner_operator persona, everything on', async () => {
    const { t, ready } = setup();
    const orgConvexId = await ready;
    const s = await t
      .withIdentity({ subject: OWNER_CLERK_ID })
      .query(api.dispatchMobile.getSession, {});
    expect(s).toMatchObject({
      authenticated: true,
      provider: 'clerk',
      persona: 'owner_operator',
      orgExternalId: CARRIER_CLERK_ORG,
      orgConvexId,
      capabilities: { canDispatch: true, canViewSettlements: true, canManageDrivers: true },
    });
  });

  it('ADMIN via phone fallback (stale clerkUserId): everything on', async () => {
    const { t, ready } = setup();
    await ready;
    const s = await t
      .withIdentity({ subject: 'user_admin_A_fresh', phone_number: '530-555-0188' } as never)
      .query(api.dispatchMobile.getSession, {});
    expect(s.persona).toBe('owner_operator');
    expect(s.capabilities.canViewSettlements).toBe(true);
  });

  it('MEMBER link: authenticated but no org and no capabilities', async () => {
    const { t, ready } = setup();
    await ready;
    const s = await t
      .withIdentity({ subject: MEMBER_CLERK_ID })
      .query(api.dispatchMobile.getSession, {});
    expect(s).toMatchObject({
      authenticated: true,
      provider: 'clerk',
      persona: null,
      orgExternalId: null,
      capabilities: { canDispatch: false, canViewSettlements: false, canManageDrivers: false },
    });
  });

  it('unauthenticated: authenticated=false', async () => {
    const { t, ready } = setup();
    await ready;
    const s = await t.query(api.dispatchMobile.getSession, {});
    expect(s.authenticated).toBe(false);
  });
});

describe('requireCapability — enforcement guard', () => {
  it('staff dispatcher: canDispatch passes, canViewSettlements throws loud', async () => {
    const { t, ready } = setup();
    await ready;
    const dispatcher = t.withIdentity({
      subject: 'staff_dispatcher',
      org_id: CARRIER_WORKOS_ORG,
      role: 'dispatcher',
      permissions: DISPATCHER_PERMS,
    } as never);

    await expect(
      dispatcher.run((ctx) => requireCapability(ctx, CARRIER_WORKOS_ORG, 'canDispatch')),
    ).resolves.toMatchObject({ userId: 'staff_dispatcher' });
    await expect(
      dispatcher.run((ctx) => requireCapability(ctx, CARRIER_WORKOS_ORG, 'canViewSettlements')),
    ).rejects.toThrow("Your role doesn't have the accounting:view permission");
  });

  it("staff cannot act on another org even with the right permission", async () => {
    const { t, ready } = setup();
    await ready;
    await expect(
      t
        .withIdentity({ subject: 'staff_admin', org_id: 'org_workos_other', role: 'admin' } as never)
        .run((ctx) => requireCapability(ctx, CARRIER_WORKOS_ORG, 'canDispatch')),
    ).rejects.toThrow('Not authorized for this organization');
  });

  it('Clerk OWNER: all three capabilities pass against clerkOrgId', async () => {
    const { t, ready } = setup();
    await ready;
    const owner = t.withIdentity({ subject: OWNER_CLERK_ID });
    for (const cap of ['canDispatch', 'canViewSettlements', 'canManageDrivers'] as const) {
      await expect(
        owner.run((ctx) => requireCapability(ctx, CARRIER_CLERK_ORG, cap)),
      ).resolves.toMatchObject({ userId: OWNER_CLERK_ID });
    }
  });

  it('Clerk MEMBER and unauthenticated both fail loud', async () => {
    const { t, ready } = setup();
    await ready;
    await expect(
      t
        .withIdentity({ subject: MEMBER_CLERK_ID })
        .run((ctx) => requireCapability(ctx, CARRIER_CLERK_ORG, 'canDispatch')),
    ).rejects.toThrow('Not authorized: missing canDispatch');
    await expect(
      t.run((ctx) => requireCapability(ctx, CARRIER_CLERK_ORG, 'canDispatch')),
    ).rejects.toThrow('Unauthenticated');
  });
});
