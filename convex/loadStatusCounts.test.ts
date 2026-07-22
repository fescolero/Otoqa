import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api, internal } from './_generated/api';
import { READ_FROM_CACHE_FLAG } from './loadStatusCounts';

/**
 * Integration tests for the eventually-exact load status count cache.
 * Proves: the rebuild produces exact counts for every query branch, the
 * no-firstStopDate quirk is preserved, HCR∧TRIP+date falls back to the scan,
 * the cache result equals the legacy scan, and rebuild flips the epoch + GCs.
 *
 * Dates are relative to now so the 18-month window always contains them,
 * regardless of when the suite runs.
 */

const ORG = 'org_lsc_test';
const USER = 'user_lsc_test';

function ymd(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);
}

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

type LoadStatus = 'Open' | 'Assigned' | 'Completed' | 'Canceled' | 'Expired';

async function seedLoad(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  customerId: Id<'customers'>,
  opts: { status: LoadStatus; firstStopDate?: string; hcr?: string; trip?: string },
): Promise<void> {
  const now = Date.now();
  const loadId = await ctx.db.insert('loadInformation', {
    internalId: `LD-${now}-${Math.floor(now % 1e6)}-${opts.status}-${opts.hcr ?? ''}-${opts.trip ?? ''}`,
    orderNumber: 'ORD',
    status: opts.status,
    trackingStatus: 'In Transit',
    customerId,
    fleet: 'Default',
    units: 'Pallets',
    firstStopDate: opts.firstStopDate,
    workosOrgId: ORG,
    createdBy: USER,
    createdAt: now,
    updatedAt: now,
  });
  if (opts.hcr) {
    await ctx.db.insert('loadTags', {
      workosOrgId: ORG,
      loadId,
      facetKey: 'HCR',
      canonicalValue: opts.hcr.toUpperCase(),
      value: opts.hcr,
      firstStopDate: opts.firstStopDate,
    });
  }
  if (opts.trip) {
    await ctx.db.insert('loadTags', {
      workosOrgId: ORG,
      loadId,
      facetKey: 'TRIP',
      canonicalValue: opts.trip.toUpperCase(),
      value: opts.trip,
      firstStopDate: opts.firstStopDate,
    });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enableFlag(ctx: any): Promise<void> {
  await ctx.db.insert('featureFlags', {
    workosOrgId: ORG,
    key: READ_FROM_CACHE_FLAG,
    value: 'true',
    updatedAt: Date.now(),
  });
}

/** Seed the standard world used by most cases. d0..d2 are recent in-window days. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedWorld(ctx: any) {
  const customerId = await seedCustomer(ctx);
  await seedLoad(ctx, customerId, { status: 'Open', firstStopDate: ymd(0), hcr: '917DK', trip: 'T1' }); // A
  await seedLoad(ctx, customerId, { status: 'Assigned', firstStopDate: ymd(1), hcr: '917DK', trip: 'T2' }); // B
  await seedLoad(ctx, customerId, { status: 'Completed', firstStopDate: ymd(2), hcr: '917DK', trip: 'T1' }); // C
  await seedLoad(ctx, customerId, { status: 'Open', firstStopDate: ymd(2), hcr: 'OTHER' }); // D
  await seedLoad(ctx, customerId, { status: 'Assigned', firstStopDate: ymd(1) }); // E (no facet)
  await seedLoad(ctx, customerId, { status: 'Open', hcr: '917DK' }); // F (no firstStopDate)
}

function authed(t: ReturnType<typeof convexTest>) {
  return t.withIdentity({ subject: USER, org_id: ORG });
}

const ZERO = { Open: 0, Assigned: 0, Delivered: 0, Canceled: 0, Expired: 0 };

describe('loadStatusCounts cache', () => {
  it('rebuild serves exact HCR counts (no date → __total__, includes no-firstStopDate load)', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    await t.run(enableFlag);

    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917dk', // lower-case → canonicalized
    });
    // A(Open) B(Assigned) C(Completed→Delivered) F(Open) — all carry HCR 917DK
    expect(counts).toEqual({ ...ZERO, Open: 2, Assigned: 1, Delivered: 1 });
  });

  it('HCR + date reads day buckets and EXCLUDES the no-firstStopDate load', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    await t.run(enableFlag);

    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
      startDate: ymd(0),
      endDate: ymd(2),
    });
    // A,B,C in range; F excluded (no firstStopDate)
    expect(counts).toEqual({ ...ZERO, Open: 1, Assigned: 1, Delivered: 1 });
  });

  it('date-only reads the ALL scope', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    await t.run(enableFlag);

    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      startDate: ymd(0),
      endDate: ymd(2),
    });
    // A(Open) B(Assigned) C(Delivered) D(Open) E(Assigned); F excluded
    expect(counts).toEqual({ ...ZERO, Open: 2, Assigned: 2, Delivered: 1 });
  });

  it('HCR ∧ TRIP with no date reads the HCRTRIP __total__ rollup', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    await t.run(enableFlag);

    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
      tripNumber: 'T1',
    });
    // A(Open) and C(Delivered) carry both 917DK and T1
    expect(counts).toEqual({ ...ZERO, Open: 1, Delivered: 1 });
  });

  it('HCR ∧ TRIP + date falls back to the scan and is still exact', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    await t.run(enableFlag);

    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
      tripNumber: 'T1',
      startDate: ymd(0),
      endDate: ymd(2),
    });
    expect(counts).toEqual({ ...ZERO, Open: 1, Delivered: 1 });
  });

  it('cache result equals the legacy scan (flag off)', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });

    // flag OFF → legacy scan
    const scan = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
    });
    await t.run(enableFlag);
    // flag ON → cache
    const cache = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
    });
    expect(cache).toEqual(scan);
    expect(cache).toEqual({ ...ZERO, Open: 2, Assigned: 1, Delivered: 1 });
  });

  it('falls back to the scan when the cache is not built (flag on, no epoch)', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.run(enableFlag); // flag on but NO rebuild → activeEpoch undefined

    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
    });
    expect(counts).toEqual({ ...ZERO, Open: 2, Assigned: 1, Delivered: 1 });
  });

  it('rebuild is idempotent: flips epoch, GCs the old generation, counts stable', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    const meta1 = await t.run(async (ctx) =>
      ctx.db
        .query('loadStatusCountsMeta')
        .withIndex('by_org', (q: any) => q.eq('workosOrgId', ORG))
        .first(),
    );
    expect(meta1!.activeEpoch).toBe(1);

    await t.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    const meta2 = await t.run(async (ctx) =>
      ctx.db
        .query('loadStatusCountsMeta')
        .withIndex('by_org', (q: any) => q.eq('workosOrgId', ORG))
        .first(),
    );
    expect(meta2!.activeEpoch).toBe(2);

    // Old epoch rows GC'd.
    const oldRows = await t.run(async (ctx) =>
      ctx.db
        .query('loadStatusCounts')
        .withIndex('by_scope_bucket', (q: any) =>
          q.eq('workosOrgId', ORG).eq('epoch', 1),
        )
        .collect(),
    );
    expect(oldRows).toHaveLength(0);

    await t.run(enableFlag);
    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
    });
    expect(counts).toEqual({ ...ZERO, Open: 2, Assigned: 1, Delivered: 1 });
  });
});
