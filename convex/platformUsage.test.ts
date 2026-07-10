import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import { getPeriodKey } from './accountingStatsHelpers';

/**
 * Tests for platform usage metering (Settings → Billing & usage).
 *   - createLoad increments platformUsageStats for the current cycle
 *   - countPlatformUsage rebuilds counts from source and zeroes stale periods
 *   - getBillingOverview derives cycles/statuses and respects the org rate
 *   - getBillingOverview is org-scoped (fail-closed)
 */

const ORG = 'org_platform_usage_test';
const USER = 'user_platform_usage_test';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedCustomer(ctx: any): Promise<Id<'customers'>> {
  const now = Date.now();
  return ctx.db.insert('customers', {
    name: 'C',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 St',
    city: 'Town',
    state: 'CA',
    zip: '00000',
    country: 'USA',
    workosOrgId: ORG,
    createdBy: USER,
    createdAt: now,
    updatedAt: now,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedLoad(ctx: any, customerId: Id<'customers'>, createdAt: number): Promise<void> {
  await ctx.db.insert('loadInformation', {
    internalId: `LD-${createdAt}-${Math.floor(Math.random() * 1e6)}`,
    orderNumber: 'ORD',
    status: 'Open',
    trackingStatus: 'Pending',
    customerId,
    fleet: 'Default',
    units: 'Pallets',
    workosOrgId: ORG,
    createdBy: USER,
    createdAt,
    updatedAt: createdAt,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedOrg(ctx: any, billingRatePerLoad?: number): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('organizations', {
    workosOrgId: ORG,
    orgType: 'BROKER',
    name: 'Test Freight LLC',
    billingEmail: 'ap@test.co',
    billingAddress: { addressLine1: '1 St', city: 'Town', state: 'CA', zip: '00000', country: 'USA' },
    subscriptionPlan: 'Enterprise',
    subscriptionStatus: 'Active',
    billingCycle: 'Monthly',
    billingRatePerLoad,
    createdAt: now,
    updatedAt: now,
  });
}

/** A mid-month (15th) UTC timestamp `offset` months before the current one. */
function midMonth(offset: number): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 15);
}

function makeT() {
  return convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
}

describe('platform usage metering', () => {
  it('createLoad records a billable load in the current cycle', async () => {
    const t = makeT();
    const customerId = await t.run(async (ctx) => {
      await seedOrg(ctx);
      return seedCustomer(ctx);
    });

    await t.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER,
      internalId: 'LD-TEST-1',
      orderNumber: 'ORD-1',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      stops: [
        {
          sequenceNumber: 1,
          stopType: 'PICKUP',
          loadingType: 'APPT',
          address: '1 Dock Rd',
          windowBeginDate: '2026-07-10',
          windowBeginTime: '08:00',
          windowEndDate: '2026-07-10',
          windowEndTime: '10:00',
          commodityDescription: 'Freight',
          commodityUnits: 'Pallets',
          pieces: 1,
        },
      ],
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('platformUsageStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', ORG))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].periodKey).toBe(getPeriodKey(Date.now()));
    expect(rows[0].loadsWritten).toBe(1);
  });

  it('countPlatformUsage rebuilds per-period counts from source and zeroes stale periods', async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const customerId = await seedCustomer(ctx);
      // 2 loads last month, 3 loads this month
      await seedLoad(ctx, customerId, midMonth(1));
      await seedLoad(ctx, customerId, midMonth(1) + 1000);
      await seedLoad(ctx, customerId, midMonth(0));
      await seedLoad(ctx, customerId, midMonth(0) + 1000);
      await seedLoad(ctx, customerId, midMonth(0) + 2000);
      // Drifted row for last month + stale row for a month with no loads
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: ORG,
        periodKey: getPeriodKey(midMonth(1)),
        loadsWritten: 99,
        updatedAt: Date.now(),
      });
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: ORG,
        periodKey: getPeriodKey(midMonth(5)),
        loadsWritten: 7,
        updatedAt: Date.now(),
      });
    });

    await t.mutation(internal.platformUsage.countPlatformUsage, {
      workosOrgId: ORG,
      cursor: null,
      accumulated: JSON.stringify({}),
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('platformUsageStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', ORG))
        .collect(),
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.periodKey, r.loadsWritten]));
    expect(byKey[getPeriodKey(midMonth(1))]).toBe(2);
    expect(byKey[getPeriodKey(midMonth(0))]).toBe(3);
    expect(byKey[getPeriodKey(midMonth(5))]).toBe(0); // stale period zeroed
  });

  it('getBillingOverview derives cycles, statuses, and amounts from the org rate', async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await seedOrg(ctx, 3);
      for (const [offset, loads] of [
        [3, 10],
        [1, 20], // gap at offset 2 — should be filled with a zero cycle
        [0, 5],
      ] as const) {
        await ctx.db.insert('platformUsageStats', {
          workosOrgId: ORG,
          periodKey: getPeriodKey(midMonth(offset)),
          loadsWritten: loads,
          updatedAt: Date.now(),
        });
      }
    });

    const overview = await t.query(api.platformUsage.getBillingOverview, { workosOrgId: ORG });

    expect(overview.rate).toBe(3);
    expect(overview.billingEmail).toBe('ap@test.co');
    expect(overview.companyName).toBe('Test Freight LLC');

    // Current (open) cycle
    expect(overview.currentCycle.periodKey).toBe(getPeriodKey(Date.now()));
    expect(overview.currentCycle.loadsWritten).toBe(5);
    expect(overview.currentCycle.dayOfCycle).toBe(new Date().getUTCDate());

    // Closed cycles: offsets 3, 2 (gap-filled), 1 — oldest first
    expect(overview.closedCycles.map((c) => c.periodKey)).toEqual([
      getPeriodKey(midMonth(3)),
      getPeriodKey(midMonth(2)),
      getPeriodKey(midMonth(1)),
    ]);
    expect(overview.closedCycles.map((c) => c.loadsWritten)).toEqual([10, 0, 20]);
    expect(overview.closedCycles.map((c) => c.amount)).toEqual([30, 0, 60]);
    // Placeholder statuses: latest closed cycle is due, older ones paid
    expect(overview.closedCycles.map((c) => c.status)).toEqual(['paid', 'paid', 'due']);
  });

  it('getBillingOverview uses the default rate when the org has no override', async () => {
    const t = makeT();
    await t.run(async (ctx) => seedOrg(ctx));
    const overview = await t.query(api.platformUsage.getBillingOverview, { workosOrgId: ORG });
    expect(overview.rate).toBe(2.5);
    expect(overview.closedCycles).toEqual([]);
    expect(overview.currentCycle.loadsWritten).toBe(0);
  });

  it('getBillingOverview rejects callers from another org', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: 'some_other_org' });
    await expect(t.query(api.platformUsage.getBillingOverview, { workosOrgId: ORG })).rejects.toThrow(
      /Not authorized/,
    );
  });
});
