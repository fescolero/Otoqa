import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import {
  canonicalizeFacetValue,
  setLoadTag,
  removeAllTagsForLoad,
  syncFirstStopDateToTags,
  registerContractLaneFacet,
  getLoadFacets,
  findLoadIdsByFacets,
} from './loadFacets';
import type { Id } from '../_generated/dataModel';

/**
 * Helpers that build on convex-test's t.run() context. The library functions
 * under test take a MutationCtx, which t.run() provides — so we can call
 * them directly without registering wrapper mutations in the convex/ tree.
 */

const ORG = 'org_test_facet';

async function seedLoad(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  workosOrgId: string,
  internalId: string,
): Promise<Id<'loadInformation'>> {
  const now = Date.now();
  const customerId = await ctx.db.insert('customers', {
    name: 'Test Customer',
    companyType: 'Shipper',
    status: 'Active',
    addressLine1: '1 Test St',
    city: 'Testville',
    state: 'CA',
    zip: '00000',
    country: 'USA',
    workosOrgId,
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
  });

  return await ctx.db.insert('loadInformation', {
    internalId,
    orderNumber: internalId,
    status: 'Open',
    trackingStatus: 'Pending',
    customerId,
    fleet: 'Test',
    units: 'Pallets',
    workosOrgId,
    createdBy: 'test',
    createdAt: now,
    updatedAt: now,
  });
}

async function seedOrganization(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  workosOrgId: string,
  name: string,
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('organizations', {
    workosOrgId,
    orgType: 'BROKER',
    name,
    billingEmail: 'billing@test.com',
    billingAddress: {
      addressLine1: '1 Test St',
      city: 'Testville',
      state: 'CA',
      zip: '00000',
      country: 'USA',
    },
    subscriptionPlan: 'Enterprise',
    subscriptionStatus: 'Active',
    billingCycle: 'Annual',
    createdAt: now,
    updatedAt: now,
  });
}

// ─────────────────────────────────────────────────────────────────────
// canonicalizeFacetValue — pure function
// ─────────────────────────────────────────────────────────────────────

describe('canonicalizeFacetValue', () => {
  it('uppercases and trims', () => {
    expect(canonicalizeFacetValue('917dk')).toBe('917DK');
    expect(canonicalizeFacetValue(' 917DK ')).toBe('917DK');
    expect(canonicalizeFacetValue('917dk\n')).toBe('917DK');
  });

  it('preserves internal whitespace and special chars', () => {
    expect(canonicalizeFacetValue('a b c')).toBe('A B C');
    expect(canonicalizeFacetValue('foo-bar_baz')).toBe('FOO-BAR_BAZ');
  });

  it('is idempotent', () => {
    const once = canonicalizeFacetValue('917dk');
    expect(canonicalizeFacetValue(once)).toBe(once);
  });
});

// ─────────────────────────────────────────────────────────────────────
// setLoadTag — write semantics
// ─────────────────────────────────────────────────────────────────────

describe('setLoadTag', () => {
  it('creates a new tag and a facetValues row when none exists', async () => {
    const t = convexTest(schema);

    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-001');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
        firstStopDate: '2026-04-20',
      });

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(1);
      expect(tags[0]).toMatchObject({
        facetKey: 'HCR',
        canonicalValue: '917DK',
        value: '917DK',
        firstStopDate: '2026-04-20',
      });

      const values = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', ORG).eq('facetKey', 'HCR'),
        )
        .collect();
      expect(values).toHaveLength(1);
      expect(values[0].canonicalValue).toBe('917DK');
    });
  });

  it('canonicalizes value while preserving display casing', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-002');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: ' 917dk ',
        source: 'LOAD_MANUAL',
      });

      const tag = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .unique();
      expect(tag?.canonicalValue).toBe('917DK');
      expect(tag?.value).toBe('917dk');
    });
  });

  it('is a no-op when value is unchanged', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-003');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });
      const first = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .unique();

      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });
      const second = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .unique();

      expect(second?._id).toBe(first?._id);
    });
  });

  it('replaces tag when canonical value changes (delete + insert)', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-004');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '999XY',
        source: 'LOAD_MANUAL',
      });

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(1);
      expect(tags[0].canonicalValue).toBe('999XY');

      // Both values registered; old one pruned by cron, not by this path.
      const values = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', ORG).eq('facetKey', 'HCR'),
        )
        .collect();
      expect(values.map((v) => v.canonicalValue).sort()).toEqual([
        '917DK',
        '999XY',
      ]);
    });
  });

  it('removes tag when value becomes null or undefined', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-005');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: undefined,
        source: 'LOAD_MANUAL',
      });

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(0);
    });
  });

  it('does not register wildcard "*" or empty/whitespace values', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-006');
      for (const value of ['*', '', '   ']) {
        await setLoadTag(ctx, {
          loadId,
          workosOrgId: ORG,
          facetKey: 'TRIP',
          value,
          source: 'LOAD_MANUAL',
        });
      }

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(0);

      const values = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', ORG).eq('facetKey', 'TRIP'),
        )
        .collect();
      expect(values).toHaveLength(0);
    });
  });

  it('updates firstStopDate on an unchanged-value tag', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-007');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
        firstStopDate: '2026-04-20',
      });
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
        firstStopDate: '2026-05-01',
      });

      const tag = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .unique();
      expect(tag?.firstStopDate).toBe('2026-05-01');
    });
  });

  it('different loads with the same value share one facetValues row', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const a = await seedLoad(ctx, ORG, 'L-A');
      const b = await seedLoad(ctx, ORG, 'L-B');
      for (const id of [a, b]) {
        await setLoadTag(ctx, {
          loadId: id,
          workosOrgId: ORG,
          facetKey: 'HCR',
          value: '917DK',
          source: 'LOAD_MANUAL',
        });
      }

      const tags = await ctx.db.query('loadTags').collect();
      expect(tags).toHaveLength(2);

      const values = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', ORG).eq('facetKey', 'HCR'),
        )
        .collect();
      expect(values).toHaveLength(1);
    });
  });

  it('different orgs with the same value get separate facetValues rows', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const a = await seedLoad(ctx, 'org_a', 'L-A');
      const b = await seedLoad(ctx, 'org_b', 'L-B');
      await setLoadTag(ctx, {
        loadId: a,
        workosOrgId: 'org_a',
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });
      await setLoadTag(ctx, {
        loadId: b,
        workosOrgId: 'org_b',
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });

      const all = await ctx.db.query('facetValues').collect();
      expect(all).toHaveLength(2);
      expect(all.map((v) => v.workosOrgId).sort()).toEqual([
        'org_a',
        'org_b',
      ]);
    });
  });

  it('case variants with same canonical produce one tag; display preserved from first write', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-CASE');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917dk',
        source: 'LOAD_MANUAL',
      });
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK', // same canonical, different casing
        source: 'LOAD_MANUAL',
      });

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(1);
      expect(tags[0].canonicalValue).toBe('917DK');
      expect(tags[0].value).toBe('917dk'); // first write wins on display
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// removeAllTagsForLoad
// ─────────────────────────────────────────────────────────────────────

describe('removeAllTagsForLoad', () => {
  it('removes every tag on a load but leaves facetValues alone', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-DEL');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'TRIP',
        value: 'T01',
        source: 'LOAD_MANUAL',
      });

      await removeAllTagsForLoad(ctx, loadId);

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(0);

      const values = await ctx.db.query('facetValues').collect();
      expect(values).toHaveLength(2);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// syncFirstStopDateToTags
// ─────────────────────────────────────────────────────────────────────

describe('syncFirstStopDateToTags', () => {
  it('updates firstStopDate on every tag for a load', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-SYNC');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
        firstStopDate: '2026-04-20',
      });
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'TRIP',
        value: 'T01',
        source: 'LOAD_MANUAL',
        firstStopDate: '2026-04-20',
      });

      await syncFirstStopDateToTags(ctx, loadId, '2026-05-15');

      const tags = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();
      expect(tags).toHaveLength(2);
      for (const tag of tags) {
        expect(tag.firstStopDate).toBe('2026-05-15');
      }
    });
  });

  it('clears firstStopDate when new value is undefined', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-SYNC-CLEAR');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
        firstStopDate: '2026-04-20',
      });

      await syncFirstStopDateToTags(ctx, loadId, undefined);

      const tag = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .unique();
      expect(tag?.firstStopDate).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// registerContractLaneFacet
// ─────────────────────────────────────────────────────────────────────

describe('registerContractLaneFacet', () => {
  it('inserts a facetValues row without creating any loadTags', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await registerContractLaneFacet(ctx, ORG, 'HCR', '917DK');

      const tags = await ctx.db.query('loadTags').collect();
      expect(tags).toHaveLength(0);

      const values = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', ORG).eq('facetKey', 'HCR'),
        )
        .collect();
      expect(values).toHaveLength(1);
      expect(values[0].canonicalValue).toBe('917DK');
    });
  });

  it('skips wildcard values', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await registerContractLaneFacet(ctx, ORG, 'TRIP', '*');
      const values = await ctx.db.query('facetValues').collect();
      expect(values).toHaveLength(0);
    });
  });

  it('is idempotent', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      for (let i = 0; i < 3; i++) {
        await registerContractLaneFacet(ctx, ORG, 'HCR', '917DK');
      }
      const values = await ctx.db
        .query('facetValues')
        .withIndex('by_org_key', (q) =>
          q.eq('workosOrgId', ORG).eq('facetKey', 'HCR'),
        )
        .collect();
      expect(values).toHaveLength(1);
    });
  });

  it('skips null/undefined values silently', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await registerContractLaneFacet(ctx, ORG, 'HCR', undefined);
      const values = await ctx.db.query('facetValues').collect();
      expect(values).toHaveLength(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// getLoadFacets
// ─────────────────────────────────────────────────────────────────────

describe('getLoadFacets', () => {
  it('returns hcr + trip values + canonical for a load with both tags', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'GF-1');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917dk',
        source: 'LOAD_MANUAL',
      });
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'TRIP',
        value: '108',
        source: 'LOAD_MANUAL',
      });

      const facets = await getLoadFacets(ctx, loadId);
      // `all` field added in PR #11 — order matches tag insertion,
      // which here is HCR first (set above at 917dk) then TRIP (108).
      expect(facets).toEqual({
        hcr: '917dk',
        trip: '108',
        hcrCanonical: '917DK',
        tripCanonical: '108',
        all: [
          { key: 'HCR', value: '917dk' },
          { key: 'TRIP', value: '108' },
        ],
      });
    });
  });

  it('returns undefined for missing tags', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'GF-MISSING');
      const facets = await getLoadFacets(ctx, loadId);
      expect(facets).toEqual({
        hcr: undefined,
        trip: undefined,
        hcrCanonical: undefined,
        tripCanonical: undefined,
        all: [],
      });
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// findLoadIdsByFacets
// ─────────────────────────────────────────────────────────────────────

describe('findLoadIdsByFacets', () => {
  it('returns loadIds matching HCR alone', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const a = await seedLoad(ctx, ORG, 'L-A');
      const b = await seedLoad(ctx, ORG, 'L-B');
      const c = await seedLoad(ctx, ORG, 'L-C');
      for (const id of [a, b]) {
        await setLoadTag(ctx, {
          loadId: id,
          workosOrgId: ORG,
          facetKey: 'HCR',
          value: '917DK',
          source: 'LOAD_MANUAL',
        });
      }
      await setLoadTag(ctx, {
        loadId: c,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '999XY',
        source: 'LOAD_MANUAL',
      });

      const ids = await findLoadIdsByFacets(ctx, {
        workosOrgId: ORG,
        hcr: '917DK',
      });
      expect(ids.sort()).toEqual([a, b].sort());
    });
  });

  it('returns loadIds matching TRIP alone', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const a = await seedLoad(ctx, ORG, 'L-A');
      const b = await seedLoad(ctx, ORG, 'L-B');
      for (const id of [a, b]) {
        await setLoadTag(ctx, {
          loadId: id,
          workosOrgId: ORG,
          facetKey: 'TRIP',
          value: '108',
          source: 'LOAD_MANUAL',
        });
      }

      const ids = await findLoadIdsByFacets(ctx, {
        workosOrgId: ORG,
        trip: '108',
      });
      expect(ids.sort()).toEqual([a, b].sort());
    });
  });

  it('intersects HCR + TRIP (returns only loads matching both)', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const a = await seedLoad(ctx, ORG, 'L-A'); // HCR=X, TRIP=1
      const b = await seedLoad(ctx, ORG, 'L-B'); // HCR=X, TRIP=2
      const c = await seedLoad(ctx, ORG, 'L-C'); // HCR=Y, TRIP=1

      const seed = async (loadId: typeof a, hcr: string, trip: string) => {
        await setLoadTag(ctx, {
          loadId, workosOrgId: ORG, facetKey: 'HCR', value: hcr, source: 'LOAD_MANUAL',
        });
        await setLoadTag(ctx, {
          loadId, workosOrgId: ORG, facetKey: 'TRIP', value: trip, source: 'LOAD_MANUAL',
        });
      };
      await seed(a, '917DK', '108');
      await seed(b, '917DK', '109');
      await seed(c, '952L5', '108');

      const ids = await findLoadIdsByFacets(ctx, {
        workosOrgId: ORG,
        hcr: '917DK',
        trip: '108',
      });
      expect(ids).toEqual([a]);
    });
  });

  it('canonicalizes input', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const loadId = await seedLoad(ctx, ORG, 'L-CASE');
      await setLoadTag(ctx, {
        loadId,
        workosOrgId: ORG,
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });

      const ids = await findLoadIdsByFacets(ctx, {
        workosOrgId: ORG,
        hcr: '917dk', // lowercase input
      });
      expect(ids).toEqual([loadId]);
    });
  });

  it('returns empty when neither facet supplied', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const ids = await findLoadIdsByFacets(ctx, { workosOrgId: ORG });
      expect(ids).toEqual([]);
    });
  });

  it('does not leak across orgs', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const a = await seedLoad(ctx, 'org_a', 'L-A');
      const b = await seedLoad(ctx, 'org_b', 'L-B');
      await setLoadTag(ctx, {
        loadId: a,
        workosOrgId: 'org_a',
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });
      await setLoadTag(ctx, {
        loadId: b,
        workosOrgId: 'org_b',
        facetKey: 'HCR',
        value: '917DK',
        source: 'LOAD_MANUAL',
      });

      const ids = await findLoadIdsByFacets(ctx, {
        workosOrgId: 'org_a',
        hcr: '917DK',
      });
      expect(ids).toEqual([a]);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// Bootstrap migration integration test
// ─────────────────────────────────────────────────────────────────────

describe('bootstrapFacetDefinitions migration', () => {
  // internal.migrations uses slash-keyed paths which TS can't index with
  // string literals; cast through unknown for the reference lookup.
  const migrationRef = (
    internal as unknown as Record<string, Record<string, unknown>>
  )['migrations/004_bootstrap_facet_definitions']
    .bootstrapFacetDefinitions as Parameters<
    ReturnType<typeof convexTest>['mutation']
  >[0];

  it('inserts HCR + TRIP for every org with a workosOrgId', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await seedOrganization(ctx, 'org_one', 'Org One');
      await seedOrganization(ctx, 'org_two', 'Org Two');
    });

    const result = await t.mutation(migrationRef, {});
    expect(result.orgsProcessed).toBe(2);
    expect(result.inserted).toBe(4);

    await t.run(async (ctx) => {
      const defs = await ctx.db.query('facetDefinitions').collect();
      expect(defs).toHaveLength(4);
      expect(defs.map((d) => `${d.workosOrgId}:${d.key}`).sort()).toEqual([
        'org_one:HCR',
        'org_one:TRIP',
        'org_two:HCR',
        'org_two:TRIP',
      ]);
    });
  });

  it('is idempotent on re-run', async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await seedOrganization(ctx, 'org_one', 'Org One');
    });

    await t.mutation(migrationRef, {});
    const second = await t.mutation(migrationRef, {});
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
  });
});
