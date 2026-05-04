/**
 * Saved Views — list table view presets per entity.
 *
 * Three flavors:
 *   - system: code-only defaults (e.g. "All Drivers", "Active") declared
 *             on the page. Not stored in this table.
 *   - user:   per-user views, only visible to the owning user.
 *   - org:    org-wide views, visible to everyone in the org. Anyone in
 *             the org can create them; only the org's admins should be
 *             able to delete them. (Authorization for "admin" lives in
 *             WorkOS; this module fail-closes on org membership only.)
 *
 * The shape of `filters` / `sort` / `visibleColumns` is opaque to this
 * module — the page that owns the entity (e.g. drivers list) interprets
 * them.
 */

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireCallerIdentity } from './lib/auth';

const scopeValidator = v.union(v.literal('user'), v.literal('org'));
const sortValidator = v.object({
  key: v.string(),
  dir: v.union(v.literal('asc'), v.literal('desc')),
});

/**
 * List all saved views visible to the caller for a given entity.
 * Returns user-owned and org-shared views; system defaults live in code.
 */
export const listForEntity = query({
  args: { entity: v.string() },
  handler: async (ctx, { entity }) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);

    const allOrg = await ctx.db
      .query('savedViews')
      .withIndex('by_org_entity', (q) => q.eq('workosOrgId', orgId).eq('entity', entity))
      .collect();

    return {
      user: allOrg.filter((v) => v.scope === 'user' && v.ownerId === userId),
      org: allOrg.filter((v) => v.scope === 'org'),
    };
  },
});

export const createView = mutation({
  args: {
    entity: v.string(),
    name: v.string(),
    scope: scopeValidator,
    filters: v.optional(v.any()),
    sort: v.optional(sortValidator),
    visibleColumns: v.optional(v.array(v.string())),
    isDefault: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const now = Date.now();

    // Only one default per (org, entity, scope) — clear any existing default
    // before flagging this one.
    if (args.isDefault) {
      await clearDefaultsFor(ctx, {
        orgId,
        entity: args.entity,
        scope: args.scope,
        userId,
      });
    }

    return await ctx.db.insert('savedViews', {
      workosOrgId: orgId,
      entity: args.entity,
      name: args.name,
      scope: args.scope,
      ownerId: args.scope === 'user' ? userId : undefined,
      filters: args.filters,
      sort: args.sort,
      visibleColumns: args.visibleColumns,
      isDefault: args.isDefault ?? false,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateView = mutation({
  args: {
    id: v.id('savedViews'),
    name: v.optional(v.string()),
    filters: v.optional(v.any()),
    sort: v.optional(sortValidator),
    visibleColumns: v.optional(v.array(v.string())),
    isDefault: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const view = await ctx.db.get(args.id);
    if (!view) throw new Error('View not found');
    if (view.workosOrgId !== orgId) throw new Error('Not authorized for this view');
    if (view.scope === 'user' && view.ownerId !== userId) {
      throw new Error('Not authorized for this view');
    }

    if (args.isDefault) {
      await clearDefaultsFor(ctx, {
        orgId,
        entity: view.entity,
        scope: view.scope,
        userId,
        skipId: args.id,
      });
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) patch.name = args.name;
    if (args.filters !== undefined) patch.filters = args.filters;
    if (args.sort !== undefined) patch.sort = args.sort;
    if (args.visibleColumns !== undefined) patch.visibleColumns = args.visibleColumns;
    if (args.isDefault !== undefined) patch.isDefault = args.isDefault;

    await ctx.db.patch(args.id, patch);
    return args.id;
  },
});

export const deleteView = mutation({
  args: { id: v.id('savedViews') },
  handler: async (ctx, { id }) => {
    const { orgId, userId } = await requireCallerIdentity(ctx);
    const view = await ctx.db.get(id);
    if (!view) return;
    if (view.workosOrgId !== orgId) throw new Error('Not authorized for this view');
    if (view.scope === 'user' && view.ownerId !== userId) {
      throw new Error('Not authorized for this view');
    }
    await ctx.db.delete(id);
  },
});

// Helper: clear other isDefault flags in the same (org, entity, scope).
async function clearDefaultsFor(
  ctx: { db: import('./_generated/server').MutationCtx['db'] },
  {
    orgId,
    entity,
    scope,
    userId,
    skipId,
  }: {
    orgId: string;
    entity: string;
    scope: 'user' | 'org';
    userId: string;
    skipId?: import('./_generated/dataModel').Id<'savedViews'>;
  },
) {
  const candidates = await ctx.db
    .query('savedViews')
    .withIndex('by_org_entity', (q) => q.eq('workosOrgId', orgId).eq('entity', entity))
    .collect();
  for (const v of candidates) {
    if (skipId && v._id === skipId) continue;
    if (v.scope !== scope) continue;
    if (scope === 'user' && v.ownerId !== userId) continue;
    if (v.isDefault) {
      await ctx.db.patch(v._id, { isDefault: false, updatedAt: Date.now() });
    }
  }
}
