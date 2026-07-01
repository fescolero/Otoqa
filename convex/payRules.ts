// Pay Rules — public-facing CRUD for individual rate-line items inside a
// pay profile. Each mutation re-verifies that the caller's org owns the
// parent profile before allowing edits.
//
// Naming: matches the design's "rate line item" concept. Replaces the legacy
// rateRules.ts surface for new-engine orgs.

import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireCallerIdentity } from './lib/auth';

// ============================================================================
// QUERIES
// ============================================================================

export const listForProfile = query({
  args: {
    profileId: v.id('payProfiles'),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, { profileId, includeInactive }) => {
    const { orgId } = await requireCallerIdentity(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile || profile.workosOrgId !== orgId) return [];

    const rules = await ctx.db
      .query('payRules')
      .withIndex('by_profile_active', q => q.eq('profileId', profileId))
      .collect();
    const filtered = includeInactive ? rules : rules.filter(r => r.isActive);
    return filtered.sort((a, b) => a.sortOrder - b.sortOrder);
  },
});

// ============================================================================
// MUTATIONS
// ============================================================================

// Shared validators for the rule shape
const triggerValidator = v.object({
  source: v.string(),
  transform: v.optional(v.union(
    v.literal('IDENTITY'),
    v.literal('HOURS_FROM_MINUTES'),
    v.literal('COUNT'),
    v.literal('SUM'),
    v.literal('PERCENT'),
  )),
  filter: v.optional(v.string()),
});

const tierValidator = v.object({
  minQty: v.number(),
  maxQty: v.optional(v.number()),
  rateMicroCents: v.int64(),
});

export const addRule = mutation({
  args: {
    profileId: v.id('payProfiles'),
    name: v.string(),
    componentId: v.id('chargeComponents'),
    trigger: triggerValidator,
    rateAmountMicroCents: v.optional(v.int64()),
    tieredRate: v.optional(v.array(tierValidator)),
    minThreshold: v.optional(v.number()),
    maxCap: v.optional(v.number()),
    minAmountCents: v.optional(v.int64()),
    maxAmountCents: v.optional(v.int64()),
    equipmentTypeCondition: v.optional(v.string()),
    customerCondition: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('Pay profile not found');
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    // Also verify the component belongs to the same org
    const component = await ctx.db.get(args.componentId);
    if (!component) throw new Error('Charge component not found');
    if (component.workosOrgId !== orgId) throw new Error('Charge component belongs to a different organization');

    if (args.rateAmountMicroCents === undefined && (!args.tieredRate || args.tieredRate.length === 0)) {
      throw new Error('Rule must have either a flat rate or a tiered rate schedule');
    }

    // Determine sort order — append to the end
    const existing = await ctx.db
      .query('payRules')
      .withIndex('by_profile_active', q => q.eq('profileId', args.profileId))
      .collect();
    const maxSort = existing.reduce((m, r) => Math.max(m, r.sortOrder), 0);

    const now = Date.now();
    const ruleId = await ctx.db.insert('payRules', {
      profileId: args.profileId,
      name: args.name,
      componentId: args.componentId,
      trigger: args.trigger,
      rateAmountMicroCents: args.rateAmountMicroCents,
      tieredRate: args.tieredRate,
      minThreshold: args.minThreshold,
      maxCap: args.maxCap,
      minAmountCents: args.minAmountCents,
      maxAmountCents: args.maxAmountCents,
      equipmentTypeCondition: args.equipmentTypeCondition,
      customerCondition: args.customerCondition,
      isActive: true,
      sortOrder: maxSort + 1,
      createdAt: now,
      updatedAt: now,
      createdBy: userId,
    });

    await ctx.db.patch(args.profileId, { updatedAt: now });

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payRule',
      entityId: ruleId,
      entityName: args.name,
      action: 'created',
      description: `Added rule "${args.name}" to profile "${profile.name}"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });

    return ruleId;
  },
});

export const updateRule = mutation({
  args: {
    ruleId: v.id('payRules'),
    patch: v.object({
      name: v.optional(v.string()),
      componentId: v.optional(v.id('chargeComponents')),
      trigger: v.optional(triggerValidator),
      rateAmountMicroCents: v.optional(v.int64()),
      tieredRate: v.optional(v.array(tierValidator)),
      minThreshold: v.optional(v.number()),
      maxCap: v.optional(v.number()),
      minAmountCents: v.optional(v.int64()),
      maxAmountCents: v.optional(v.int64()),
      equipmentTypeCondition: v.optional(v.string()),
      customerCondition: v.optional(v.string()),
      isActive: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, { ruleId, patch }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const rule = await ctx.db.get(ruleId);
    if (!rule) throw new Error('Pay rule not found');
    const profile = await ctx.db.get(rule.profileId);
    if (!profile) throw new Error('Parent pay profile not found');
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    if (patch.componentId) {
      const component = await ctx.db.get(patch.componentId);
      if (!component) throw new Error('Charge component not found');
      if (component.workosOrgId !== orgId) throw new Error('Charge component belongs to a different organization');
    }

    const now = Date.now();
    const cleaned = stripUndefined(patch);
    await ctx.db.patch(ruleId, { ...cleaned, updatedAt: now });
    await ctx.db.patch(profile._id, { updatedAt: now });

    const changedKeys = Object.keys(cleaned);
    if (changedKeys.length > 0) {
      await ctx.db.insert('auditLog', {
        organizationId: orgId,
        entityType: 'payRule',
        entityId: ruleId,
        entityName: rule.name,
        action: 'updated',
        description: describeRuleUpdate(rule, cleaned),
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        changedFields: changedKeys,
        timestamp: now,
      });
    }
  },
});

export const removeRule = mutation({
  args: { ruleId: v.id('payRules') },
  handler: async (ctx, { ruleId }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const rule = await ctx.db.get(ruleId);
    if (!rule) return;
    const profile = await ctx.db.get(rule.profileId);
    if (!profile) return;
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    const now = Date.now();
    // Soft-deactivate rather than hard-delete — preserves audit trail and
    // any historical payItems that point to this rule.
    await ctx.db.patch(ruleId, { isActive: false, updatedAt: now });
    await ctx.db.patch(profile._id, { updatedAt: now });

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payRule',
      entityId: ruleId,
      entityName: rule.name,
      action: 'archived',
      description: `Removed rule "${rule.name}" from profile "${profile.name}"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });
  },
});

/** Reorder rules within a profile. Caller passes the full ordered list of
 *  rule ids; we patch each with its new sortOrder. */
export const reorder = mutation({
  args: {
    profileId: v.id('payProfiles'),
    orderedRuleIds: v.array(v.id('payRules')),
  },
  handler: async (ctx, { profileId, orderedRuleIds }) => {
    const { orgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const profile = await ctx.db.get(profileId);
    if (!profile) throw new Error('Pay profile not found');
    if (profile.workosOrgId !== orgId) throw new Error('Not authorized for this organization');

    const now = Date.now();
    for (let i = 0; i < orderedRuleIds.length; i++) {
      const rule = await ctx.db.get(orderedRuleIds[i]);
      if (!rule || rule.profileId !== profileId) continue;
      if (rule.sortOrder !== i + 1) {
        await ctx.db.patch(rule._id, { sortOrder: i + 1, updatedAt: now });
      }
    }
    await ctx.db.patch(profileId, { updatedAt: now });

    await ctx.db.insert('auditLog', {
      organizationId: orgId,
      entityType: 'payProfile',
      entityId: profileId,
      entityName: profile.name,
      action: 'updated',
      description: `Reordered rules on profile "${profile.name}"`,
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      timestamp: now,
    });
  },
});

// ============================================================================
// HELPERS
// ============================================================================

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Build a readable description for a rule update. Surfaces the most useful
 *  change ("Raised rate" / "Set distance to After 50 mi") rather than a
 *  generic field list. */
function describeRuleUpdate(
  before: {
    name: string;
    rateAmountMicroCents?: bigint;
    minThreshold?: number;
    trigger: { source: string; filter?: string };
  },
  cleaned: Record<string, unknown>,
): string {
  const parts: string[] = [];
  if ('name' in cleaned && cleaned.name !== before.name) {
    parts.push(`Renamed "${before.name}" → "${cleaned.name}"`);
  }
  if ('rateAmountMicroCents' in cleaned && cleaned.rateAmountMicroCents !== before.rateAmountMicroCents) {
    const beforeDisplay = formatRateMicroCentsForAudit(before.rateAmountMicroCents);
    const afterDisplay = formatRateMicroCentsForAudit(cleaned.rateAmountMicroCents as bigint | undefined);
    parts.push(`Rate ${beforeDisplay} → ${afterDisplay}`);
  }
  if ('trigger' in cleaned) {
    const trig = cleaned.trigger as { source: string; transform?: string; filter?: string };
    if (trig.source !== before.trigger.source) {
      parts.push(`Trigger source ${before.trigger.source} → ${trig.source}`);
    }
    if (trig.filter !== before.trigger.filter) {
      parts.push(trig.filter ? `Filter: ${trig.filter}` : 'Cleared filter');
    }
  }
  if ('minThreshold' in cleaned) {
    parts.push(
      cleaned.minThreshold !== undefined
        ? `Distance ≥ ${cleaned.minThreshold} mi`
        : 'Cleared distance threshold',
    );
  }
  if ('isActive' in cleaned) {
    parts.push(cleaned.isActive ? 'Reactivated' : 'Deactivated');
  }
  if (parts.length === 0) return `Updated rule "${before.name}"`;
  return `Rule "${before.name}": ${parts.join(' · ')}`;
}

function formatRateMicroCentsForAudit(v: bigint | undefined): string {
  if (v === undefined) return '—';
  // Heuristic: values >= 10_000_000 are likely micro-pct-points (5% = 5M);
  // otherwise treat as microcents.
  const n = Number(v);
  if (n >= 10_000_000) return `${(n / 1_000_000).toFixed(2)}%`;
  return `$${(n / 100_000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
}
