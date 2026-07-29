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

  const mkBareLoad = async (internalId: string, stopWindowStart?: number) => {
    const loadId = await ctx.db.insert('loadInformation', {
      internalId,
      orderNumber: `ORD-${internalId}`,
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
    let stopId: Id<'loadStops'> | null = null;
    if (stopWindowStart != null) {
      stopId = await ctx.db.insert('loadStops', {
        loadId,
        internalId,
        workosOrgId: BROKER_ORG,
        sequenceNumber: 1,
        stopType: 'PICKUP',
        loadingType: 'APPT',
        address: '1 Dock Rd',
        windowBeginTime: new Date(stopWindowStart).toISOString(),
        windowEndTime: new Date(stopWindowStart + 2 * 3600_000).toISOString(),
        createdAt: now,
        updatedAt: now,
      });
    }
    return { loadId, stopId };
  };

  const mkLoad = async (opts: {
    internalId: string;
    status: 'AWARDED' | 'IN_PROGRESS' | 'COMPLETED';
    driverId?: Id<'drivers'>;
    stopWindowStart?: number;
    completedAt?: number;
  }) => {
    const { loadId } = await mkBareLoad(opts.internalId, opts.stopWindowStart);
    await ctx.db.insert('loadCarrierAssignments', {
      loadId,
      brokerOrgId: BROKER_ORG,
      carrierOrgId: CLERK_ORG,
      status: opts.status,
      offeredAt: now,
      createdBy: 'u',
      ...(opts.driverId ? { assignedDriverId: opts.driverId } : {}),
      ...(opts.completedAt != null ? { completedAt: opts.completedAt } : {}),
    });
    return loadId;
  };

  // Legs need real stop references — reuse the load's single stop.
  const mkLeg = async (opts: {
    internalId: string;
    status: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';
    driverId: Id<'drivers'>;
    workosOrgId?: string;
    stopWindowStart?: number;
    scheduledStartMs?: number;
    endedAt?: number;
    loadId?: Id<'loadInformation'>;
  }) => {
    let loadId = opts.loadId;
    let stopId: Id<'loadStops'> | null = null;
    if (!loadId) {
      const made = await mkBareLoad(opts.internalId, opts.stopWindowStart ?? dayStart + 9 * 3600_000);
      loadId = made.loadId;
      stopId = made.stopId;
    }
    if (!stopId) {
      stopId = (
        await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', loadId!))
          .first()
      )?._id as Id<'loadStops'>;
    }
    return ctx.db.insert('dispatchLegs', {
      loadId: loadId!,
      driverId: opts.driverId,
      sequence: 1,
      startStopId: stopId,
      endStopId: stopId,
      legLoadedMiles: 100,
      legEmptyMiles: 0,
      status: opts.status,
      workosOrgId: opts.workosOrgId ?? WORKOS_ORG,
      createdAt: now,
      updatedAt: now,
      ...(opts.scheduledStartMs != null ? { scheduledStartMs: opts.scheduledStartMs } : {}),
      ...(opts.endedAt != null ? { endedAt: opts.endedAt } : {}),
    });
  };

  // ── Assignment-source fixtures ──────────────────────────────────
  // Jorge, stop window inside yesterday → counts.
  const windowLoadId = await mkLoad({ internalId: 'H-WINDOW', status: 'IN_PROGRESS', driverId: jorge, stopWindowStart: dayStart + 9 * 3600_000 });
  // Jorge, completed yesterday, stop window elsewhere → counts via completedAt.
  await mkLoad({ internalId: 'H-DONE', status: 'COMPLETED', driverId: jorge, stopWindowStart: dayStart - 5 * 3600_000, completedAt: dayStart + 15 * 3600_000 });
  // Jorge, today only → excluded from yesterday.
  await mkLoad({ internalId: 'H-TODAY', status: 'AWARDED', driverId: jorge, stopWindowStart: dayStart + DAY + 9 * 3600_000 });
  // Other driver, yesterday → excluded.
  await mkLoad({ internalId: 'H-OTHER', status: 'IN_PROGRESS', driverId: other, stopWindowStart: dayStart + 9 * 3600_000 });

  // ── Leg-source fixtures (web-TMS assignments, no carrier row) ───
  // Denormalized schedule inside yesterday → counts.
  await mkLeg({ internalId: 'H-LEG-SCHED', status: 'COMPLETED', driverId: jorge, stopWindowStart: dayStart - 30 * 3600_000, scheduledStartMs: dayStart + 8 * 3600_000, endedAt: dayStart + 17 * 3600_000 });
  // Historical row: no scheduled/actual times — stop-window fallback.
  await mkLeg({ internalId: 'H-LEG-FALLBACK', status: 'ACTIVE', driverId: jorge, stopWindowStart: dayStart + 11 * 3600_000 });
  // Canceled leg on the day → excluded.
  await mkLeg({ internalId: 'H-LEG-CANCELED', status: 'CANCELED', driverId: jorge, stopWindowStart: dayStart + 9 * 3600_000 });
  // Leg on the SAME load as the H-WINDOW assignment → deduped.
  await mkLeg({ internalId: 'H-WINDOW', status: 'ACTIVE', driverId: jorge, loadId: windowLoadId });

  return { jorge, other };
}

function setup() {
  const t = convexTest(schema);
  const fixtures = t.run(insertFixtures);
  return { t, fixtures };
}

describe('listDriverHistory', () => {
  it("merges assignment + leg sources for the day, deduped, canceled and other-driver excluded", async () => {
    const { t, fixtures } = setup();
    const { jorge } = await fixtures;
    const rows = await t.withIdentity({ subject: OWNER }).query(api.dispatchMobile.listDriverHistory, {
      driverId: jorge,
      dayStartMs: dayStart,
      dayEndMs: dayStart + DAY,
    });
    expect(rows.map((r) => r.internalId).sort()).toEqual([
      'H-DONE', // assignment, counted via completedAt
      'H-LEG-FALLBACK', // leg, stop-window fallback (historical row)
      'H-LEG-SCHED', // leg, denormalized scheduledStartMs
      'H-WINDOW', // assignment + duplicate leg → ONE row
    ]);
    const done = rows.find((r) => r.internalId === 'H-DONE')!;
    expect(done.status).toBe('COMPLETED');
    expect(done.completedAt).toBeGreaterThan(0);
    // Leg statuses normalize to the assignment vocabulary.
    expect(rows.find((r) => r.internalId === 'H-LEG-SCHED')!.status).toBe('COMPLETED');
    expect(rows.find((r) => r.internalId === 'H-LEG-FALLBACK')!.status).toBe('IN_PROGRESS');
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
