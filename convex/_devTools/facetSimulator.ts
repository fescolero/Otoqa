import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
} from '../_generated/server';
import { internal } from '../_generated/api';
import { setLoadTag, removeAllTagsForLoad } from '../lib/loadFacets';
import { classifyRefToken } from '../fourKitesApiClient';
import type { Id } from '../_generated/dataModel';
import type { FunctionReference } from 'convex/server';

/**
 * Facet write-path burn-in simulator (DEV ONLY).
 *
 * Generates realistic and adversarial write traffic against the new
 * setLoadTag / facetValues paths so you can watch the Convex dev
 * dashboard for: OCC retries, function timing, error rates, table
 * growth, and read budget behavior — before touching prod.
 *
 * Run from the project root:
 *
 *   # Basic mixed burn-in (200 loads, 4 contract lanes, 20% deletes)
 *   npx convex run _devTools/facetSimulator:runMixedBurnIn
 *
 *   # Stress the worst-case OCC hotspot: 100 concurrent writes to the
 *   # SAME HCR value. Watch for retried function counts in the dashboard.
 *   npx convex run _devTools/facetSimulator:runHotKeyBurst '{"count": 100}'
 *
 *   # Quick smoke (50 loads, no parallelism — useful when iterating)
 *   npx convex run _devTools/facetSimulator:runMixedBurnIn '{"loadCount": 50, "concurrency": 1}'
 *
 *   # Cleanup all simulator-created test data after burn-in
 *   npx convex run _devTools/facetSimulator:cleanup
 *
 *   # Verify expected vs actual counts
 *   npx convex run _devTools/facetSimulator:summary
 *
 * Marker: every row created by the simulator includes the test org
 * id `org_facet_sim` so cleanup can find them. Do NOT run against
 * production — cleanup will only delete simulator data, but the
 * write traffic is still real load on the deployment.
 */

const TEST_ORG = 'org_facet_sim';
const TEST_USER = 'user_facet_sim';

// Synthetic value pools — keep small so we get realistic dedup behavior
// (multiple loads mapping to the same facet, like prod where ~200 distinct
// HCRs cover thousands of loads).
const HCR_POOL = [
  '917DK', '917DJ', '917DL', '999XY', '999XZ', '450AB', '450AC',
  '120HH', '120HI', 'ZZ001', 'ZZ002', '500AA',
];
const TRIP_POOL = ['T01', 'T02', 'T03', 'T04', 'T05', 'T10', 'T11', 'T20'];

const FAKE_DATES = [
  '2026-04-20', '2026-04-21', '2026-04-22', '2026-05-01',
  '2026-05-15', '2026-06-01',
];

function pick<T>(pool: readonly T[]): T {
  return pool[Math.floor(Math.random() * pool.length)];
}

// Self-references for cross-function calls. Slash-keyed namespace paths
// can't be indexed by TS literal types AND we recursively reference
// functions in this file from action handlers below — typing as any
// breaks both cycles. Runtime behavior is unchanged.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const self: any = (internal as any)['_devTools/facetSimulator'];
// Suppress unused import warning — kept for documentation of intent.
type _Ref = FunctionReference<'mutation' | 'action' | 'query', 'internal'>;
void (null as unknown as _Ref);

// ─────────────────────────────────────────────────────────────────────
// SETUP — seed customer + org for the simulator
// ─────────────────────────────────────────────────────────────────────

export const ensureSimulatorCustomer = internalMutation({
  args: {},
  returns: v.id('customers'),
  handler: async (ctx) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const existing = await ctx.db
      .query('customers')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', TEST_ORG))
      .first();
    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert('customers', {
      name: 'Facet Simulator Customer',
      companyType: 'Shipper',
      status: 'Active',
      addressLine1: 'Simulator',
      city: 'Sim',
      state: 'CA',
      zip: '00000',
      country: 'USA',
      workosOrgId: TEST_ORG,
      createdBy: TEST_USER,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────
// CORE WRITE — directly exercises setLoadTag (skips public mutation
// auth so the simulator doesn't need an authenticated identity).
// ─────────────────────────────────────────────────────────────────────

export const simulateLoadCreate = internalMutation({
  args: {
    customerId: v.id('customers'),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    firstStopDate: v.optional(v.string()),
    label: v.string(), // identifier for cleanup
  },
  returns: v.id('loadInformation'),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const now = Date.now();
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: `SIM-${args.label}`,
      orderNumber: `SIM-${args.label}`,
      status: 'Open',
      trackingStatus: 'Pending',
      customerId: args.customerId,
      fleet: 'SIM',
      units: 'Pallets',
      workosOrgId: TEST_ORG,
      createdBy: TEST_USER,
      createdAt: now,
      updatedAt: now,
      // HCR / TRIP stored only in loadTags via setLoadTag below.
      firstStopDate: args.firstStopDate,
    });

    // Exercise the production write helpers directly.
    await setLoadTag(ctx, {
      loadId,
      workosOrgId: TEST_ORG,
      facetKey: 'HCR',
      value: args.hcr,
      source: 'LOAD_MANUAL',
      firstStopDate: args.firstStopDate,
    });
    await setLoadTag(ctx, {
      loadId,
      workosOrgId: TEST_ORG,
      facetKey: 'TRIP',
      value: args.tripNumber,
      source: 'LOAD_MANUAL',
      firstStopDate: args.firstStopDate,
    });

    return loadId;
  },
});

export const simulateLoadDelete = internalMutation({
  args: { loadId: v.id('loadInformation') },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    await removeAllTagsForLoad(ctx, args.loadId);
    await ctx.db.delete(args.loadId);
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────
// SCENARIOS
// ─────────────────────────────────────────────────────────────────────

/**
 * Mixed traffic — closest approximation of a busy day in prod.
 * loadCount loads created in batches of `concurrency` parallel writes.
 * Each load gets a random HCR/TRIP from the pool. Roughly deletePercent
 * of them are deleted afterwards to exercise removeAllTagsForLoad.
 */
export const runMixedBurnIn = internalAction({
  args: {
    loadCount: v.optional(v.number()),
    concurrency: v.optional(v.number()),
    deletePercent: v.optional(v.number()),
  },
  returns: v.object({
    customerId: v.id('customers'),
    created: v.number(),
    deleted: v.number(),
    elapsedMs: v.number(),
    loadsPerSecond: v.number(),
  }),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const loadCount = args.loadCount ?? 200;
    const concurrency = args.concurrency ?? 10;
    const deletePercent = args.deletePercent ?? 20;
    const start = Date.now();

    const customerId = await ctx.runMutation(self.ensureSimulatorCustomer, {});
    const createdIds: Array<Id<'loadInformation'>> = [];

    for (let i = 0; i < loadCount; i += concurrency) {
      const batchSize = Math.min(concurrency, loadCount - i);
      const batch = await Promise.all(
        Array.from({ length: batchSize }, (_, j) =>
          ctx.runMutation(self.simulateLoadCreate, {
            customerId,
            hcr: pick(HCR_POOL),
            tripNumber: pick(TRIP_POOL),
            firstStopDate: pick(FAKE_DATES),
            label: `${start}-${i + j}`,
          }),
        ),
      );
      createdIds.push(...(batch as Array<Id<'loadInformation'>>));
    }

    // Delete a slice
    const deleteCount = Math.floor((createdIds.length * deletePercent) / 100);
    const toDelete = createdIds.slice(0, deleteCount);
    for (let i = 0; i < toDelete.length; i += concurrency) {
      const slice = toDelete.slice(i, i + concurrency);
      await Promise.all(
        slice.map((loadId) =>
          ctx.runMutation(self.simulateLoadDelete, { loadId }),
        ),
      );
    }

    const elapsedMs = Date.now() - start;
    const loadsPerSecond = (createdIds.length / elapsedMs) * 1000;

    console.log(
      `[facetSim] created=${createdIds.length} deleted=${toDelete.length} elapsed=${elapsedMs}ms rate=${loadsPerSecond.toFixed(1)}/s`,
    );

    return {
      customerId,
      created: createdIds.length,
      deleted: toDelete.length,
      elapsedMs,
      loadsPerSecond,
    };
  },
});

/**
 * Worst-case OCC contention: many concurrent loads with the SAME HCR.
 * Every write tries to upsert the same facetValues row. If you see
 * retried-function warnings in the dashboard, this is where they'll
 * surface. The presence-only design (no refcount) should keep retries
 * to ~1 per burst (first-write creates the row, rest are no-ops).
 */
export const runHotKeyBurst = internalAction({
  args: {
    count: v.optional(v.number()),
    sameHcr: v.optional(v.string()),
    sameTrip: v.optional(v.string()),
  },
  returns: v.object({
    created: v.number(),
    elapsedMs: v.number(),
  }),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const count = args.count ?? 50;
    const hcr = args.sameHcr ?? 'HOTKEY1';
    const trip = args.sameTrip ?? 'HOTTRIP';
    const start = Date.now();
    const customerId = await ctx.runMutation(self.ensureSimulatorCustomer, {});

    // Fire ALL writes in parallel — pure stress, no batching.
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        ctx.runMutation(self.simulateLoadCreate, {
          customerId,
          hcr,
          tripNumber: trip,
          firstStopDate: pick(FAKE_DATES),
          label: `hot-${start}-${i}`,
        }),
      ),
    );

    const elapsedMs = Date.now() - start;
    console.log(
      `[facetSim hotkey] created=${count} same-hcr=${hcr} elapsed=${elapsedMs}ms`,
    );
    return { created: count, elapsedMs };
  },
});

/**
 * Stress the case-canonicalization path: many loads with the SAME
 * canonical HCR but different display casings. Should still produce
 * a single facetValues row, with first-seen casing preserved.
 */
export const runCasingStorm = internalAction({
  args: { count: v.optional(v.number()) },
  returns: v.object({ created: v.number() }),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const count = args.count ?? 30;
    const customerId = await ctx.runMutation(self.ensureSimulatorCustomer, {});
    const variants = ['917dk', '917DK', '917Dk', '917dK', ' 917DK ', '917DK\n'];

    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        ctx.runMutation(self.simulateLoadCreate, {
          customerId,
          hcr: variants[i % variants.length],
          tripNumber: pick(TRIP_POOL),
          firstStopDate: pick(FAKE_DATES),
          label: `case-${Date.now()}-${i}`,
        }),
      ),
    );

    return { created: count };
  },
});

// ─────────────────────────────────────────────────────────────────────
// OBSERVABILITY
// ─────────────────────────────────────────────────────────────────────

/**
 * Returns a snapshot of the simulator's footprint:
 * - load count, tag count, facetValues count
 * - distinct canonical HCR/TRIP values seen
 * - any expected/actual divergence
 */
export const summary = internalQuery({
  args: {},
  returns: v.object({
    workosOrgId: v.string(),
    loads: v.number(),
    loadsWithHcr: v.number(),
    loadsWithTrip: v.number(),
    loadTags: v.number(),
    hcrTags: v.number(),
    tripTags: v.number(),
    facetValues: v.number(),
    distinctHcrInLoads: v.array(v.string()),
    distinctHcrInFacets: v.array(v.string()),
    distinctTripInLoads: v.array(v.string()),
    distinctTripInFacets: v.array(v.string()),
    consistent: v.boolean(),
  }),
  handler: async (ctx) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', TEST_ORG))
      .collect();

    const tags = await ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', TEST_ORG).eq('facetKey', 'HCR'),
      )
      .collect();
    const tripTagsList = await ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', TEST_ORG).eq('facetKey', 'TRIP'),
      )
      .collect();

    const facets = await ctx.db
      .query('facetValues')
      .withIndex('by_org_key', (q) => q.eq('workosOrgId', TEST_ORG))
      .collect();

    // Post Phase 5b: source of truth is loadTags. Count distinct loadIds
    // per facetKey and distinct canonical values directly from tags.
    const loadHcrs = new Set<string>();
    const loadTrips = new Set<string>();
    const loadsWithHcrSet = new Set<string>();
    const loadsWithTripSet = new Set<string>();
    for (const t of tags) {
      loadHcrs.add(t.canonicalValue);
      loadsWithHcrSet.add(t.loadId);
    }
    for (const t of tripTagsList) {
      loadTrips.add(t.canonicalValue);
      loadsWithTripSet.add(t.loadId);
    }
    const loadsWithHcr = loadsWithHcrSet.size;
    const loadsWithTrip = loadsWithTripSet.size;

    const facetHcrs = new Set(
      facets.filter((f) => f.facetKey === 'HCR').map((f) => f.canonicalValue),
    );
    const facetTrips = new Set(
      facets.filter((f) => f.facetKey === 'TRIP').map((f) => f.canonicalValue),
    );

    // Consistency check: every distinct canonical value in loadTags must
    // have a matching facetValues row. (facetValues may legitimately have
    // extras — e.g. from deleted loads, awaiting cron prune.)
    const consistent =
      [...loadHcrs].every((v) => facetHcrs.has(v)) &&
      [...loadTrips].every((v) => facetTrips.has(v));

    return {
      workosOrgId: TEST_ORG,
      loads: loads.length,
      loadsWithHcr,
      loadsWithTrip,
      loadTags: tags.length + tripTagsList.length,
      hcrTags: tags.length,
      tripTags: tripTagsList.length,
      facetValues: facets.length,
      distinctHcrInLoads: [...loadHcrs].sort(),
      distinctHcrInFacets: [...facetHcrs].sort(),
      distinctTripInLoads: [...loadTrips].sort(),
      distinctTripInFacets: [...facetTrips].sort(),
      consistent,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// DIAGNOSTICS — investigate suspicious facet values
// ─────────────────────────────────────────────────────────────────────

/**
 * Cheap health check — counts rows per facet table for a given org without
 * scanning load docs. Works under any table size because each query is
 * bounded to the org + facetKey via the index.
 *
 * Run:
 *   npx convex run _devTools/facetSimulator:facetHealthCheck \
 *     '{"workosOrgId":"org_..."}'
 */
export const facetHealthCheck = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.object({
    facetValuesHcr: v.number(),
    facetValuesTrip: v.number(),
    facetValuesTotal: v.number(),
    loadTagsHcrSample: v.number(),
    loadTagsTripSample: v.number(),
    facetDefinitionsCount: v.number(),
    firstFewHcrFacetValues: v.array(v.string()),
    firstFewTripFacetValues: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const CAP = 500; // sample cap; if more exist, numbers shown as CAP

    const hcrFacets = await ctx.db
      .query('facetValues')
      .withIndex('by_org_key', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'HCR'),
      )
      .take(CAP);
    const tripFacets = await ctx.db
      .query('facetValues')
      .withIndex('by_org_key', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'TRIP'),
      )
      .take(CAP);
    const totalFacets = await ctx.db
      .query('facetValues')
      .withIndex('by_org_key', (q) => q.eq('workosOrgId', args.workosOrgId))
      .take(CAP * 2);

    const hcrTagsSample = await ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'HCR'),
      )
      .take(CAP);
    const tripTagsSample = await ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('facetKey', 'TRIP'),
      )
      .take(CAP);

    const defs = await ctx.db
      .query('facetDefinitions')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    return {
      facetValuesHcr: hcrFacets.length,
      facetValuesTrip: tripFacets.length,
      facetValuesTotal: totalFacets.length,
      loadTagsHcrSample: hcrTagsSample.length,
      loadTagsTripSample: tripTagsSample.length,
      facetDefinitionsCount: defs.length,
      firstFewHcrFacetValues: hcrFacets.slice(0, 10).map((f) => f.value),
      firstFewTripFacetValues: tripFacets.slice(0, 10).map((f) => f.value),
    };
  },
});


/**
 * Finds loads whose parsedHcr or parsedTripNumber matches a given value.
 * Useful when a facetValues row looks wrong ("MPG" in HCR, etc.) and you
 * want to trace which loads contributed it and where they came from.
 *
 * Run:
 *   npx convex run _devTools/facetSimulator:findLoadsByFacetValue '{"facetKey": "HCR", "value": "MPG"}'
 */
export const findLoadsByFacetValue = internalQuery({
  args: {
    facetKey: v.string(),
    value: v.string(),
    workosOrgId: v.optional(v.string()),
  },
  returns: v.object({
    matchCount: v.number(),
    sample: v.array(
      v.object({
        loadId: v.id('loadInformation'),
        internalId: v.string(),
        externalSource: v.optional(v.string()),
        externalLoadId: v.optional(v.string()),
        parsedHcr: v.optional(v.string()),
        parsedTripNumber: v.optional(v.string()),
        createdAt: v.number(),
        createdBy: v.string(),
        workosOrgId: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    // Sources HCR/Trip from loadTags (the column is gone post Phase 5b).
    // Uses the by_org_key_canonical_date index for an exact canonical
    // match against the facet registry.
    const canonical = args.value.trim().toUpperCase();

    // If no org provided, we have to fall back to scanning all tags for
    // the facet+value. Convex indexes require leading equality on
    // workosOrgId, so the unscoped path is a full table scan — that's
    // why the CLI examples encourage passing workosOrgId.
    let matchingTags;
    if (args.workosOrgId) {
      const orgId = args.workosOrgId;
      matchingTags = await ctx.db
        .query('loadTags')
        .withIndex('by_org_key_canonical_date', (q) =>
          q
            .eq('workosOrgId', orgId)
            .eq('facetKey', args.facetKey)
            .eq('canonicalValue', canonical),
        )
        .collect();
    } else {
      matchingTags = await ctx.db
        .query('loadTags')
        .filter((q) =>
          q.and(
            q.eq(q.field('facetKey'), args.facetKey),
            q.eq(q.field('canonicalValue'), canonical),
          ),
        )
        .collect();
    }

    const matches = await Promise.all(
      matchingTags.map(async (t) => {
        const load = await ctx.db.get(t.loadId);
        return load ? { load, tag: t } : null;
      }),
    );
    const valid = matches.filter(
      (m): m is { load: NonNullable<typeof m>['load']; tag: typeof matchingTags[number] } =>
        m !== null,
    );

    // Separately fetch the other facet tag (HCR when facetKey=TRIP, etc.)
    // for the sample output — replaces the old column-based display.
    const otherKey = args.facetKey === 'HCR' ? 'TRIP' : 'HCR';
    const sample = await Promise.all(
      valid.slice(0, 20).map(async ({ load, tag }) => {
        const otherTag = await ctx.db
          .query('loadTags')
          .withIndex('by_load_key', (q) =>
            q.eq('loadId', load._id).eq('facetKey', otherKey),
          )
          .unique();
        const thisValue = tag.value;
        const otherValue = otherTag?.value;
        return {
          loadId: load._id,
          internalId: load.internalId,
          externalSource: load.externalSource,
          externalLoadId: load.externalLoadId,
          parsedHcr: args.facetKey === 'HCR' ? thisValue : otherValue,
          parsedTripNumber: args.facetKey === 'TRIP' ? thisValue : otherValue,
          createdAt: load.createdAt,
          createdBy: load.createdBy,
          workosOrgId: load.workosOrgId,
        };
      }),
    );

    return {
      matchCount: valid.length,
      sample,
    };
  },
});

/**
 * Distinct-value scanner: walks loadInformation and reports every unique
 * parsedHcr / parsedTripNumber value currently in the database, with
 * counts and a sample external source. Used to audit data quality before
 * changing the parser or writing a cleanup migration — so we don't miss
 * junk patterns beyond the ones we already know about (MPG, BTF_DIESEL).
 *
 * Run:
 *   npx convex run _devTools/facetSimulator:scanDistinctFacetValues
 *
 * Or scoped to an org:
 *   npx convex run _devTools/facetSimulator:scanDistinctFacetValues '{"workosOrgId":"org_..."}'
 *
 * The result flags each value with a heuristic classification so
 * suspicious patterns are obvious at a glance:
 *   - LIKELY_HCR    → looks like a valid HCR (e.g. 917DK, 95236)
 *   - LIKELY_TRIP   → looks like a valid Trip (e.g. 108, FOR2)
 *   - SUSPICIOUS    → probably junk (contains _, . or looks like an abbrev)
 *   - AMBIGUOUS     → doesn't match any known pattern
 */
export const scanDistinctFacetValues = internalQuery({
  args: { workosOrgId: v.optional(v.string()) },
  returns: v.object({
    totalLoads: v.number(),
    hcrValues: v.array(
      v.object({
        value: v.string(),
        canonical: v.string(),
        count: v.number(),
        classification: v.string(),
        sampleSource: v.optional(v.string()),
      }),
    ),
    tripValues: v.array(
      v.object({
        value: v.string(),
        canonical: v.string(),
        count: v.number(),
        classification: v.string(),
        sampleSource: v.optional(v.string()),
      }),
    ),
    summary: v.object({
      distinctHcrTotal: v.number(),
      distinctTripTotal: v.number(),
      suspiciousHcr: v.number(),
      suspiciousTrip: v.number(),
      ambiguousHcr: v.number(),
      ambiguousTrip: v.number(),
    }),
  }),
  handler: async (ctx, args) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    // Aggregate from loadTags only — DO NOT scan loadInformation. The
    // earlier version .collected() all loads to sample externalSource
    // per facet value, which blows the 16MB per-transaction read budget
    // at ~20K loads (load docs are ~1-3KB each). Tag rows are tiny so
    // this scales safely, and we just drop the externalSource sample
    // from the diagnostic report — it wasn't load-bearing.
    type Acc = Map<string, { value: string; count: number; sampleSource?: string }>;
    const hcrAcc: Acc = new Map();
    const tripAcc: Acc = new Map();

    const tagQuery = args.workosOrgId
      ? ctx.db
          .query('loadTags')
          .withIndex('by_org_key_canonical_date', (q) =>
            q.eq('workosOrgId', args.workosOrgId!),
          )
      : ctx.db.query('loadTags');

    let totalLoadsSeen = 0;
    const seenLoadIds = new Set<string>();
    for await (const tag of tagQuery) {
      if (!seenLoadIds.has(tag.loadId)) {
        seenLoadIds.add(tag.loadId);
        totalLoadsSeen++;
      }
      const acc = tag.facetKey === 'HCR' ? hcrAcc : tag.facetKey === 'TRIP' ? tripAcc : null;
      if (!acc) continue;
      const entry = acc.get(tag.canonicalValue);
      if (entry) entry.count++;
      else
        acc.set(tag.canonicalValue, {
          value: tag.value,
          count: 1,
        });
    }

    // Bind totalLoadsSeen into a `loads`-shaped variable so the existing
    // return expression (loads.length) continues to work.
    const loads = { length: totalLoadsSeen };

    // Reuse the production classifier so the diagnostic and the parser
    // agree on what counts as a valid HCR/TRIP. SUSPICIOUS is reserved
    // for tokens with obvious junk markers (underscores, decimals, pure
    // letters); AMBIGUOUS means the production classifier rejected it
    // but it doesn't match the obvious-junk patterns either.
    function classifyHcr(canonical: string): string {
      if (classifyRefToken(canonical) === 'HCR') return 'LIKELY_HCR';
      if (/[_.]/.test(canonical)) return 'SUSPICIOUS';
      if (/^[A-Z]+$/.test(canonical)) return 'SUSPICIOUS';
      return 'AMBIGUOUS';
    }
    function classifyTrip(canonical: string): string {
      if (classifyRefToken(canonical) === 'TRIP') return 'LIKELY_TRIP';
      if (/[_.]/.test(canonical)) return 'SUSPICIOUS';
      if (/^[A-Z]+$/.test(canonical)) return 'SUSPICIOUS';
      return 'AMBIGUOUS';
    }

    const hcrValues = [...hcrAcc.entries()]
      .map(([canonical, entry]) => ({
        value: entry.value,
        canonical,
        count: entry.count,
        classification: classifyHcr(canonical),
        sampleSource: entry.sampleSource,
      }))
      .sort((a, b) => b.count - a.count);

    const tripValues = [...tripAcc.entries()]
      .map(([canonical, entry]) => ({
        value: entry.value,
        canonical,
        count: entry.count,
        classification: classifyTrip(canonical),
        sampleSource: entry.sampleSource,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalLoads: loads.length,
      hcrValues,
      tripValues,
      summary: {
        distinctHcrTotal: hcrValues.length,
        distinctTripTotal: tripValues.length,
        suspiciousHcr: hcrValues.filter((v) => v.classification === 'SUSPICIOUS')
          .length,
        suspiciousTrip: tripValues.filter(
          (v) => v.classification === 'SUSPICIOUS',
        ).length,
        ambiguousHcr: hcrValues.filter((v) => v.classification === 'AMBIGUOUS')
          .length,
        ambiguousTrip: tripValues.filter(
          (v) => v.classification === 'AMBIGUOUS',
        ).length,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────────────

export const cleanup = internalAction({
  args: {},
  returns: v.object({
    deletedLoads: v.number(),
    deletedTags: v.number(),
    deletedFacets: v.number(),
    deletedCustomers: v.number(),
  }),
  handler: async (ctx) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    return await ctx.runMutation(self.cleanupMutation, {});
  },
});

export const cleanupMutation = internalMutation({
  args: {},
  returns: v.object({
    deletedLoads: v.number(),
    deletedTags: v.number(),
    deletedFacets: v.number(),
    deletedCustomers: v.number(),
  }),
  handler: async (ctx) => {
    if (process.env.OTOQA_ENABLE_DEV_TOOLS !== 'true') {
      throw new Error('Disabled in this deployment — set OTOQA_ENABLE_DEV_TOOLS=true to enable');
    }
    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', TEST_ORG))
      .collect();
    const tagsHcr = await ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', TEST_ORG).eq('facetKey', 'HCR'),
      )
      .collect();
    const tagsTrip = await ctx.db
      .query('loadTags')
      .withIndex('by_org_key_canonical_date', (q) =>
        q.eq('workosOrgId', TEST_ORG).eq('facetKey', 'TRIP'),
      )
      .collect();
    const facets = await ctx.db
      .query('facetValues')
      .withIndex('by_org_key', (q) => q.eq('workosOrgId', TEST_ORG))
      .collect();
    const customers = await ctx.db
      .query('customers')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', TEST_ORG))
      .collect();

    for (const l of loads) await ctx.db.delete(l._id);
    for (const t of [...tagsHcr, ...tagsTrip]) await ctx.db.delete(t._id);
    for (const f of facets) await ctx.db.delete(f._id);
    for (const c of customers) await ctx.db.delete(c._id);

    return {
      deletedLoads: loads.length,
      deletedTags: tagsHcr.length + tagsTrip.length,
      deletedFacets: facets.length,
      deletedCustomers: customers.length,
    };
  },
});
