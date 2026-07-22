// Pay-engine: payeeProfileAssignments — links drivers + carriers to their
// payProfiles, with selection-strategy metadata for multi-profile cases
// (jurisdiction/contract overrides).
//
// One payee can have multiple active assignments. The one with isDefault=true
// is the fallback when no override applies. Setting a new default
// automatically clears the prior default in a single mutation.

import { v } from 'convex/values';
import { mutation, query, type MutationCtx } from './_generated/server';
import { requireCallerIdentity } from './lib/auth';
import type { Id } from './_generated/dataModel';

/** Assignment changes count as profile activity: bump the linked profile's
 *  updatedAt/updatedBy so the list's "Updated" column reflects who changed
 *  the roster, not just who last edited rates. */
async function touchProfile(
  ctx: MutationCtx,
  profileId: Id<'payProfiles'>,
  userId: string,
  now: number,
) {
  const profile = await ctx.db.get(profileId);
  if (profile) await ctx.db.patch(profileId, { updatedAt: now, updatedBy: userId });
}

// ============================================================================
// QUERIES
// ============================================================================

/** Active assignments for one payee, enriched with the linked profile's
 *  name/payBasis/currency/state. Returns [] if caller is not in the same org
 *  as the payee. */
export const listForPayee = query({
  args: {
    payeeType: v.union(v.literal('DRIVER'), v.literal('CARRIER')),
    payeeId: v.string(),
  },
  handler: async (ctx, { payeeType, payeeId }) => {
    const { orgId } = await requireCallerIdentity(ctx);

    const assignments = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_payee_active', q =>
        q.eq('payeeType', payeeType).eq('payeeId', payeeId).eq('isActive', true))
      .collect();

    const filtered = assignments.filter(a => a.workosOrgId === orgId);

    const enriched = [];
    for (const a of filtered) {
      const profile = await ctx.db.get(a.profileId);
      if (!profile) continue;
      const rules = await ctx.db
        .query('payRules')
        .withIndex('by_profile_active', q =>
          q.eq('profileId', profile._id).eq('isActive', true))
        .collect();
      enriched.push({
        ...a,
        profileName: profile.name,
        profilePayBasis: profile.payBasis,
        profileCurrency: profile.currency,
        profileState: profile.state,
        profileContractTag: profile.contractTag,
        profileIsActive: profile.isActive,
        ruleCount: rules.length,
        rules: rules.sort((x, y) => x.sortOrder - y.sortOrder),
      });
    }

    // Default first, then by createdAt desc
    enriched.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return b.createdAt - a.createdAt;
    });
    return enriched;
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

const selectionStrategyValidator = v.union(
  v.literal('ALWAYS_ACTIVE'),
  v.literal('DISTANCE_THRESHOLD'),
  v.literal('JURISDICTION'),
  v.literal('MANUAL_ONLY'),
);

export const assign = mutation({
  args: {
    payeeType: v.union(v.literal('DRIVER'), v.literal('CARRIER')),
    payeeId: v.string(),
    profileId: v.id('payProfiles'),
    isDefault: v.optional(v.boolean()),
    selectionStrategy: v.optional(selectionStrategyValidator),
    matchState: v.optional(v.string()),
    matchContractTag: v.optional(v.string()),
    thresholdValue: v.optional(v.number()),
    effectiveStart: v.optional(v.number()),
    effectiveEnd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('Pay profile not found');
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    // Profile must match the payeeType (a DRIVER profile can't be assigned
    // to a CARRIER and vice versa). This is the contract that keeps calc
    // semantics correct.
    if (profile.payeeType !== args.payeeType) {
      throw new Error(
        `Profile is for ${profile.payeeType}; cannot assign to a ${args.payeeType}`,
      );
    }

    // Block exact duplicates (same payee + same profile already active).
    const existing = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_payee_active', q =>
        q.eq('payeeType', args.payeeType).eq('payeeId', args.payeeId).eq('isActive', true))
      .collect();
    if (existing.some(e => e.profileId === args.profileId)) {
      throw new Error('Payee is already assigned to this profile');
    }

    const now = Date.now();

    // If marked default, clear any prior default for this payee in the same
    // mutation — only one default at a time per payee.
    if (args.isDefault) {
      for (const e of existing) {
        if (e.isDefault) {
          await ctx.db.patch(e._id, { isDefault: false, updatedAt: now });
        }
      }
    }

    const assignmentId = await ctx.db.insert('payeeProfileAssignments', {
      workosOrgId: orgId,
      payeeType: args.payeeType,
      payeeId: args.payeeId,
      profileId: args.profileId,
      isDefault: args.isDefault ?? existing.length === 0,  // first assignment becomes default
      selectionStrategy: args.selectionStrategy ?? 'ALWAYS_ACTIVE',
      matchState: args.matchState,
      matchContractTag: args.matchContractTag,
      thresholdValue: args.thresholdValue,
      effectiveStart: args.effectiveStart,
      effectiveEnd: args.effectiveEnd,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
    });

    await touchProfile(ctx, args.profileId, userId, now);

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payeeProfileAssignment',
      entityId: assignmentId,
      entityName: profile.name,
      action: 'assigned',
      description: `Assigned ${args.payeeType.toLowerCase()} to pay profile "${profile.name}"${args.isDefault ? ' (default)' : ''}`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });

    return assignmentId;
  },
});

export const setDefault = mutation({
  args: { assignmentId: v.id('payeeProfileAssignments') },
  handler: async (ctx, { assignmentId }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const target = await ctx.db.get(assignmentId);
    if (!target) throw new Error('Assignment not found');
    if (target.workosOrgId !== orgId) throw new Error('Not authorized for this organization');
    if (!target.isActive) throw new Error('Cannot set an inactive assignment as default');

    const now = Date.now();

    // Clear prior default for this payee
    const peers = await ctx.db
      .query('payeeProfileAssignments')
      .withIndex('by_payee_active', q =>
        q.eq('payeeType', target.payeeType).eq('payeeId', target.payeeId).eq('isActive', true))
      .collect();
    for (const p of peers) {
      if (p._id === assignmentId) continue;
      if (p.isDefault) {
        await ctx.db.patch(p._id, { isDefault: false, updatedAt: now });
      }
    }

    await ctx.db.patch(assignmentId, { isDefault: true, updatedAt: now });
    await touchProfile(ctx, target.profileId, userId, now);

    const profile = await ctx.db.get(target.profileId);
    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payeeProfileAssignment',
      entityId: assignmentId,
      entityName: profile?.name,
      action: 'set_default',
      description: `Set "${profile?.name ?? 'profile'}" as default for this ${target.payeeType.toLowerCase()}`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });
  },
});

export const unassign = mutation({
  args: { assignmentId: v.id('payeeProfileAssignments') },
  handler: async (ctx, { assignmentId }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const target = await ctx.db.get(assignmentId);
    if (!target) return;
    if (target.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    const now = Date.now();
    await ctx.db.patch(assignmentId, { isActive: false, updatedAt: now });

    // If this was the default, promote another active assignment to default
    // so the payee isn't left without one.
    if (target.isDefault) {
      const remaining = await ctx.db
        .query('payeeProfileAssignments')
        .withIndex('by_payee_active', q =>
          q.eq('payeeType', target.payeeType).eq('payeeId', target.payeeId).eq('isActive', true))
        .collect();
      const candidates = remaining.filter(r => r._id !== assignmentId);
      if (candidates.length > 0) {
        // Sort by createdAt asc — promote the oldest
        candidates.sort((a, b) => a.createdAt - b.createdAt);
        await ctx.db.patch(candidates[0]._id, { isDefault: true, updatedAt: now });
      }
    }

    await touchProfile(ctx, target.profileId, userId, now);

    const profile = await ctx.db.get(target.profileId);
    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payeeProfileAssignment',
      entityId: assignmentId,
      entityName: profile?.name,
      action: 'unassigned',
      description: `Unassigned ${target.payeeType.toLowerCase()} from pay profile "${profile?.name ?? '—'}"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });
  },
});

/** Update selection-strategy parameters on an existing assignment. Useful
 *  for tweaking JURISDICTION matchers or DISTANCE_THRESHOLD values without
 *  recreating the assignment. */
export const updateStrategy = mutation({
  args: {
    assignmentId: v.id('payeeProfileAssignments'),
    patch: v.object({
      selectionStrategy: v.optional(selectionStrategyValidator),
      matchState: v.optional(v.string()),
      matchContractTag: v.optional(v.string()),
      thresholdValue: v.optional(v.number()),
      effectiveStart: v.optional(v.number()),
      effectiveEnd: v.optional(v.number()),
    }),
  },
  handler: async (ctx, { assignmentId, patch }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const target = await ctx.db.get(assignmentId);
    if (!target) throw new Error('Assignment not found');
    if (target.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    const now = Date.now();
    const cleaned: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(patch)) {
      if (val !== undefined) cleaned[k] = val;
    }
    if (Object.keys(cleaned).length === 0) return;

    await ctx.db.patch(assignmentId, { ...cleaned, updatedAt: now });
    await touchProfile(ctx, target.profileId, userId, now);

    const profile = await ctx.db.get(target.profileId);
    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payeeProfileAssignment',
      entityId: assignmentId,
      entityName: profile?.name,
      action: 'updated',
      description: `Updated assignment strategy for "${profile?.name ?? 'profile'}"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      changedFields: Object.keys(cleaned),
      timestamp: now,
    });
  },
});
