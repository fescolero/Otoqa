/**
 * Tests for featureFlags.getForOrg — split-plan §6 release N additions.
 *
 * Resolution matrix under test:
 *   WorkOS caller (org claim)      → org rows (pre-existing behavior)
 *   Clerk driver (phone → drivers) → org rows for driver.organizationId
 *                                    (pre-existing behavior, tried BEFORE
 *                                    owner resolution so no caller moves)
 *   Clerk owner, NO driver record  → org rows via OWNER identity link,
 *                                    across every org-id spelling (NEW —
 *                                    this population previously got {})
 *   Global '*' scope               → applies to everyone, org row wins (NEW)
 *   Unauthenticated / unknown      → {}
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { MutationCtx } from './_generated/server';

const WORKOS_ORG = 'org_workos_flags_A';
const CLERK_ORG = 'org_clerk_flags_A';
const OWNER_CLERK_ID = 'user_flags_owner';
const OWNER_PHONE = '+15305550142';
const DRIVER_PHONE = '+15305550143';

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Flags Carrier LLC',
    clerkOrgId: CLERK_ORG,
    workosOrgId: WORKOS_ORG,
    orgType: 'CARRIER',
    billingEmail: 'billing@flags.test',
    billingAddress: {
      addressLine1: '1 Flag St',
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
  // Owner-only user: OWNER link, deliberately NO drivers row.
  await ctx.db.insert('userIdentityLinks', {
    clerkUserId: OWNER_CLERK_ID,
    phone: OWNER_PHONE,
    organizationId: orgId,
    role: 'OWNER',
    createdAt: now,
    updatedAt: now,
  });
  // Driver keyed by the workos org id (web-created spelling).
  await ctx.db.insert('drivers', {
    firstName: 'Flag',
    lastName: 'Driver',
    email: 'flag@t.co',
    phone: DRIVER_PHONE,
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

  const mkFlag = (scope: string, key: string, value: string) =>
    ctx.db.insert('featureFlags', {
      workosOrgId: scope,
      key,
      value,
      updatedAt: now,
      updatedBy: 'test',
    });
  // Org-scoped rows under different spellings of the same org.
  await mkFlag(WORKOS_ORG, 'gps_queue_backend', 'mmkv');
  await mkFlag(CLERK_ORG, 'ar_wake_enabled', 'true');
  await mkFlag(orgId, 'fcm_wake_enabled', 'true');
  // Global rows: one the org overrides, one only global.
  await mkFlag('*', 'gps_queue_backend', 'sqlite');
  await mkFlag('*', 'owner_mode_in_driver_app', 'false');
  return orgId;
}

function setup() {
  const t = convexTest(schema);
  const ready = t.run(insertFixtures);
  return { t, ready };
}

describe('featureFlags.getForOrg', () => {
  it('WorkOS caller: org rows for the claim org, global rows merged, org wins', async () => {
    const { t, ready } = setup();
    await ready;
    const flags = await t
      .withIdentity({ subject: 'staff_x', org_id: WORKOS_ORG } as never)
      .query(api.featureFlags.getForOrg, {});
    expect(flags).toEqual({
      gps_queue_backend: 'mmkv', // org row overrides the global 'sqlite'
      owner_mode_in_driver_app: 'false', // global-only row reaches the org
    });
  });

  it('Clerk driver: resolves via drivers table, sees that org spelling + globals', async () => {
    const { t, ready } = setup();
    await ready;
    const flags = await t
      .withIdentity({ subject: 'user_some_driver', phone_number: DRIVER_PHONE } as never)
      .query(api.featureFlags.getForOrg, {});
    expect(flags).toEqual({
      gps_queue_backend: 'mmkv',
      owner_mode_in_driver_app: 'false',
    });
  });

  it('owner-only Clerk caller (no driver record): resolves via OWNER link across all org-id spellings', async () => {
    const { t, ready } = setup();
    const orgId = await ready;
    void orgId;
    const flags = await t
      .withIdentity({ subject: OWNER_CLERK_ID } as never)
      .query(api.featureFlags.getForOrg, {});
    // All three spellings' rows merge, plus globals with org override.
    expect(flags).toEqual({
      gps_queue_backend: 'mmkv',
      ar_wake_enabled: 'true',
      fcm_wake_enabled: 'true',
      owner_mode_in_driver_app: 'false',
    });
  });

  it('owner resolved by phone fallback when the link has a stale clerkUserId', async () => {
    const { t, ready } = setup();
    await ready;
    const flags = await t
      .withIdentity({ subject: 'user_fresh_instance_id', phone_number: OWNER_PHONE } as never)
      .query(api.featureFlags.getForOrg, {});
    expect(flags.owner_mode_in_driver_app).toBe('false');
    expect(flags.gps_queue_backend).toBe('mmkv');
  });

  it('unauthenticated caller gets {} — global rows never leak pre-auth', async () => {
    const { t, ready } = setup();
    await ready;
    const flags = await t.query(api.featureFlags.getForOrg, {});
    expect(flags).toEqual({});
  });

  it('authenticated but unrecognized caller (no driver, no link) gets {}', async () => {
    const { t, ready } = setup();
    await ready;
    const flags = await t
      .withIdentity({ subject: 'user_nobody', phone_number: '+15305550999' } as never)
      .query(api.featureFlags.getForOrg, {});
    expect(flags).toEqual({});
  });
});
