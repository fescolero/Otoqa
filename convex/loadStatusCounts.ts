import { v } from 'convex/values';
import {
  internalAction,
  internalMutation,
  internalQuery,
} from './_generated/server';
import type { QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { canonicalizeFacetValue } from './lib/loadFacets';

/**
 * Eventually-exact load status counts — rebuild + read for the Dispatch Planner
 * badges (loads.countLoadsByStatusFiltered).
 *
 * The query used to scan a facet/date bucket and `get` every matched load,
 * which blew Convex's 4096-read limit. Instead we keep a `loadStatusCounts`
 * cache (one row per (org, epoch, scope, scopeValue, bucket, status)) that is
 * REBUILT FROM SOURCE by a change-gated background job. A full rebuild computes
 * from source, so the cache can never DRIFT — it can only LAG (≤ the rebuild
 * cadence). Reads are O(days-in-range), never O(loads).
 *
 * Full design + sign-off: docs/eventually-exact-load-counts-design.md
 */

// ── Tunables ────────────────────────────────────────────────────────────────

/** Day-grain rolling window. Loads older than this contribute only to __total__. */
const WINDOW_MONTHS = 18;
/** Loads per page in the build scan. 500 loads × ~2 tags ≈ 1500 reads/page. */
const BUILD_PAGE_SIZE = 500;
/** Cache rows written per writeCacheRows mutation. */
const WRITE_CHUNK = 800;
/** Cache rows deleted per GC mutation. */
const GC_CHUNK = 800;
/** Force a rebuild at least this often even if no change was detected. */
const SAFETY_NET_MS = 30 * 60 * 1000;
/** A build older than this is presumed stuck and may be restarted. */
const BUILD_STUCK_MS = 20 * 60 * 1000;
/**
 * Max rebuilds scheduled per 1-minute tick. Spreads the initial backfill (every
 * org is "never built" on the first tick) and any mass-change burst over several
 * ticks instead of a thundering herd. Remaining due orgs are picked up next tick.
 */
const MAX_REBUILDS_PER_TICK = 10;
/** Per-read safety cap: if a date-range read hits this, fall back to a scan. */
const READ_ROW_CAP = 4000;

const TOTAL_BUCKET = '__total__';
const ALL_VALUE = '*';
/** Separator for the HCR∧TRIP composite scopeValue. NUL can't appear in a facet. */
const COMBO_SEP = '\u0000';

export const READ_FROM_CACHE_FLAG = 'loadStatusCounts.readFromCache';

const LOAD_STATUSES = ['Open', 'Assigned', 'Completed', 'Canceled', 'Expired'] as const;
type LoadStatus = (typeof LOAD_STATUSES)[number];

const scopeValidator = v.union(
  v.literal('ALL'),
  v.literal('HCR'),
  v.literal('TRIP'),
  v.literal('HCRTRIP'),
);
const statusValidator = v.union(
  v.literal('Open'),
  v.literal('Assigned'),
  v.literal('Completed'),
  v.literal('Canceled'),
  v.literal('Expired'),
);

// ── Date helpers ────────────────────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MAX = '9999-12-31'; // sorts below '__total__' ('_' > '9'), so excludes it

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First-stop date as a day bucket, or null if absent/malformed (→ __total__ only). */
function dayBucket(firstStopDate: string | undefined): string | null {
  if (!firstStopDate || !DAY_RE.test(firstStopDate)) return null;
  return firstStopDate;
}

/** YYYY-MM-DD cutoff: loads with firstStopDate >= this get a day bucket. */
function windowCutoff(now: number): string {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - WINDOW_MONTHS);
  return toYMD(d);
}

function emptyCounts(): Record<LoadStatus, number> {
  return { Open: 0, Assigned: 0, Completed: 0, Canceled: 0, Expired: 0 };
}

/** Public count shape (Completed is surfaced as Delivered). */
export type FilteredStatusCounts = {
  Open: number;
  Assigned: number;
  Delivered: number;
  Canceled: number;
  Expired: number;
};

function toPublic(c: Record<LoadStatus, number>): FilteredStatusCounts {
  return {
    Open: c.Open,
    Assigned: c.Assigned,
    Delivered: c.Completed, // rename on the way out
    Canceled: c.Canceled,
    Expired: c.Expired,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// READ PATH — called by loads.countLoadsByStatusFiltered
// ════════════════════════════════════════════════════════════════════════════

/**
 * Read exact counts from the cache for a facet/date query, or return `null` if
 * the cache cannot serve this query exactly (not built yet, HCR∧TRIP+date, or a
 * date range reaching before the day-grain window). `null` means the caller
 * MUST fall back to the bounded scan.
 *
 * `hcr`/`trip` are the raw user inputs (canonicalized here to match the cache).
 */
export async function readScopedCounts(
  ctx: QueryCtx,
  args: {
    workosOrgId: string;
    hcr?: string;
    trip?: string;
    startDate?: string;
    endDate?: string;
  },
): Promise<FilteredStatusCounts | null> {
  const meta = await ctx.db
    .query('loadStatusCountsMeta')
    .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
    .first();
  if (!meta || meta.activeEpoch === undefined) return null; // not built yet
  const epoch = meta.activeEpoch;

  const canonHcr = args.hcr ? canonicalizeFacetValue(args.hcr) : undefined;
  const canonTrip = args.trip ? canonicalizeFacetValue(args.trip) : undefined;

  let scope: 'ALL' | 'HCR' | 'TRIP' | 'HCRTRIP';
  let scopeValue: string;
  if (canonHcr && canonTrip) {
    scope = 'HCRTRIP';
    scopeValue = `${canonHcr}${COMBO_SEP}${canonTrip}`;
  } else if (canonHcr) {
    scope = 'HCR';
    scopeValue = canonHcr;
  } else if (canonTrip) {
    scope = 'TRIP';
    scopeValue = canonTrip;
  } else {
    scope = 'ALL';
    scopeValue = ALL_VALUE;
  }

  const hasDate = !!(args.startDate || args.endDate);
  const counts = emptyCounts();

  if (!hasDate) {
    // No date → the all-time __total__ rollup (≤ 5 rows).
    const rows = await ctx.db
      .query('loadStatusCounts')
      .withIndex('by_scope_bucket', (q) =>
        q
          .eq('workosOrgId', args.workosOrgId)
          .eq('epoch', epoch)
          .eq('scope', scope)
          .eq('scopeValue', scopeValue)
          .eq('bucket', TOTAL_BUCKET),
      )
      .collect();
    for (const r of rows) counts[r.status] += r.count;
    return toPublic(counts);
  }

  // Date-bounded. The day grain can only serve it when:
  //   • the scope is day-materialized (HCRTRIP is __total__ only), and
  //   • the whole range sits inside the rolling window (start >= cutoff and
  //     start is bounded — an open lower bound could include pre-window loads).
  if (scope === 'HCRTRIP') return null;
  const cutoff = windowCutoff(Date.now());
  if (!args.startDate || args.startDate < cutoff) return null;
  const upper = args.endDate ?? DAY_MAX;

  const rows = await ctx.db
    .query('loadStatusCounts')
    .withIndex('by_scope_bucket', (q) =>
      q
        .eq('workosOrgId', args.workosOrgId)
        .eq('epoch', epoch)
        .eq('scope', scope)
        .eq('scopeValue', scopeValue)
        .gte('bucket', args.startDate!)
        .lte('bucket', upper),
    )
    .take(READ_ROW_CAP);
  if (rows.length === READ_ROW_CAP) return null; // pathological range → let the scan handle it
  for (const r of rows) counts[r.status] += r.count;
  return toPublic(counts);
}

// ════════════════════════════════════════════════════════════════════════════
// BUILD PATH — change-gated background rebuild
// ════════════════════════════════════════════════════════════════════════════

/** Page of loads joined with their (canonical) facet tags, for the build scan. */
export const pageLoadsForBuild = internalQuery({
  args: {
    workosOrgId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({
    page: v.array(
      v.object({
        status: statusValidator,
        firstStopDate: v.optional(v.string()),
        hcr: v.optional(v.string()),
        trip: v.optional(v.string()),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const res = await ctx.db
      .query('loadInformation')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .paginate({ numItems: BUILD_PAGE_SIZE, cursor: args.cursor });

    const page = await Promise.all(
      res.page.map(async (load) => {
        const tags = await ctx.db
          .query('loadTags')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();
        const hcr = tags.find((t) => t.facetKey === 'HCR')?.canonicalValue;
        const trip = tags.find((t) => t.facetKey === 'TRIP')?.canonicalValue;
        return {
          status: load.status as LoadStatus,
          firstStopDate: load.firstStopDate,
          hcr,
          trip,
        };
      }),
    );

    return { page, isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

/** Claim a fresh epoch for `workosOrgId` and mark a build in flight. */
export const beginBuild = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.object({ epoch: v.number() }),
  handler: async (ctx, args) => {
    const meta = await ctx.db
      .query('loadStatusCountsMeta')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
    const now = Date.now();
    const nextEpoch =
      Math.max(meta?.activeEpoch ?? 0, meta?.buildingEpoch ?? 0) + 1;
    if (meta) {
      await ctx.db.patch(meta._id, {
        buildingEpoch: nextEpoch,
        buildStartedAt: now,
      });
    } else {
      await ctx.db.insert('loadStatusCountsMeta', {
        workosOrgId: args.workosOrgId,
        buildingEpoch: nextEpoch,
        buildStartedAt: now,
      });
    }
    return { epoch: nextEpoch };
  },
});

/** Insert a chunk of freshly-computed cache rows for an in-flight epoch. */
export const writeCacheRows = internalMutation({
  args: {
    workosOrgId: v.string(),
    epoch: v.number(),
    rows: v.array(
      v.object({
        scope: scopeValidator,
        scopeValue: v.string(),
        bucket: v.string(),
        status: statusValidator,
        count: v.number(),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const r of args.rows) {
      await ctx.db.insert('loadStatusCounts', {
        workosOrgId: args.workosOrgId,
        epoch: args.epoch,
        scope: r.scope,
        scopeValue: r.scopeValue,
        bucket: r.bucket,
        status: r.status,
        count: r.count,
      });
    }
    return null;
  },
});

/**
 * Atomically flip `activeEpoch` to the just-built epoch. Readers switch over in
 * one step and never observe a half-built generation. Returns the previous
 * active epoch (if any) so the caller can GC it.
 */
export const finalizeBuild = internalMutation({
  args: { workosOrgId: v.string(), epoch: v.number(), rows: v.number() },
  returns: v.object({ previousEpoch: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const meta = await ctx.db
      .query('loadStatusCountsMeta')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
    const previousEpoch = meta?.activeEpoch ?? null;
    const now = Date.now();
    if (meta) {
      await ctx.db.patch(meta._id, {
        activeEpoch: args.epoch,
        buildingEpoch: undefined,
        buildStartedAt: undefined,
        lastBuiltAt: now,
        lastBuildRows: args.rows,
      });
    }
    return { previousEpoch };
  },
});

/** Delete one page of a superseded epoch's cache rows. */
export const gcEpoch = internalMutation({
  args: {
    workosOrgId: v.string(),
    epoch: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    const res = await ctx.db
      .query('loadStatusCounts')
      .withIndex('by_scope_bucket', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('epoch', args.epoch),
      )
      .paginate({ numItems: GC_CHUNK, cursor: args.cursor });
    for (const row of res.page) await ctx.db.delete(row._id);
    return { isDone: res.isDone, continueCursor: res.continueCursor };
  },
});

/**
 * Rebuild one org's cache: scan loads (joining tags) into an in-memory tally,
 * write the new epoch, flip it active, then GC the old epoch. Accumulation in
 * action memory keeps each transaction bounded; the realistic envelope is
 * tens-of-thousands of loads per org (see design §5).
 */
export const rebuildOrg = internalAction({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { epoch } = await ctx.runMutation(internal.loadStatusCounts.beginBuild, {
      workosOrgId: args.workosOrgId,
    });

    const cutoff = windowCutoff(Date.now());
    // key = scope \x01 scopeValue \x01 bucket \x01 status
    const tally = new Map<string, number>();
    const bump = (
      scope: string,
      scopeValue: string,
      bucket: string,
      status: LoadStatus,
    ) => {
      const key = `${scope}\u0001${scopeValue}\u0001${bucket}\u0001${status}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    };

    let cursor: string | null = null;
    for (;;) {
      const res: {
        page: Array<{
          status: LoadStatus;
          firstStopDate?: string;
          hcr?: string;
          trip?: string;
        }>;
        isDone: boolean;
        continueCursor: string;
      } = await ctx.runQuery(internal.loadStatusCounts.pageLoadsForBuild, {
        workosOrgId: args.workosOrgId,
        cursor,
      });

      for (const load of res.page) {
        const day = dayBucket(load.firstStopDate);
        const inWindow = day !== null && day >= cutoff;
        // ALL / HCR / TRIP: __total__ always, day bucket when in-window.
        const dayScopes: Array<[string, string]> = [['ALL', ALL_VALUE]];
        if (load.hcr) dayScopes.push(['HCR', load.hcr]);
        if (load.trip) dayScopes.push(['TRIP', load.trip]);
        for (const [scope, value] of dayScopes) {
          bump(scope, value, TOTAL_BUCKET, load.status);
          if (inWindow && day) bump(scope, value, day, load.status);
        }
        // HCRTRIP: __total__ only (intersection+date drills to a bounded scan).
        if (load.hcr && load.trip) {
          bump('HCRTRIP', `${load.hcr}${COMBO_SEP}${load.trip}`, TOTAL_BUCKET, load.status);
        }
      }

      if (res.isDone) break;
      cursor = res.continueCursor;
    }

    // Flush the tally to cache rows in bounded chunks.
    const rows: Array<{
      scope: 'ALL' | 'HCR' | 'TRIP' | 'HCRTRIP';
      scopeValue: string;
      bucket: string;
      status: LoadStatus;
      count: number;
    }> = [];
    for (const [key, count] of tally) {
      const [scope, scopeValue, bucket, status] = key.split('\u0001');
      rows.push({
        scope: scope as 'ALL' | 'HCR' | 'TRIP' | 'HCRTRIP',
        scopeValue,
        bucket,
        status: status as LoadStatus,
        count,
      });
    }
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      await ctx.runMutation(internal.loadStatusCounts.writeCacheRows, {
        workosOrgId: args.workosOrgId,
        epoch,
        rows: rows.slice(i, i + WRITE_CHUNK),
      });
    }

    const { previousEpoch } = await ctx.runMutation(
      internal.loadStatusCounts.finalizeBuild,
      { workosOrgId: args.workosOrgId, epoch, rows: rows.length },
    );

    // GC the superseded epoch (paginated).
    if (previousEpoch !== null) {
      let gcCursor: string | null = null;
      for (;;) {
        const r: { isDone: boolean; continueCursor: string } =
          await ctx.runMutation(internal.loadStatusCounts.gcEpoch, {
            workosOrgId: args.workosOrgId,
            epoch: previousEpoch,
            cursor: gcCursor,
          });
        if (r.isDone) break;
        gcCursor = r.continueCursor;
      }
    }

    return null;
  },
});

/**
 * 1-minute cron entry. For each org, rebuild ONLY when there's evidence of
 * change (organizationStats.updatedAt moved), the safety-net is due, or the
 * cache was never built. Idle orgs cost ~2 reads/min and start no rebuild.
 */
export const tickRebuildGate = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const orgs = await ctx.db.query('organizations').collect();
    const now = Date.now();
    let scheduled = 0;

    for (const org of orgs) {
      const workosOrgId = org.workosOrgId;
      if (!workosOrgId) continue;

      const meta = await ctx.db
        .query('loadStatusCountsMeta')
        .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
        .first();

      // Skip if a build is already in flight and not presumed stuck.
      if (
        meta?.buildingEpoch !== undefined &&
        meta.buildStartedAt !== undefined &&
        now - meta.buildStartedAt < BUILD_STUCK_MS
      ) {
        continue;
      }

      const stats = await ctx.db
        .query('organizationStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', workosOrgId))
        .first();

      const neverBuilt = !meta || meta.activeEpoch === undefined;
      const lastBuiltAt = meta?.lastBuiltAt ?? 0;
      const changed = (stats?.updatedAt ?? 0) > lastBuiltAt;
      const safetyNetDue = now - lastBuiltAt > SAFETY_NET_MS;

      if (neverBuilt || changed || safetyNetDue) {
        await ctx.scheduler.runAfter(0, internal.loadStatusCounts.rebuildOrg, {
          workosOrgId,
        });
        scheduled++;
        if (scheduled >= MAX_REBUILDS_PER_TICK) break; // rest picked up next tick
      }
    }

    if (scheduled > 0) {
      console.log(`[loadStatusCounts] rebuild scheduled for ${scheduled} org(s)`);
    }
    return null;
  },
});

// ════════════════════════════════════════════════════════════════════════════
// SHADOW-COMPARE — sampled cache-vs-source verification (dark-launch gate)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Cross-check: the ALL/__total__ cache counts must equal organizationStats
 * (an independently-maintained source). Logs and returns any divergence. Cheap
 * (≤ 5 cache rows + 1 stats row) so it's safe to run on a cron over all orgs.
 */
export const compareToOrgStats = internalQuery({
  args: { workosOrgId: v.string() },
  returns: v.object({
    built: v.boolean(),
    match: v.boolean(),
    cache: v.optional(
      v.object({
        Open: v.number(),
        Assigned: v.number(),
        Delivered: v.number(),
        Canceled: v.number(),
        Expired: v.number(),
      }),
    ),
    stats: v.optional(
      v.object({
        Open: v.number(),
        Assigned: v.number(),
        Delivered: v.number(),
        Canceled: v.number(),
        Expired: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const cache = await readScopedCounts(ctx, { workosOrgId: args.workosOrgId });
    if (!cache) return { built: false, match: true };

    const stats = await ctx.db
      .query('organizationStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
    const statCounts = {
      Open: stats?.loadCounts.Open ?? 0,
      Assigned: stats?.loadCounts.Assigned ?? 0,
      Delivered: stats?.loadCounts.Completed ?? 0,
      Canceled: stats?.loadCounts.Canceled ?? 0,
      Expired: stats?.loadCounts.Expired ?? 0,
    };
    const match =
      cache.Open === statCounts.Open &&
      cache.Assigned === statCounts.Assigned &&
      cache.Delivered === statCounts.Delivered &&
      cache.Canceled === statCounts.Canceled &&
      cache.Expired === statCounts.Expired;
    if (!match) {
      console.warn(
        `[loadStatusCounts] cache≠organizationStats for org ${args.workosOrgId}: ` +
          `cache=${JSON.stringify(cache)} stats=${JSON.stringify(statCounts)}`,
      );
    }
    return { built: true, match, cache, stats: statCounts };
  },
});

/** Orgs whose cache has been built at least once. */
export const listBuiltOrgIds = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const metas = await ctx.db.query('loadStatusCountsMeta').collect();
    return metas
      .filter((m) => m.activeEpoch !== undefined)
      .map((m) => m.workosOrgId);
  },
});

/**
 * Periodic cross-check (cron): for every built org, assert the cache's
 * all-time totals equal organizationStats (independently maintained). Two
 * independent oracles disagreeing means a bug in one of them — logged loudly.
 * Cheap (≤ 6 reads/org). Also the dark-launch confidence gate before flipping
 * the per-org READ_FROM_CACHE_FLAG.
 */
export const verifyAllOrgs = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const orgIds: string[] = await ctx.runQuery(
      internal.loadStatusCounts.listBuiltOrgIds,
      {},
    );
    let checked = 0;
    let mismatched = 0;
    for (const workosOrgId of orgIds) {
      const r = await ctx.runQuery(internal.loadStatusCounts.compareToOrgStats, {
        workosOrgId,
      });
      if (r.built) {
        checked++;
        if (!r.match) mismatched++;
      }
    }
    console.log(
      `[loadStatusCounts] shadow-compare: ${checked} org(s) checked, ${mismatched} mismatch(es)`,
    );
    return null;
  },
});
