import { convexTest } from 'convex-test';
import { describe, it, expect, vi } from 'vitest';
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

/**
 * The chunked rebuild. A real rebuild only reaches a continuation after
 * MAX_PAGES_PER_RUN × BUILD_PAGE_SIZE loads, so these drive it with the
 * pageSize/maxPages overrides: `pageSize: 2, maxPages: 1` turns the 6-load
 * world into three executions chained through the scheduler.
 */
describe('loadStatusCounts chunked rebuild', () => {
  /** Run a rebuild plus every continuation it schedules, to completion. */
  async function rebuildChunked(
    t: ReturnType<typeof convexTest>,
    opts: { pageSize: number; maxPages: number },
  ) {
    vi.useFakeTimers();
    try {
      await t.action(internal.loadStatusCounts.rebuildOrg, {
        workosOrgId: ORG,
        ...opts,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }
  }

  const readMeta = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) =>
      ctx.db
        .query('loadStatusCountsMeta')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex('by_org', (q: any) => q.eq('workosOrgId', ORG))
        .first(),
    );

  const readEpochRows = (t: ReturnType<typeof convexTest>, epoch: number) =>
    t.run(async (ctx) =>
      ctx.db
        .query('loadStatusCounts')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .withIndex('by_scope_bucket', (q: any) =>
          q.eq('workosOrgId', ORG).eq('epoch', epoch),
        )
        .collect(),
    );

  it('a rebuild split across continuations produces the same counts as one execution', async () => {
    // Baseline: single execution.
    const single = convexTest(schema);
    await single.run(seedWorld);
    await single.action(internal.loadStatusCounts.rebuildOrg, { workosOrgId: ORG });
    await single.run(enableFlag);

    // Same world, rebuilt two loads at a time across three executions.
    const chunked = convexTest(schema);
    await chunked.run(seedWorld);
    await rebuildChunked(chunked, { pageSize: 2, maxPages: 1 });
    await chunked.run(enableFlag);

    for (const args of [
      { hcr: '917DK' },
      { hcr: '917DK', startDate: ymd(0), endDate: ymd(2) },
      { startDate: ymd(0), endDate: ymd(2) },
      { hcr: '917DK', tripNumber: 'T1' },
      {},
    ]) {
      const a = await authed(single).query(api.loads.countLoadsByStatusFiltered, {
        workosOrgId: ORG,
        ...args,
      });
      const b = await authed(chunked).query(api.loads.countLoadsByStatusFiltered, {
        workosOrgId: ORG,
        ...args,
      });
      expect(b, `counts differ for ${JSON.stringify(args)}`).toEqual(a);
    }
  });

  it('continuations merge into one row per key instead of appending duplicates', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);
    await rebuildChunked(t, { pageSize: 2, maxPages: 1 });

    const meta = await readMeta(t);
    const rows = await readEpochRows(t, meta!.activeEpoch!);

    // Every chunk of the scan tallies ALL/__total__, so without the merge this
    // key would hold one row per chunk per status.
    const seen = new Map<string, number>();
    for (const r of rows) {
      const key = [r.scope, r.scopeValue, r.bucket, r.status].join('|');
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    expect(duplicated).toEqual([]);

    // And the merged ALL/__total__ counts still cover all 6 seeded loads.
    const allTotal = rows.filter(
      (r) => r.scope === 'ALL' && r.bucket === '__total__',
    );
    expect(allTotal.reduce((sum, r) => sum + r.count, 0)).toBe(6);
  });

  it('does not publish the epoch until the final continuation finishes', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);

    // First execution only: scans one page of 2, then schedules the rest.
    await t.action(internal.loadStatusCounts.rebuildOrg, {
      workosOrgId: ORG,
      pageSize: 2,
      maxPages: 1,
    });

    const mid = await readMeta(t);
    expect(mid!.activeEpoch).toBeUndefined(); // nothing published yet
    expect(mid!.buildingEpoch).toBe(1);
    // Rows exist, but under the unpublished epoch.
    expect((await readEpochRows(t, 1)).length).toBeGreaterThan(0);

    // A read while the build is mid-flight must fall back to the scan, not
    // serve the partial generation.
    await t.run(enableFlag);
    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
    });
    expect(counts).toEqual({ ...ZERO, Open: 2, Assigned: 1, Delivered: 1 });
  });

  it('taking over an abandoned build GCs the epoch it left behind', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);

    // Abandon a build: run one execution, then drop its continuation.
    await t.action(internal.loadStatusCounts.rebuildOrg, {
      workosOrgId: ORG,
      pageSize: 2,
      maxPages: 1,
    });
    expect((await readEpochRows(t, 1)).length).toBeGreaterThan(0);

    // The gate would restart it once presumed stuck; that claims epoch 2 and
    // must hand epoch 1's orphaned rows to the GC chain.
    await rebuildChunked(t, { pageSize: 2, maxPages: 1 });

    const meta = await readMeta(t);
    expect(meta!.activeEpoch).toBe(2);
    expect(meta!.buildingEpoch).toBeUndefined();
    expect(await readEpochRows(t, 1)).toHaveLength(0); // no leaked generation

    await t.run(enableFlag);
    const counts = await authed(t).query(api.loads.countLoadsByStatusFiltered, {
      workosOrgId: ORG,
      hcr: '917DK',
    });
    expect(counts).toEqual({ ...ZERO, Open: 2, Assigned: 1, Delivered: 1 });
  });

  it('a superseded continuation neither publishes nor leaves rows behind', async () => {
    const t = convexTest(schema);
    await t.run(seedWorld);

    // Build A starts and stalls after its first page.
    await t.action(internal.loadStatusCounts.rebuildOrg, {
      workosOrgId: ORG,
      pageSize: 2,
      maxPages: 1,
    });

    // Build B takes over the slot and completes.
    await rebuildChunked(t, { pageSize: 2, maxPages: 1 });
    const afterB = await readMeta(t);
    expect(afterB!.activeEpoch).toBe(2);

    // Build A's continuation now wakes up on the stale epoch. It must not flip
    // activeEpoch back to 1, and must clean up after itself.
    vi.useFakeTimers();
    try {
      await t.action(internal.loadStatusCounts.rebuildOrg, {
        workosOrgId: ORG,
        epoch: 1,
        cursor: null,
        pageSize: 2,
        maxPages: 1,
      });
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      vi.useRealTimers();
    }

    const meta = await readMeta(t);
    expect(meta!.activeEpoch).toBe(2); // still B's generation
    expect(await readEpochRows(t, 1)).toHaveLength(0);
  });
});
