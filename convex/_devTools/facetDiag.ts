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
    // by_internal_id is (workosOrgId, internalId); iterate the small
    // organizations table to supply the org — indexed point lookups only.
    // (internalId is FK-<loadNumber>, NOT FK-<shipment id>, so the
    // by_external_id index can't find it.)
    const orgs = await ctx.db.query('organizations').collect();
    const orgIds = [
      ...new Set(
        orgs.flatMap((o) => [o.workosOrgId, o.clerkOrgId]).filter((x): x is string => !!x),
      ),
    ];
    const loads = [];
    for (const orgId of orgIds) {
      const hits = await ctx.db
        .query('loadInformation')
        .withIndex('by_internal_id', (q) =>
          q.eq('workosOrgId', orgId).eq('internalId', args.internalId),
        )
        .collect();
      loads.push(...hits);
    }
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
