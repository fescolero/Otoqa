import { v } from 'convex/values';
import { internalQuery } from '../_generated/server';
import { getLoadFacets } from '../lib/loadFacets';

/**
 * One-shot diagnostic for "why doesn't this load show HCR/Trip chips".
 *
 * Run (dev deployment):
 *   npx convex run _devTools/facetDiag:forInternalId '{"internalId":"FK-109589035"}'
 *
 * Prints, for every load matching that internalId: the load id, org, and
 * exactly what getLoadFacets returns — the same call the dispatch-app
 * queries (listActiveAssignments / listOffers) use to fill the chips.
 * Empty facets here = no loadTags rows for that load; populated facets
 * here but no chips in the app = stale deployed dispatchMobile functions
 * or a stale app bundle.
 */
export const forInternalId = internalQuery({
  args: { internalId: v.string() },
  handler: async (ctx, args) => {
    // internalId is only indexed together with org; a full scan is fine
    // for a diagnostic on this table size.
    const loads = (await ctx.db.query('loadInformation').collect()).filter(
      (l) => l.internalId === args.internalId,
    );
    const out = [];
    for (const load of loads) {
      const tagRows = await ctx.db
        .query('loadTags')
        .withIndex('by_load', (q) => q.eq('loadId', load._id))
        .collect();
      out.push({
        loadId: load._id,
        workosOrgId: load.workosOrgId,
        facets: await getLoadFacets(ctx, load._id),
        rawTagRows: tagRows.map((t) => ({
          facetKey: t.facetKey,
          value: t.value,
          canonicalValue: t.canonicalValue,
        })),
      });
    }
    return { matches: out.length, loads: out };
  },
});
