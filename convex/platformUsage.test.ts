import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
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

async function seedLoad(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  customerId: Id<'customers'>,
  createdAt: number,
  firstStopDate?: string,
): Promise<void> {
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
    firstStopDate,
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

  it('countPlatformUsage raises undercounts from source but never reduces recorded charges', async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const customerId = await seedCustomer(ctx);
      // 2 loads last month, 3 loads this month
      await seedLoad(ctx, customerId, midMonth(1));
      await seedLoad(ctx, customerId, midMonth(1) + 1000);
      await seedLoad(ctx, customerId, midMonth(0));
      await seedLoad(ctx, customerId, midMonth(0) + 1000);
      await seedLoad(ctx, customerId, midMonth(0) + 2000);
      // Undercounted row for last month (missed increment) — must be raised.
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: ORG,
        periodKey: getPeriodKey(midMonth(1)),
        loadsWritten: 1,
        updatedAt: Date.now(),
      });
      // Recorded charges for a month whose loads were since hard-deleted —
      // billing is per load WRITTEN, so the charge must survive the recount.
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
    expect(byKey[getPeriodKey(midMonth(1))]).toBe(2); // undercount corrected up
    expect(byKey[getPeriodKey(midMonth(0))]).toBe(3); // backfilled from source
    expect(byKey[getPeriodKey(midMonth(5))]).toBe(7); // deleted loads keep their charge
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

  it('attributes pre-cutover history by service month and metered loads by entry month', async () => {
    const t = makeT();
    // Fixed pre-cutover timestamps (metering cutover = Jul 1, 2026 UTC).
    const IMPORT_DAY = Date.UTC(2026, 1, 10); // created Feb 10, 2026 (bulk import)
    await t.run(async (ctx) => {
      const customerId = await seedCustomer(ctx);
      // Two pre-cutover loads imported in Feb but SERVICED in January —
      // must land in 2026-01, not the Feb import month.
      await seedLoad(ctx, customerId, IMPORT_DAY, '2026-01-08');
      await seedLoad(ctx, customerId, IMPORT_DAY + 1000, '2026-01-22');
      // Pre-cutover load with no service date — falls back to entry month.
      await seedLoad(ctx, customerId, IMPORT_DAY + 2000);
      // Metered (post-cutover) load — entry month wins even though its
      // service date is elsewhere.
      const now = Date.now();
      await seedLoad(ctx, customerId, now, '2026-01-15');
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
    expect(byKey['2026-01']).toBe(2); // serviced Jan, imported Feb
    expect(byKey['2026-02']).toBe(1); // no service date → entry month
    expect(byKey[getPeriodKey(Date.now())]).toBe(1); // metered → entry month
  });

  it('rebaselineOrgPlatformUsage clears recorded rows and rebuilds from source', async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      const customerId = await seedCustomer(ctx);
      await seedLoad(ctx, customerId, Date.now());
      // Inflated row from an older attribution scheme — raise-only recalc
      // could never lower it; rebaseline must.
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: ORG,
        periodKey: '2026-02',
        loadsWritten: 7000,
        updatedAt: Date.now(),
      });
    });

    vi.useFakeTimers();
    try {
      await t.mutation(internal.platformUsage.rebaselineOrgPlatformUsage, { workosOrgId: ORG });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query('platformUsageStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', ORG))
        .collect(),
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.periodKey, r.loadsWritten]));
    expect(byKey['2026-02']).toBeUndefined(); // inflated row gone
    expect(byKey[getPeriodKey(Date.now())]).toBe(1); // rebuilt from source
  });

  it('getBillingOverview bounds history to the most recent 24 closed cycles', async () => {
    const t = makeT();
    await t.run(async (ctx) => {
      await seedOrg(ctx);
      // One ancient recorded cycle — the gap fill must clamp to the window
      // instead of materializing every month since.
      await ctx.db.insert('platformUsageStats', {
        workosOrgId: ORG,
        periodKey: getPeriodKey(midMonth(30)),
        loadsWritten: 4,
        updatedAt: Date.now(),
      });
    });
    const overview = await t.query(api.platformUsage.getBillingOverview, { workosOrgId: ORG });
    expect(overview.closedCycles).toHaveLength(24);
    expect(overview.closedCycles[0].periodKey).toBe(getPeriodKey(midMonth(24)));
    expect(overview.closedCycles[23].periodKey).toBe(getPeriodKey(midMonth(1)));
  });

  it('getBillingOverview uses the default rate when the org has no override', async () => {
    const t = makeT();
    await t.run(async (ctx) => seedOrg(ctx));
    const overview = await t.query(api.platformUsage.getBillingOverview, { workosOrgId: ORG });
    expect(overview.rate).toBe(2.65);
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
