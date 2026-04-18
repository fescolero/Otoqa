import { internalMutation } from '../_generated/server';

/**
 * Migration: bootstrap facetDefinitions (HCR + TRIP) for every existing org.
 *
 * Idempotent — safe to re-run. Only inserts rows that don't already exist.
 *
 * Run with:
 *   npx convex run migrations/004_bootstrap_facet_definitions:bootstrapFacetDefinitions
 */

const BUILTIN_FACETS: Array<{ key: string; label: string }> = [
  { key: 'HCR', label: 'HCR' },
  { key: 'TRIP', label: 'Trip Number' },
];

export const bootstrapFacetDefinitions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const orgs = await ctx.db.query('organizations').collect();

    let orgsProcessed = 0;
    let inserted = 0;
    let skipped = 0;

    for (const org of orgs) {
      const orgId = org.workosOrgId;
      if (!orgId) {
        skipped++;
        continue;
      }

      for (const facet of BUILTIN_FACETS) {
        const existing = await ctx.db
          .query('facetDefinitions')
          .withIndex('by_org_key', (q) =>
            q.eq('workosOrgId', orgId).eq('key', facet.key),
          )
          .unique();

        if (existing) {
          skipped++;
          continue;
        }

        await ctx.db.insert('facetDefinitions', {
          workosOrgId: orgId,
          key: facet.key,
          label: facet.label,
          isFilterable: true,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        inserted++;
      }
      orgsProcessed++;
    }

    console.log(
      `[bootstrapFacetDefinitions] orgs=${orgsProcessed} inserted=${inserted} skipped=${skipped}`,
    );
    return { orgsProcessed, inserted, skipped };
  },
});
