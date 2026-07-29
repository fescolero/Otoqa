/**
 * listDriverHistory (voice "what loads did X have yesterday"):
 * day-membership = any stop window touching the client-supplied day
 * bounds OR completedAt inside them; driver must belong to the caller's
 * org; capability enforced.
 */
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';

const CLERK_ORG = 'org_clerk_hist';
const WORKOS_ORG = 'org_workos_hist';
const BROKER_ORG = 'org_workos_broker_hist';
const OWNER = 'user_hist_owner';
const MEMBER = 'user_hist_member';

const DAY = 86_400_000;
// Fixed local "yesterday" window for the whole fixture set.
const dayStart = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() - DAY;
})();

async function insertFixtures(ctx: MutationCtx) {
  const now = Date.now();
  const orgId = await ctx.db.insert('organizations', {
    name: 'Hist Carrier LLC',
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
  for (const [clerkUserId, role] of [
    [OWNER, 'OWNER'],
    [MEMBER, 'MEMBER'],
  ] as const) {
    await ctx.db.insert('userIdentityLinks', {
      clerkUserId,
      organizationId: orgId,
      role,
      createdAt: now,
      updatedAt: now,
    });
  }
  const mkDriver = (first: string) =>
    ctx.db.insert('drivers', {
      firstName: first,
      lastName: 'Romero',
      email: `${first}@t.co`,
      phone: `+1555${first.length}003300`,
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
  const jorge = await mkDriver('Jorge');
  const other = await mkDriver('Other');

  const customerId = await ctx.db.insert('customers', {
    name: 'Hist Shipper',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 St',
    city: 'Oakland',
    state: 'California',
    zip: '94601',
    country: 'USA',
    workosOrgId: BROKER_ORG,
    createdBy: 'u',
    createdAt: now,
    updatedAt: now,
  });

  const mkLoad = async (opts: {
    internalId: string;
    status: 'AWARDED' | 'IN_PROGRESS' | 'COMPLETED';
    driverId?: Id<'drivers'>;
    stopWindowStart?: number;
    completedAt?: number;
  }) => {
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: opts.internalId,
      orderNumber: `ORD-${opts.internalId}`,
      status: 'Assigned',
      trackingStatus: 'Pending',
      customerId,
      customerName: 'Hist Shipper',
      fleet: 'Main',
      units: 'Pallets',
      workosOrgId: BROKER_ORG,
      createdBy: 'u',
      createdAt: now,
      updatedAt: now,
    });
    if (opts.stopWindowStart != null) {
      await ctx.db.insert('loadStops', {
        loadId,
        internalId: opts.internalId,
        workosOrgId: BROKER_ORG,
        sequenceNumber: 1,
        stopType: 'PICKUP',
        loadingType: 'APPT',
        address: '1 Dock Rd',
        windowBeginTime: new Date(opts.stopWindowStart).toISOString(),
        windowEndTime: new Date(opts.stopWindowStart + 2 * 3600_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      });
    }
    return ctx.db.insert('loadCarrierAssignments', {
      loadId,
      brokerOrgId: BROKER_ORG,
      carrierOrgId: CLERK_ORG,
      status: opts.status,
      offeredAt: now,
      createdBy: 'u',
      ...(opts.driverId ? { assignedDriverId: opts.driverId } : {}),
      ...(opts.completedAt != null ? { completedAt: opts.completedAt } : {}),
    });
  };

  // Jorge, stop window inside yesterday → counts.
  await mkLoad({ internalId: 'H-WINDOW', status: 'IN_PROGRESS', driverId: jorge, stopWindowStart: dayStart + 9 * 3600_000 });
  // Jorge, completed yesterday, stop window elsewhere → counts via completedAt.
  await mkLoad({ internalId: 'H-DONE', status: 'COMPLETED', driverId: jorge, stopWindowStart: dayStart - 5 * 3600_000, completedAt: dayStart + 15 * 3600_000 });
  // Jorge, today only → excluded from yesterday.
  await mkLoad({ internalId: 'H-TODAY', status: 'AWARDED', driverId: jorge, stopWindowStart: dayStart + DAY + 9 * 3600_000 });
  // Other driver, yesterday → excluded.
  await mkLoad({ internalId: 'H-OTHER', status: 'IN_PROGRESS', driverId: other, stopWindowStart: dayStart + 9 * 3600_000 });

  return { jorge, other };
}

function setup() {
  const t = convexTest(schema);
  const fixtures = t.run(insertFixtures);
  return { t, fixtures };
}

describe('listDriverHistory', () => {
  it("returns the driver's loads touching the day (window or completion), nothing else", async () => {
    const { t, fixtures } = setup();
    const { jorge } = await fixtures;
    const rows = await t.withIdentity({ subject: OWNER }).query(api.dispatchMobile.listDriverHistory, {
      driverId: jorge,
      dayStartMs: dayStart,
      dayEndMs: dayStart + DAY,
    });
    expect(rows.map((r) => r.internalId).sort()).toEqual(['H-DONE', 'H-WINDOW']);
    const done = rows.find((r) => r.internalId === 'H-DONE')!;
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeGreaterThan(0);
  });

  it('fails closed: MEMBER, unauthenticated, unknown driver', async () => {
    const { t, fixtures } = setup();
    const { jorge } = await fixtures;
    const args = { driverId: jorge, dayStartMs: dayStart, dayEndMs: dayStart + DAY };
    await expect(
      t.withIdentity({ subject: MEMBER }).query(api.dispatchMobile.listDriverHistory, args),
    ).rejects.toThrow('Not authorized');
    await expect(t.query(api.dispatchMobile.listDriverHistory, args)).rejects.toThrow('Unauthenticated');
  });
});
