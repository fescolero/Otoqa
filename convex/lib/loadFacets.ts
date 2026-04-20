import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';

/**
 * Facet system — source of truth for load filter values.
 *
 * This helper is the single supported write path for load tags.
 * Callers MUST use setLoadTag / removeAllTagsForLoad. Direct writes to
 * loadTags / facetValues are bugs: they bypass the upsert semantics and
 * the facetValues projection.
 *
 * See docs: the facet migration plan in the team wiki.
 */

export type FacetSource =
  | 'LOAD_MANUAL'
  | 'LOAD_FOURKITES'
  | 'LOAD_RECURRING'
  | 'CONTRACT_LANE_MIRROR';

/**
 * Canonicalize a facet value for matching.
 *
 * trim + uppercase. Preserves internal whitespace. Display casing is stored
 * separately on the tag (value) and on the facetValues row (first-seen).
 *
 * If this normalization ever changes, every existing canonicalValue must be
 * re-derived via a migration — matching depends on it being stable.
 */
export function canonicalizeFacetValue(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Returns true iff the value should be registered in facetValues / loadTags.
 *
 * Wildcards (e.g. contract lane tripNumber='*') are routing rules, not
 * user-selectable filter values — they must not appear in dropdowns.
 */
function isRegisterableValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '*') return false;
  return true;
}

interface SetLoadTagArgs {
  loadId: Id<'loadInformation'>;
  workosOrgId: string;
  facetKey: string;
  /** Undefined or empty string removes the tag. */
  value: string | undefined | null;
  source: FacetSource;
  /** Mirror of loadInformation.firstStopDate; denormalized for pagination. */
  firstStopDate?: string;
}

/**
 * Idempotent write for a single (load, facetKey) tag.
 *
 * Behavior:
 *   - value equals current canonical → no-op
 *   - value differs → delete old tag, insert new tag, upsert facetValues
 *   - value is undefined/empty/wildcard → remove tag if present
 *
 * Does NOT touch loadInformation.parsedHcr/parsedTripNumber — those columns
 * are read-only projections maintained by the calling mutation until Phase 5
 * drops them entirely.
 *
 * Safe to call concurrently: Convex OCC will retry on conflict and the
 * upsert-on-ensure semantics make the retry idempotent.
 */
export async function setLoadTag(
  ctx: MutationCtx,
  args: SetLoadTagArgs,
): Promise<void> {
  const { loadId, workosOrgId, facetKey, value, firstStopDate } = args;

  const existing = await ctx.db
    .query('loadTags')
    .withIndex('by_load_key', (q) =>
      q.eq('loadId', loadId).eq('facetKey', facetKey),
    )
    .unique();

  const shouldRegister =
    value !== undefined &&
    value !== null &&
    isRegisterableValue(value);

  if (!shouldRegister) {
    if (existing) await ctx.db.delete(existing._id);
    return;
  }

  const canonical = canonicalizeFacetValue(value!);
  const display = value!.trim();

  if (existing && existing.canonicalValue === canonical) {
    // Value unchanged; refresh only firstStopDate if the load's date moved.
    if (existing.firstStopDate !== firstStopDate) {
      await ctx.db.patch(existing._id, { firstStopDate });
    }
    return;
  }

  if (existing) {
    await ctx.db.delete(existing._id);
  }

  await ctx.db.insert('loadTags', {
    workosOrgId,
    loadId,
    facetKey,
    canonicalValue: canonical,
    value: display,
    firstStopDate,
  });

  await ensureFacetValue(ctx, workosOrgId, facetKey, canonical, display);
}

/**
 * Remove all tags for a load (called from load delete paths).
 *
 * facetValues rows are NOT cleaned up here — that's the nightly cron's job.
 * This keeps the delete path cheap and avoids OCC hotspots on shared values.
 */
export async function removeAllTagsForLoad(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
): Promise<void> {
  const tags = await ctx.db
    .query('loadTags')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();
  for (const tag of tags) {
    await ctx.db.delete(tag._id);
  }
}

/**
 * Propagate a load's firstStopDate change to its tags.
 *
 * Called by the load-update write path when stops change. Without this the
 * by_org_key_canonical_date index goes stale and paginated facet filters
 * return wrong results.
 */
export async function syncFirstStopDateToTags(
  ctx: MutationCtx,
  loadId: Id<'loadInformation'>,
  firstStopDate: string | undefined,
): Promise<void> {
  const tags = await ctx.db
    .query('loadTags')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();
  for (const tag of tags) {
    if (tag.firstStopDate !== firstStopDate) {
      await ctx.db.patch(tag._id, { firstStopDate });
    }
  }
}

/**
 * Idempotent upsert into facetValues for dropdown display.
 *
 * No refcount: presence-only. Pruned by the nightly cron when no loadTags
 * reference the value any longer. This avoids OCC hotspots on hot values
 * (e.g. a frequently-synced HCR) at the cost of up to 24h dropdown staleness
 * after the last load with that value is deleted — acceptable for a filter.
 */
async function ensureFacetValue(
  ctx: MutationCtx,
  workosOrgId: string,
  facetKey: string,
  canonicalValue: string,
  displayValue: string,
): Promise<void> {
  const existing = await ctx.db
    .query('facetValues')
    .withIndex('by_org_key_canonical', (q) =>
      q
        .eq('workosOrgId', workosOrgId)
        .eq('facetKey', facetKey)
        .eq('canonicalValue', canonicalValue),
    )
    .unique();

  if (existing) return;

  await ctx.db.insert('facetValues', {
    workosOrgId,
    facetKey,
    canonicalValue,
    value: displayValue,
    firstSeenAt: Date.now(),
  });
}

/**
 * Read the HCR + TRIP facet values for a load.
 *
 * Replaces `load.parsedHcr` / `load.parsedTripNumber` column reads across
 * the codebase. Phase 5 drops the columns; centralizing the lookup here
 * means any future tweak (caching, additional facets) is a one-place change.
 *
 * Returns both display value and canonical value so callers matching
 * against other canonical inputs don't need to canonicalize again.
 */
export async function getLoadFacets(
  ctx: QueryCtx | MutationCtx,
  loadId: Id<'loadInformation'>,
): Promise<{
  hcr?: string;
  trip?: string;
  hcrCanonical?: string;
  tripCanonical?: string;
  /** Every facet tag on this load, in insertion order. Used by UIs that
   *  want to show all facets instead of just HCR + TRIP. */
  all: Array<{ key: string; value: string }>;
}> {
  const tags = await ctx.db
    .query('loadTags')
    .withIndex('by_load', (q) => q.eq('loadId', loadId))
    .collect();
  const hcrTag = tags.find((t) => t.facetKey === 'HCR');
  const tripTag = tags.find((t) => t.facetKey === 'TRIP');
  return {
    hcr: hcrTag?.value,
    trip: tripTag?.value,
    hcrCanonical: hcrTag?.canonicalValue,
    tripCanonical: tripTag?.canonicalValue,
    all: tags.map((t) => ({ key: t.facetKey, value: t.value })),
  };
}

/**
 * Find loadIds matching a specific (org, hcr, trip) combination.
 *
 * Replaces the `by_hcr_trip` index lookup on `loadInformation`. Callers
 * supply the hcr and trip values as-given (canonicalization happens here)
 * and receive loadIds they can `ctx.db.get` to fetch load docs.
 *
 * - If `hcr` is provided: uses the HCR tag index as primary, then filters
 *   by TRIP per-load if also provided.
 * - If only `trip` is provided: uses the TRIP tag index.
 * - If neither: returns [] (callers should query loadInformation directly).
 */
export async function findLoadIdsByFacets(
  ctx: QueryCtx | MutationCtx,
  args: {
    workosOrgId: string;
    hcr?: string | null;
    trip?: string | null;
  },
): Promise<Array<Id<'loadInformation'>>> {
  const canonicalHcr = args.hcr
    ? canonicalizeFacetValue(args.hcr)
    : undefined;
  const canonicalTrip = args.trip
    ? canonicalizeFacetValue(args.trip)
    : undefined;

  if (!canonicalHcr && !canonicalTrip) return [];

  // Pick the smaller expected set as primary. In typical data trips are
  // more numerous per-org (~566 distinct) than HCRs (~9), so an individual
  // trip filter is typically more selective — prefer trip when both given.
  const primaryKey =
    canonicalHcr && canonicalTrip ? 'TRIP' : canonicalHcr ? 'HCR' : 'TRIP';
  const primaryValue = primaryKey === 'HCR' ? canonicalHcr! : canonicalTrip!;

  const primaryTags = await ctx.db
    .query('loadTags')
    .withIndex('by_org_key_canonical_date', (q) =>
      q
        .eq('workosOrgId', args.workosOrgId)
        .eq('facetKey', primaryKey)
        .eq('canonicalValue', primaryValue),
    )
    .collect();

  if (!(canonicalHcr && canonicalTrip)) {
    return primaryTags.map((t) => t.loadId);
  }

  // Combined filter: verify secondary per-load.
  const secondaryKey = primaryKey === 'HCR' ? 'TRIP' : 'HCR';
  const secondaryValue =
    secondaryKey === 'HCR' ? canonicalHcr : canonicalTrip;
  const secondaryTags = await Promise.all(
    primaryTags.map((t) =>
      ctx.db
        .query('loadTags')
        .withIndex('by_load_key', (q) =>
          q.eq('loadId', t.loadId).eq('facetKey', secondaryKey),
        )
        .unique(),
    ),
  );
  return primaryTags
    .filter((_, i) => secondaryTags[i]?.canonicalValue === secondaryValue)
    .map((t) => t.loadId);
}

/**
 * Internal: for contract-lane writes. Registers a facet value without
 * attaching it to a specific load. Used so that a contract lane's HCR shows
 * up in the dropdown even when no loads have been created for it yet.
 *
 * Wildcards skipped. Idempotent.
 */
export async function registerContractLaneFacet(
  ctx: MutationCtx,
  workosOrgId: string,
  facetKey: string,
  value: string | undefined | null,
): Promise<void> {
  if (value === undefined || value === null) return;
  if (!isRegisterableValue(value)) return;
  const canonical = canonicalizeFacetValue(value);
  const display = value.trim();
  await ensureFacetValue(ctx, workosOrgId, facetKey, canonical, display);
}
