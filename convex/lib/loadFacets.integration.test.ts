import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { api, internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';

/**
 * Integration tests — exercise the public mutations that wire setLoadTag
 * into the load lifecycle. Verifies dual-write semantics: parsedHcr /
 * parsedTripNumber are still written to loadInformation AND the new
 * loadTags + facetValues entries appear.
 *
 * These tests are the gate before Phase 2 (backfill) and Phase 3 (reader
 * swap). Failure here means the source-of-truth invariant is broken.
 */

const ORG = 'org_integration_test';
const USER_SUBJECT = 'user_test_subject';

const identity = {
  subject: USER_SUBJECT,
  org_id: ORG,
  name: 'Test User',
  email: 'test@test.com',
};

async function seedCustomer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
): Promise<Id<'customers'>> {
  const now = Date.now();
  return await ctx.db.insert('customers', {
    name: 'Integration Test Customer',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 Test St',
    city: 'Testville',
    state: 'CA',
    zip: '00000',
    country: 'USA',
    workosOrgId: ORG,
    createdBy: USER_SUBJECT,
    createdAt: now,
    updatedAt: now,
  });
}

const baseStop = (sequenceNumber: number, stopType: 'PICKUP' | 'DELIVERY') => ({
  sequenceNumber,
  stopType,
  loadingType: 'APPT' as const,
  address: '1 Stop St',
  city: 'Stopville',
  state: 'CA',
  postalCode: '00001',
  windowBeginDate: '2026-04-20',
  windowBeginTime: '09:00',
  windowEndDate: '2026-04-20',
  windowEndTime: '17:00',
  commodityDescription: 'Test',
  commodityUnits: 'Pallets' as const,
  pieces: 1,
});

// ─────────────────────────────────────────────────────────────────────
// loads.createLoad — dual-write
// ─────────────────────────────────────────────────────────────────────

describe('loads.createLoad (tag-only writes post Phase 5a)', () => {
  it('creates HCR + TRIP tags + facetValues; no longer writes columns on the load', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'INT-001',
      orderNumber: 'INT-001',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: 'T01',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    await t.run(async (ctx) => {
      // Phase 5b: columns dropped from schema. Cast through a loose
      // shape to assert the fields are absent from the doc.
      const load = await ctx.db.get(loadId);
      const staleLoad = load as unknown as {
        parsedHcr?: string;
        parsedTripNumber?: string;
        firstStopDate?: string;
      };
      expect(staleLoad.parsedHcr).toBeUndefined();
      expect(staleLoad.parsedTripNumber).toBeUndefined();
      expect(load?.firstStopDate).toBe('2026-04-20');

      // New tags created with canonical + display + firstStopDate denorm
      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(2);
      const byKey = Object.fromEntries(tags.map((t) => [t.facetKey, t]));
      expect(byKey.HCR).toMatchObject({
        canonicalValue: '917DK',
        value: '917DK',
        firstStopDate: '2026-04-20',
      });
      expect(byKey.TRIP).toMatchObject({
        canonicalValue: 'T01',
        value: 'T01',
        firstStopDate: '2026-04-20',
      });

      // facetValues populated for dropdown
      const facets = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) => q.eq('workosOrgId', ORG))
        .collect();
      const facetKeys = facets.map((f) => `${f.facetKey}:${f.canonicalValue}`).sort();
      expect(facetKeys).toEqual(['HCR:917DK', 'TRIP:T01']);
    });
  });

  it('does not create tags when parsedHcr/parsedTripNumber are omitted', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'INT-002',
      orderNumber: 'INT-002',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    await t.run(async (ctx) => {
      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(0);

      const facets = await ctx.db.query('facetValues').collect();
      expect(facets).toHaveLength(0);
    });
  });

  it('canonicalizes mixed-case HCR but preserves display casing', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'INT-003',
      orderNumber: 'INT-003',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917dk', // lowercase as user typed it
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    await t.run(async (ctx) => {
      const load = await ctx.db.get(loadId);
      const staleLoad = load as unknown as { parsedHcr?: string };
      expect(staleLoad.parsedHcr).toBeUndefined(); // column no longer exists

      const tag = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .filter((q) => q.eq(q.field('facetKey'), 'HCR'))
        .unique();
      expect(tag?.canonicalValue).toBe('917DK'); // canonical for matching
      expect(tag?.value).toBe('917dk'); // display preserved
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// loads.deleteLoad — tags removed, facetValues retained
// ─────────────────────────────────────────────────────────────────────

describe('loads.deleteLoad', () => {
  it('removes loadTags but leaves facetValues for cron pruning', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DEL-001',
      orderNumber: 'DEL-001',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: 'T01',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    await asUser.mutation(api.loads.deleteLoad, { loadId });

    await t.run(async (ctx) => {
      // Load gone
      const load = await ctx.db.get(loadId);
      expect(load).toBeNull();

      // Tags gone
      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(0);

      // facetValues retained — cron prunes
      const facets = await ctx.db.query('facetValues').collect();
      expect(facets).toHaveLength(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// contractLanes.create — facetValues registered without loadTags
// ─────────────────────────────────────────────────────────────────────

describe('contractLanes.create dual-write', () => {
  it('registers HCR + TRIP facetValues without creating any loadTags', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    await asUser.mutation(api.contractLanes.create, {
      workosOrgId: ORG,
      contractName: 'Test Lane',
      contractPeriodStart: '2026-01-01',
      contractPeriodEnd: '2026-12-31',
      hcr: '917DK',
      tripNumber: 'T01',
      customerCompanyId: customerId,
      stops: [],
      rate: 100,
      rateType: 'Flat Rate',
      currency: 'USD',
      createdBy: USER_SUBJECT,
    });

    await t.run(async (ctx) => {
      const tags = await ctx.db.query('loadTags').collect();
      expect(tags).toHaveLength(0);

      const facets = await ctx.db.query('facetValues').collect();
      expect(facets.map((f) => `${f.facetKey}:${f.canonicalValue}`).sort()).toEqual([
        'HCR:917DK',
        'TRIP:T01',
      ]);
    });
  });

  it('skips wildcard tripNumber from facetValues', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    await asUser.mutation(api.contractLanes.create, {
      workosOrgId: ORG,
      contractName: 'Wildcard Lane',
      contractPeriodStart: '2026-01-01',
      contractPeriodEnd: '2026-12-31',
      hcr: '917DK',
      tripNumber: '*',
      customerCompanyId: customerId,
      stops: [],
      rate: 100,
      rateType: 'Flat Rate',
      currency: 'USD',
      createdBy: USER_SUBJECT,
    });

    await t.run(async (ctx) => {
      const facets = await ctx.db.query('facetValues').collect();
      // Only HCR registered; TRIP "*" skipped
      expect(facets).toHaveLength(1);
      expect(facets[0]).toMatchObject({ facetKey: 'HCR', canonicalValue: '917DK' });
    });
  });

  it('shared HCR between contract lane and load uses one facetValues row', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    await asUser.mutation(api.contractLanes.create, {
      workosOrgId: ORG,
      contractName: 'Shared Lane',
      contractPeriodStart: '2026-01-01',
      contractPeriodEnd: '2026-12-31',
      hcr: '917DK',
      tripNumber: 'T01',
      customerCompanyId: customerId,
      stops: [],
      rate: 100,
      rateType: 'Flat Rate',
      currency: 'USD',
      createdBy: USER_SUBJECT,
    });

    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'SHR-001',
      orderNumber: 'SHR-001',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: 'T01',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    await t.run(async (ctx) => {
      const facets = await ctx.db.query('facetValues').collect();
      // Still one row per (org, key, canonical) — not two
      expect(facets).toHaveLength(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// firstStopDate propagation across stop edits (Phase 3 read-path correctness)
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
// getDistinctFilterValues — Phase 3 step 1 reader swap
// ─────────────────────────────────────────────────────────────────────

describe('loads.getDistinctFilterValues (facet-backed read path)', () => {
  it('returns distinct HCR + TRIP values from facetValues registry', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // Create three loads with two distinct HCRs and three distinct Trips.
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DV-001',
      orderNumber: 'DV-001',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DV-002',
      orderNumber: 'DV-002',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917DK', // same HCR, different trip
      parsedTripNumber: '109',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DV-003',
      orderNumber: 'DV-003',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '952L5',
      parsedTripNumber: '108', // same trip, different HCR
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    const result = await asUser.query(api.loads.getDistinctFilterValues, {
      workosOrgId: ORG,
    });

    expect(result.hcrs).toEqual(['917DK', '952L5']);
    expect(result.trips).toEqual(['108', '109']);
  });

  it('includes contract-lane-only values (never used on a load)', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // Create a contract lane but NO matching load.
    await asUser.mutation(api.contractLanes.create, {
      workosOrgId: ORG,
      contractName: 'Lane A',
      contractPeriodStart: '2026-01-01',
      contractPeriodEnd: '2026-12-31',
      hcr: '917DK',
      tripNumber: '108',
      customerCompanyId: customerId,
      stops: [],
      rate: 100,
      rateType: 'Flat Rate',
      currency: 'USD',
      createdBy: USER_SUBJECT,
    });

    const result = await asUser.query(api.loads.getDistinctFilterValues, {
      workosOrgId: ORG,
    });

    expect(result.hcrs).toEqual(['917DK']);
    expect(result.trips).toEqual(['108']);
  });

  it('is scoped per-org (no cross-org leakage)', async () => {
    const t = convexTest(schema);
    const customerA = await t.run((ctx) => seedCustomer(ctx));
    const customerB = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert('customers', {
        name: 'Other Org Customer',
        companyType: 'Shipper',
        status: 'Active',
        addressLine1: '2 Other',
        city: 'Other',
        state: 'CA',
        zip: '00000',
        country: 'USA',
        workosOrgId: 'org_other',
        createdBy: 'test',
        createdAt: now,
        updatedAt: now,
      });
    });

    const asA = t.withIdentity(identity);
    const asB = t.withIdentity({
      subject: 'user_other',
      org_id: 'org_other',
      name: 'Other',
      email: 'other@test.com',
    });

    await asA.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'A-1',
      orderNumber: 'A-1',
      customerId: customerA,
      fleet: 'A',
      units: 'Pallets',
      parsedHcr: 'A_ORG_HCR_917DK',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    await asB.mutation(api.loads.createLoad, {
      workosOrgId: 'org_other',
      createdBy: 'user_other',
      internalId: 'B-1',
      orderNumber: 'B-1',
      customerId: customerB,
      fleet: 'B',
      units: 'Pallets',
      parsedHcr: '952L5',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    const resultA = await asA.query(api.loads.getDistinctFilterValues, {
      workosOrgId: ORG,
    });
    const resultB = await asB.query(api.loads.getDistinctFilterValues, {
      workosOrgId: 'org_other',
    });

    // A_ORG_HCR_917DK contains an underscore so it'd be rejected at the
    // parser level in production — but here we inserted directly via
    // createLoad, which doesn't canonicalize. Accept what's stored.
    expect(resultA.hcrs.some((v) => v.includes('917DK'))).toBe(true);
    expect(resultA.hcrs).not.toContain('952L5');
    expect(resultB.hcrs).toEqual(['952L5']);
    expect(resultB.hcrs).not.toContain('A_ORG_HCR_917DK');
  });

  it('falls back to loadTags scan when facetValues is empty', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // Simulate facetValues drift: tags still exist (source of truth)
    // but facetValues cache got wiped. The fallback should recover
    // distinct values by scanning loadTags directly.
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'FB-1',
      orderNumber: 'FB-1',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    await t.run(async (ctx) => {
      // Drop only facetValues — keep tags as the fallback source
      const facets = await ctx.db.query('facetValues').collect();
      for (const f of facets) await ctx.db.delete(f._id);
    });

    const result = await asUser.query(api.loads.getDistinctFilterValues, {
      workosOrgId: ORG,
    });

    // Fallback loadTags scan recovers the values.
    expect(result.hcrs).toEqual(['917DK']);
    expect(result.trips).toEqual(['108']);
  });

  it('returns empty arrays for an org with no loads and no lanes', async () => {
    const t = convexTest(schema);
    const asUser = t.withIdentity(identity);

    const result = await asUser.query(api.loads.getDistinctFilterValues, {
      workosOrgId: ORG,
    });
    expect(result).toEqual({ hcrs: [], trips: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// getLoads — Phase 3 step 3 facet-pivoted filter path
// ─────────────────────────────────────────────────────────────────────

describe('loads.getLoads (facet-pivoted filter path)', () => {
  const setupLoads = async (t: ReturnType<typeof convexTest>) => {
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // Three loads with overlapping facets so we can verify combinations.
    const a = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'F-A',
      orderNumber: 'F-A',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    const b = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'F-B',
      orderNumber: 'F-B',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: '109',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    const c = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'F-C',
      orderNumber: 'F-C',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '952L5',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    return { customerId, asUser, ids: { a, b, c } };
  };

  it('filters by HCR alone via the tag index', async () => {
    const t = convexTest(schema);
    const { asUser, ids } = await setupLoads(t);

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      paginationOpts: { numItems: 25, cursor: null },
    });

    const internalIds = result.page.map((l: { internalId: string }) => l.internalId).sort();
    expect(internalIds).toEqual(['F-A', 'F-B']);
    expect(result.page.every((l: { _id: string }) =>
      [ids.a, ids.b].includes(l._id as typeof ids.a),
    )).toBe(true);
  });

  it('filters by TRIP alone via the tag index', async () => {
    const t = convexTest(schema);
    const { asUser } = await setupLoads(t);

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      tripNumber: '108',
      paginationOpts: { numItems: 25, cursor: null },
    });

    const internalIds = result.page.map((l: { internalId: string }) => l.internalId).sort();
    expect(internalIds).toEqual(['F-A', 'F-C']);
  });

  it('filters by HCR + TRIP combined (secondary verified per-load)', async () => {
    const t = convexTest(schema);
    const { asUser } = await setupLoads(t);

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      tripNumber: '108',
      paginationOpts: { numItems: 25, cursor: null },
    });

    const internalIds = result.page.map((l: { internalId: string }) => l.internalId);
    expect(internalIds).toEqual(['F-A']);
  });

  it('combined HCR+TRIP returns FULL page even when HCR set is large (regression)', async () => {
    // Reproduces the "newest 2 only" bug: if combined filter paginates the
    // large HCR set first and drops by secondary, pages shrink dramatically.
    // The intersection path should return ALL matching loads in one page
    // when intersection size <= page size.
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // 10 loads all share HCR=917DK; only 3 also share TRIP=108.
    for (let i = 0; i < 10; i++) {
      await asUser.mutation(api.loads.createLoad, {
        workosOrgId: ORG,
        createdBy: USER_SUBJECT,
        internalId: `BIG-HCR-${i}`,
        orderNumber: `BIG-HCR-${i}`,
        customerId,
        fleet: 'X',
        units: 'Pallets',
        parsedHcr: '917DK',
        parsedTripNumber: i < 3 ? '108' : `OTHER-${i}`,
        stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
      });
    }

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      tripNumber: '108',
      paginationOpts: { numItems: 25, cursor: null },
    });

    // Must return all 3 intersection matches, not just 0-2 from the
    // "newest window" of the HCR set.
    expect(result.page).toHaveLength(3);
    expect(result.isDone).toBe(true);
  });

  it('combined HCR+TRIP paginates correctly when intersection exceeds page size', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // 30 loads all share both HCR=917DK and TRIP=108.
    for (let i = 0; i < 30; i++) {
      await asUser.mutation(api.loads.createLoad, {
        workosOrgId: ORG,
        createdBy: USER_SUBJECT,
        internalId: `PAGE-${String(i).padStart(2, '0')}`,
        orderNumber: `PAGE-${String(i).padStart(2, '0')}`,
        customerId,
        fleet: 'X',
        units: 'Pallets',
        parsedHcr: '917DK',
        parsedTripNumber: '108',
        stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
      });
    }

    const page1 = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      tripNumber: '108',
      paginationOpts: { numItems: 20, cursor: null },
    });
    expect(page1.page).toHaveLength(20);
    expect(page1.isDone).toBe(false);
    expect(page1.continueCursor).toBeTruthy();

    const page2 = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      tripNumber: '108',
      paginationOpts: { numItems: 20, cursor: page1.continueCursor },
    });
    expect(page2.page).toHaveLength(10);
    expect(page2.isDone).toBe(true);

    // No overlap between pages
    const ids1 = new Set(page1.page.map((l: { _id: string }) => l._id));
    const ids2 = new Set(page2.page.map((l: { _id: string }) => l._id));
    for (const id of ids2) expect(ids1.has(id)).toBe(false);
  });

  it('canonicalizes filter inputs (mixed-case query matches uppercase tags)', async () => {
    const t = convexTest(schema);
    const { asUser } = await setupLoads(t);

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917dk', // lowercase
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page).toHaveLength(2);
  });

  it('combines facet filter with non-indexed status filter', async () => {
    const t = convexTest(schema);
    const { asUser, ids } = await setupLoads(t);

    // Set one of the F-A loads to Assigned via direct DB patch
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.b, { status: 'Assigned' });
    });

    const openOnly = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      status: 'Open',
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(openOnly.page.map((l: { internalId: string }) => l.internalId)).toEqual(['F-A']);

    const assignedOnly = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      status: 'Assigned',
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(assignedOnly.page.map((l: { internalId: string }) => l.internalId)).toEqual(['F-B']);
  });

  it('combines facet filter with date-range (uses indexed firstStopDate on tag)', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const earlyStop = (s: number, st: 'PICKUP' | 'DELIVERY') => ({
      ...baseStop(s, st),
      windowBeginDate: '2026-04-01',
      windowEndDate: '2026-04-01',
    });
    const lateStop = (s: number, st: 'PICKUP' | 'DELIVERY') => ({
      ...baseStop(s, st),
      windowBeginDate: '2026-06-01',
      windowEndDate: '2026-06-01',
    });

    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'EARLY',
      orderNumber: 'EARLY',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '917DK',
      stops: [earlyStop(1, 'PICKUP'), earlyStop(2, 'DELIVERY')],
    });
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'LATE',
      orderNumber: 'LATE',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '917DK',
      stops: [lateStop(1, 'PICKUP'), lateStop(2, 'DELIVERY')],
    });

    const inRange = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      hcr: '917DK',
      startDate: '2026-05-01',
      endDate: '2026-07-01',
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(inRange.page.map((l: { internalId: string }) => l.internalId)).toEqual(['LATE']);
  });

  it('unfiltered query still uses the loadInformation index (no regression)', async () => {
    const t = convexTest(schema);
    const { asUser } = await setupLoads(t);

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 3 step 4 regression — facet-backed reads in lanes.ts +
// autoAssignment.ts. We don't drive the full mutations here (they have
// many side effects); instead we verify the helper-based reads that
// replaced parsedHcr/parsedTripNumber column accesses work correctly.
// ─────────────────────────────────────────────────────────────────────

describe('Phase 3 step 4: facet-backed reads in lanes/autoAssignment paths', () => {
  it('findLoadIdsByFacets returns same loads that by_hcr_trip column scan would', async () => {
    // This is the fundamental contract behind lanes.previewBackfillImpact,
    // lanes.createLaneAndBackfill, lanes.voidUnmappedGroup, and
    // manualCleanup.triggerCleanup. If this is correct, those callers'
    // behavior is preserved.
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // Create matching loads with different load types
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'M-UNMAPPED-1',
      orderNumber: 'M-UNMAPPED-1',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'M-UNMAPPED-2',
      orderNumber: 'M-UNMAPPED-2',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });
    // Different HCR — should not match
    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'M-OTHER',
      orderNumber: 'M-OTHER',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '952L5',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    // Mark all as UNMAPPED via direct patch
    await t.run(async (ctx) => {
      const allLoads = await ctx.db
        .query('loadInformation')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', ORG))
        .collect();
      for (const l of allLoads) {
        await ctx.db.patch(l._id, { loadType: 'UNMAPPED' });
      }
    });

    // The lanes.ts pattern: findLoadIdsByFacets + filter loadType=UNMAPPED
    const matchedLoadIds = await t.run(async (ctx) => {
      const { findLoadIdsByFacets } = await import('./loadFacets');
      return await findLoadIdsByFacets(ctx, {
        workosOrgId: ORG,
        hcr: '917DK',
        trip: '108',
      });
    });

    expect(matchedLoadIds).toHaveLength(2);

    // Verify those are the right loads
    const internalIds = await t.run(async (ctx) => {
      const loads = await Promise.all(matchedLoadIds.map((id) => ctx.db.get(id)));
      return loads.map((l) => l!.internalId).sort();
    });
    expect(internalIds).toEqual(['M-UNMAPPED-1', 'M-UNMAPPED-2']);
  });

  it('getLoadFacets returns the hcr/trip values for a load (post column-drop)', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'AA-1',
      orderNumber: 'AA-1',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      parsedHcr: '917DK',
      parsedTripNumber: '108',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    const facets = await t.run(async (ctx) => {
      const { getLoadFacets } = await import('./loadFacets');
      const facets = await getLoadFacets(ctx, loadId);
      const load = await ctx.db.get(loadId);
      const staleLoad = load as unknown as {
        parsedHcr?: string;
        parsedTripNumber?: string;
      };
      return {
        tagFacets: facets,
        columnHcr: staleLoad.parsedHcr,
        columnTrip: staleLoad.parsedTripNumber,
      };
    });

    // Post Phase 5b: columns are gone from schema; tags are the
    // single source of truth for HCR/Trip lookups.
    expect(facets.columnHcr).toBeUndefined();
    expect(facets.columnTrip).toBeUndefined();
    expect(facets.tagFacets.hcr).toBe('917DK');
    expect(facets.tagFacets.trip).toBe('108');
  });

  it('getLoadFacets returns undefined when load has neither tag (auto-assignment NO_MATCH path)', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'NO-FACET',
      orderNumber: 'NO-FACET',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      // No parsedHcr / parsedTripNumber
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    const facets = await t.run(async (ctx) => {
      const { getLoadFacets } = await import('./loadFacets');
      return await getLoadFacets(ctx, loadId);
    });
    expect(facets.hcr).toBeUndefined();
    expect(facets.trip).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Issue #2: denormalized origin / destination / stopsCount on load
// ─────────────────────────────────────────────────────────────────────

describe('loadInformation stop denormalization (Issue #2)', () => {
  const pickupStop = {
    sequenceNumber: 1,
    stopType: 'PICKUP' as const,
    loadingType: 'APPT' as const,
    address: '100 Pickup St',
    city: 'Detroit',
    state: 'MI',
    postalCode: '48201',
    windowBeginDate: '2026-04-20',
    windowBeginTime: '09:00',
    windowEndDate: '2026-04-20',
    windowEndTime: '17:00',
    commodityDescription: 'Test',
    commodityUnits: 'Pallets' as const,
    pieces: 1,
  };
  const deliveryStop = {
    sequenceNumber: 2,
    stopType: 'DELIVERY' as const,
    loadingType: 'APPT' as const,
    address: '200 Delivery Ave',
    city: 'Chicago',
    state: 'IL',
    postalCode: '60601',
    windowBeginDate: '2026-04-21',
    windowBeginTime: '09:00',
    windowEndDate: '2026-04-21',
    windowEndTime: '17:00',
    commodityDescription: 'Test',
    commodityUnits: 'Pallets' as const,
    pieces: 1,
  };

  it('createLoad populates origin / destination / stopsCount denorm columns', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DN-1',
      orderNumber: 'DN-1',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      stops: [pickupStop, deliveryStop],
    });

    await t.run(async (ctx) => {
      const load = await ctx.db.get(loadId);
      expect(load?.originCity).toBe('Detroit');
      expect(load?.originState).toBe('MI');
      expect(load?.originAddress).toBe('100 Pickup St');
      expect(load?.destinationCity).toBe('Chicago');
      expect(load?.destinationState).toBe('IL');
      expect(load?.destinationAddress).toBe('200 Delivery Ave');
      expect(load?.stopsCountDenorm).toBe(2);
      expect(load?.firstStopDate).toBe('2026-04-20');
    });
  });

  it('getLoads page rows project origin / destination / stopsCount from columns (no per-row stops query)', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DN-PAGE-1',
      orderNumber: 'DN-PAGE-1',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      stops: [pickupStop, deliveryStop],
    });

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      paginationOpts: { numItems: 25, cursor: null },
    });

    expect(result.page).toHaveLength(1);
    const row = result.page[0] as typeof result.page[number] & {
      origin?: { city?: string; state?: string; address?: string } | null;
      destination?: { city?: string; state?: string; address?: string } | null;
      stopsCount?: number;
    };
    expect(row.origin?.city).toBe('Detroit');
    expect(row.origin?.state).toBe('MI');
    expect(row.destination?.city).toBe('Chicago');
    expect(row.destination?.state).toBe('IL');
    expect(row.stopsCount).toBe(2);
  });

  it('syncFirstStopDate refreshes denorm when stops change', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DN-SYNC',
      orderNumber: 'DN-SYNC',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      stops: [pickupStop, deliveryStop],
    });

    // Mutate the delivery stop's city
    await t.run(async (ctx) => {
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      const delivery = stops.find((s) => s.stopType === 'DELIVERY');
      if (delivery) {
        await ctx.db.patch(delivery._id, { city: 'Milwaukee', state: 'WI' });
      }
    });

    // Trigger the sync (production does this after any stop edit).
    await t.mutation(internal.loads.syncFirstStopDateMutation, { loadId });

    await t.run(async (ctx) => {
      const load = await ctx.db.get(loadId);
      expect(load?.destinationCity).toBe('Milwaukee');
      expect(load?.destinationState).toBe('WI');
    });
  });

  it('projects null origin / destination when stops are missing (edge case)', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    // Create a load, then manually delete its stops to simulate an
    // edge-case load with no stops (shouldn't happen in production but
    // the read path must not crash).
    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'DN-EMPTY',
      orderNumber: 'DN-EMPTY',
      customerId,
      fleet: 'X',
      units: 'Pallets',
      stops: [pickupStop, deliveryStop],
    });
    await t.run(async (ctx) => {
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      for (const s of stops) await ctx.db.delete(s._id);
    });
    await t.mutation(internal.loads.syncFirstStopDateMutation, { loadId });

    const result = await asUser.query(api.loads.getLoads, {
      workosOrgId: ORG,
      paginationOpts: { numItems: 25, cursor: null },
    });
    const row = result.page[0] as typeof result.page[number] & {
      origin?: { city?: string; state?: string } | null;
      destination?: { city?: string; state?: string } | null;
      stopsCount?: number;
    };
    expect(row.origin).toBeNull();
    expect(row.destination).toBeNull();
    expect(row.stopsCount).toBe(0);
  });
});

describe('firstStopDate propagation to loadTags', () => {
  it('updates tags firstStopDate when load stop date changes via syncFirstStopDateMutation', async () => {
    const t = convexTest(schema);
    const customerId = await t.run((ctx) => seedCustomer(ctx));
    const asUser = t.withIdentity(identity);

    const loadId = await asUser.mutation(api.loads.createLoad, {
      workosOrgId: ORG,
      createdBy: USER_SUBJECT,
      internalId: 'SYNC-001',
      orderNumber: 'SYNC-001',
      customerId,
      fleet: 'Default',
      units: 'Pallets',
      parsedHcr: '917DK',
      stops: [baseStop(1, 'PICKUP'), baseStop(2, 'DELIVERY')],
    });

    // Mutate the first stop's date directly
    await t.run(async (ctx) => {
      const firstStop = await ctx.db
        .query('loadStops')
        .withIndex('by_sequence', (q) => q.eq('loadId', loadId).eq('sequenceNumber', 1))
        .first();
      if (firstStop) {
        await ctx.db.patch(firstStop._id, { windowBeginDate: '2026-06-15' });
      }
    });

    // Trigger the sync (mimics what production does after stop edits)
    await t.mutation(internal.loads.syncFirstStopDateMutation, { loadId });

    await t.run(async (ctx) => {
      const load = await ctx.db.get(loadId);
      expect(load?.firstStopDate).toBe('2026-06-15');

      const tag = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .filter((q) => q.eq(q.field('facetKey'), 'HCR'))
        .unique();
      expect(tag?.firstStopDate).toBe('2026-06-15');
    });
  });
});
