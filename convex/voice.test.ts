/**
 * voiceContext (keyterm source for Deepgram Keyterm Prompting): org
 * drivers + active customers, org-scoped, auth enforced.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';
import type { MutationCtx } from './_generated/server';

const CLERK_ORG = 'org_clerk_voice';
const WORKOS_ORG = 'org_workos_voice';
const OWNER = 'user_voice_owner';

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Voice Carrier LLC',
    clerkOrgId: CLERK_ORG,
    workosOrgId: WORKOS_ORG,
    orgType: 'CARRIER',
    billingEmail: 'b@t.co',
    billingAddress: {
      addressLine1: '1 St',
      city: 'Oakland',
      state: 'California',
      zip: '94601',
      country: 'USA',
    },
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
  await ctx.db.insert('drivers', {
    firstName: 'Marcus',
    lastName: 'Vega',
    email: 'm@t.co',
    phone: '+15551002200',
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
  const customer = (name: string, status: string, isDeleted?: boolean) =>
    ctx.db.insert('customers', {
      name,
      companyType: 'Shipper',
      status,
      addressLine1: '1 St',
      city: 'Oakland',
      state: 'California',
      zip: '94601',
      country: 'USA',
      workosOrgId: WORKOS_ORG,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
      ...(isDeleted ? { isDeleted: true } : {}),
    });
  await customer('Acme Shippers', 'Active');
  await customer('Gone Freight', 'Inactive');
  await customer('Deleted Co', 'Active', true);
}

describe('voiceContext', () => {
  it('returns driver + active customer names for the org, auth enforced', async () => {
    const t = convexTest(schema);
    await t.run(insertFixtures);
    const res = await t
      .withIdentity({ subject: OWNER })
      .query(internal.voice.voiceContext, {});
    expect(res.keyterms).toContain('Marcus Vega');
    expect(res.keyterms).toContain('Acme Shippers');
    expect(res.keyterms).not.toContain('Gone Freight');
    expect(res.keyterms).not.toContain('Deleted Co');

    await expect(t.query(internal.voice.voiceContext, {})).rejects.toThrow('Unauthenticated');
  });
});
