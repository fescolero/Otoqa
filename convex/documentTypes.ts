/**
 * Settings › Documents — the per-org half of the documents catalog.
 *
 * System types are code constants (lib/documentTypeDefaults.ts). This
 * module lets an org override a system type's editable flags, hide it,
 * or add custom types. Every change recomputes the affected entities'
 * missing-document summaries (documents-storage-spec.md §2, "Changing a
 * type's flags after documents exist").
 *
 * Permission: settings:manage for every write; any org member may read.
 */

import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { mutation, query } from './_generated/server';
import { assertOrgPermission, requireCallerOrgId } from './lib/auth';
import { logAudit } from './lib/audit';
import {
  documentEntityValidator,
  effectiveDocumentTypeValidator,
  loadEffectiveCatalog,
} from './lib/documentCatalog';
import {
  CUSTOM_TYPE_KEY_PATTERN,
  systemTypeByKey,
  type DocumentEntity,
} from './lib/documentTypeDefaults';

const WRITE_SLUG = 'settings:manage';

export const effectiveCatalog = query({
  args: {
    entity: v.optional(documentEntityValidator),
  },
  returns: v.array(effectiveDocumentTypeValidator),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    return loadEffectiveCatalog(ctx, orgId, args.entity);
  },
});

async function findRow(ctx: { db: import('./_generated/server').MutationCtx['db'] }, orgId: string, key: string) {
  return ctx.db
    .query('documentTypes')
    .withIndex('by_org_key', (q) => q.eq('workosOrgId', orgId).eq('key', key))
    .first();
}

function scheduleSummaryRecompute(
  ctx: import('./_generated/server').MutationCtx,
  orgId: string,
  entity: DocumentEntity,
) {
  // Flag changes can flip Missing for every entity of that kind. Done out
  // of band so the settings save stays snappy on large fleets.
  return ctx.scheduler.runAfter(0, internal.entityDocuments.recomputeSummariesForOrg, {
    orgId,
    entity,
  });
}

/**
 * Override editable flags of a system type. Only the provided fields are
 * stored; unset fields keep the code default (and follow it if the
 * default changes later).
 */
export const upsertSystemOverride = mutation({
  args: {
    key: v.string(),
    name: v.optional(v.string()),
    expires: v.optional(v.boolean()),
    issueDateRequired: v.optional(v.boolean()),
    uploadRequired: v.optional(v.boolean()),
    sharedByDefault: v.optional(v.boolean()),
    sortOrder: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const who = await assertOrgPermission(ctx, orgId, WRITE_SLUG);
    const sys = systemTypeByKey(args.key);
    if (!sys) throw new ConvexError('Unknown system document type');
    if (args.name !== undefined && !args.name.trim()) throw new ConvexError('Name is required');

    const now = Date.now();
    const existing = await findRow(ctx, orgId, args.key);
    // Only the provided fields — Convex treats an explicit `undefined` as
    // "remove", which would wipe overrides a partial call did not mention.
    const patch: Partial<Doc<'documentTypes'>> = { updatedAt: now };
    if (args.name !== undefined) patch.name = args.name.trim();
    if (args.expires !== undefined) patch.expires = args.expires;
    if (args.issueDateRequired !== undefined) patch.issueDateRequired = args.issueDateRequired;
    if (args.uploadRequired !== undefined) patch.uploadRequired = args.uploadRequired;
    if (args.sharedByDefault !== undefined && sys.entity === 'organization') patch.sharedByDefault = args.sharedByDefault;
    if (args.sortOrder !== undefined) patch.sortOrder = args.sortOrder;
    if (existing) {
      if (existing.isCustom) throw new ConvexError('Key collides with a custom type');
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert('documentTypes', {
        workosOrgId: orgId,
        key: args.key,
        entity: sys.entity,
        isCustom: false,
        ...patch,
        createdBy: who.userId,
        createdAt: now,
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: orgId,
      entityType: 'organization',
      entityId: orgId,
      action: 'updated',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `Updated document type "${args.name ?? sys.name}"`,
      changedFields: Object.keys(args).filter((k) => k !== 'key'),
    });
    await scheduleSummaryRecompute(ctx, orgId, sys.entity);
    return null;
  },
});

export const createCustomType = mutation({
  args: {
    entity: documentEntityValidator,
    key: v.string(),
    name: v.string(),
    expires: v.boolean(),
    issueDateRequired: v.boolean(),
    uploadRequired: v.boolean(),
    singleton: v.optional(v.boolean()),
    sharedByDefault: v.optional(v.boolean()),
    sortOrder: v.optional(v.number()),
  },
  returns: v.id('documentTypes'),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const who = await assertOrgPermission(ctx, orgId, WRITE_SLUG);
    const key = args.key.trim().toLowerCase();
    if (!CUSTOM_TYPE_KEY_PATTERN.test(key)) {
      throw new ConvexError('Key must be 2–40 chars of lowercase letters, digits, "_" or "-"');
    }
    if (systemTypeByKey(key)) throw new ConvexError('Key collides with a system document type');
    if (!args.name.trim()) throw new ConvexError('Name is required');
    if (await findRow(ctx, orgId, key)) throw new ConvexError('A document type with this key already exists');

    const now = Date.now();
    const id = await ctx.db.insert('documentTypes', {
      workosOrgId: orgId,
      key,
      entity: args.entity,
      isCustom: true,
      name: args.name.trim(),
      expires: args.expires,
      issueDateRequired: args.issueDateRequired,
      uploadRequired: args.uploadRequired,
      singleton: args.singleton ?? true,
      sharedByDefault: args.entity === 'organization' ? (args.sharedByDefault ?? false) : undefined,
      sortOrder: args.sortOrder,
      createdBy: who.userId,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: orgId,
      entityType: 'organization',
      entityId: orgId,
      action: 'created',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `Created document type "${args.name.trim()}"`,
    });
    await scheduleSummaryRecompute(ctx, orgId, args.entity);
    return id;
  },
});

export const updateCustomType = mutation({
  args: {
    key: v.string(),
    name: v.optional(v.string()),
    expires: v.optional(v.boolean()),
    issueDateRequired: v.optional(v.boolean()),
    uploadRequired: v.optional(v.boolean()),
    singleton: v.optional(v.boolean()),
    sharedByDefault: v.optional(v.boolean()),
    sortOrder: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const who = await assertOrgPermission(ctx, orgId, WRITE_SLUG);
    const row = await findRow(ctx, orgId, args.key);
    if (!row || !row.isCustom) throw new ConvexError('Custom document type not found');
    if (args.name !== undefined && !args.name.trim()) throw new ConvexError('Name is required');
    const { key: _key, ...rest } = args;
    void _key;
    const patch: Partial<Doc<'documentTypes'>> = { updatedAt: Date.now() };
    if (rest.name !== undefined) patch.name = rest.name.trim();
    if (rest.expires !== undefined) patch.expires = rest.expires;
    if (rest.issueDateRequired !== undefined) patch.issueDateRequired = rest.issueDateRequired;
    if (rest.uploadRequired !== undefined) patch.uploadRequired = rest.uploadRequired;
    if (rest.singleton !== undefined) patch.singleton = rest.singleton;
    if (rest.sharedByDefault !== undefined && row.entity === 'organization') patch.sharedByDefault = rest.sharedByDefault;
    if (rest.sortOrder !== undefined) patch.sortOrder = rest.sortOrder;
    await ctx.db.patch(row._id, patch);
    await logAudit(ctx, {
      organizationId: orgId,
      entityType: 'organization',
      entityId: orgId,
      action: 'updated',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `Updated document type "${rest.name ?? row.name ?? row.key}"`,
      changedFields: Object.keys(rest),
    });
    await scheduleSummaryRecompute(ctx, orgId, row.entity);
    return null;
  },
});

/** Hide or unhide any type. Hidden types keep their documents but drop
 *  out of status and the missing summary. System types can only be
 *  hidden, never deleted. */
export const setHidden = mutation({
  args: { key: v.string(), hidden: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const who = await assertOrgPermission(ctx, orgId, WRITE_SLUG);
    const sys = systemTypeByKey(args.key);
    const existing = await findRow(ctx, orgId, args.key);
    if (!sys && !existing) throw new ConvexError('Document type not found');
    const entity = (existing?.entity ?? sys?.entity) as DocumentEntity;
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { hiddenAt: args.hidden ? now : undefined, updatedAt: now });
    } else if (args.hidden) {
      await ctx.db.insert('documentTypes', {
        workosOrgId: orgId,
        key: args.key,
        entity,
        isCustom: false,
        hiddenAt: now,
        createdBy: who.userId,
        createdAt: now,
        updatedAt: now,
      });
    }
    await logAudit(ctx, {
      organizationId: orgId,
      entityType: 'organization',
      entityId: orgId,
      action: 'updated',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `${args.hidden ? 'Hid' : 'Unhid'} document type "${existing?.name ?? sys?.name ?? args.key}"`,
    });
    await scheduleSummaryRecompute(ctx, orgId, entity);
    return null;
  },
});

/** Delete a custom type — only when no document references it. */
export const deleteCustomType = mutation({
  args: { key: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const orgId = await requireCallerOrgId(ctx);
    const who = await assertOrgPermission(ctx, orgId, WRITE_SLUG);
    const row = await findRow(ctx, orgId, args.key);
    if (!row || !row.isCustom) throw new ConvexError('Custom document type not found');
    for (const status of ['pending', 'active', 'archived'] as const) {
      const ref = await ctx.db
        .query('entityDocuments')
        .withIndex('by_org_type', (q) =>
          q.eq('workosOrgId', orgId).eq('typeKey', args.key).eq('status', status),
        )
        .first();
      if (ref) throw new ConvexError('Documents exist for this type — hide it instead');
    }
    await ctx.db.delete(row._id);
    await logAudit(ctx, {
      organizationId: orgId,
      entityType: 'organization',
      entityId: orgId,
      action: 'deleted',
      performedBy: who.userId,
      performedByName: who.userName,
      performedByEmail: who.userEmail,
      description: `Deleted document type "${row.name ?? row.key}"`,
    });
    return null;
  },
});
