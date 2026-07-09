// Public-facing CRUD for the chargeComponents catalog.
//
// v1 surface: list + lookup-by-code. The seeded catalog is the source of
// truth for the rate-line picker — every new payRule resolves its
// componentId via getByCode(workosOrgId, code).

import { v } from 'convex/values';
import { query } from './_generated/server';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';

/** List every chargeComponent in the caller's org. Used by the future
 *  catalog viewer and by the rate-line type picker. */
export const listForOrg = query({
  args: {
    workosOrgId: v.string(),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, { workosOrgId, includeInactive }) => {
    await assertCallerOwnsOrg(ctx, workosOrgId);
    const rows = await ctx.db
      .query('chargeComponents')
      .withIndex('by_org_active', q => q.eq('workosOrgId', workosOrgId))
      .collect();
    return includeInactive ? rows : rows.filter(r => r.isActive);
  },
});

/** Resolve a single chargeComponent by its org-scoped code.
 *  Returns null when not found OR caller is not in that org. */
export const getByCode = query({
  args: {
    workosOrgId: v.string(),
    code: v.string(),
  },
  handler: async (ctx, { workosOrgId, code }) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    if (callerOrgId !== workosOrgId) return null;
    const row = await ctx.db
      .query('chargeComponents')
      .withIndex('by_org_code', q =>
        q.eq('workosOrgId', workosOrgId).eq('code', code))
      .unique();
    return row;
  },
});
