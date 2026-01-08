import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Rate Rules - Logic engine rules
 * "IF Trigger matches, THEN apply Rate"
 */

// Trigger event options for validation
const triggerEventValidator = v.union(
  v.literal('MILE_LOADED'),
  v.literal('MILE_EMPTY'),
  v.literal('TIME_DURATION'),
  v.literal('TIME_WAITING'),
  v.literal('COUNT_STOPS'),
  v.literal('FLAT_LOAD'),
  v.literal('FLAT_LEG'),
  v.literal('ATTR_HAZMAT'),
  v.literal('ATTR_TARP'),
  v.literal('PCT_OF_LOAD')
);

const categoryValidator = v.union(
  v.literal('BASE'),
  v.literal('ACCESSORIAL'),
  v.literal('DEDUCTION')
);

// List all rules for a profile
export const listByProfile = query({
  args: {
    profileId: v.id('rateProfiles'),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const rules = await ctx.db
      .query('rateRules')
      .withIndex('by_profile', (q) => q.eq('profileId', args.profileId))
      .collect();

    if (!args.includeInactive) {
      return rules.filter((r) => r.isActive);
    }

    return rules;
  },
});

// Get a single rule by ID
export const get = query({
  args: {
    ruleId: v.id('rateRules'),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.ruleId);
  },
});

// Create a new rate rule
export const create = mutation({
  args: {
    profileId: v.id('rateProfiles'),
    name: v.string(),
    category: categoryValidator,
    triggerEvent: triggerEventValidator,
    rateAmount: v.number(),
    minThreshold: v.optional(v.number()),
    maxCap: v.optional(v.number()),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Verify profile exists and get org ID
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('Rate profile not found');

    const ruleId = await ctx.db.insert('rateRules', {
      profileId: args.profileId,
      workosOrgId: profile.workosOrgId,
      name: args.name,
      category: args.category,
      triggerEvent: args.triggerEvent,
      rateAmount: args.rateAmount,
      minThreshold: args.minThreshold,
      maxCap: args.maxCap,
      isActive: true,
    });

    // Log the creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: profile.workosOrgId,
      entityType: 'rateRule',
      entityId: ruleId,
      entityName: args.name,
      action: 'created',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Created rate rule "${args.name}" in profile "${profile.name}"`,
    });

    return ruleId;
  },
});

// Update a rate rule
export const update = mutation({
  args: {
    ruleId: v.id('rateRules'),
    name: v.optional(v.string()),
    category: v.optional(categoryValidator),
    triggerEvent: v.optional(triggerEventValidator),
    rateAmount: v.optional(v.number()),
    minThreshold: v.optional(v.number()),
    maxCap: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) throw new Error('Rate rule not found');

    const { ruleId, userId, userName, ...updates } = args;

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.category !== undefined) updateData.category = updates.category;
    if (updates.triggerEvent !== undefined) updateData.triggerEvent = updates.triggerEvent;
    if (updates.rateAmount !== undefined) updateData.rateAmount = updates.rateAmount;
    if (updates.minThreshold !== undefined) updateData.minThreshold = updates.minThreshold;
    if (updates.maxCap !== undefined) updateData.maxCap = updates.maxCap;
    if (updates.isActive !== undefined) updateData.isActive = updates.isActive;

    if (Object.keys(updateData).length > 0) {
      await ctx.db.patch(ruleId, updateData);

      // Log the update
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId: rule.workosOrgId,
        entityType: 'rateRule',
        entityId: ruleId,
        entityName: updates.name ?? rule.name,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        description: `Updated rate rule "${updates.name ?? rule.name}"`,
        changedFields: Object.keys(updateData),
      });
    }

    return ruleId;
  },
});

// Delete a rate rule (hard delete - rules don't have history concerns)
export const remove = mutation({
  args: {
    ruleId: v.id('rateRules'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) throw new Error('Rate rule not found');

    // Log before deletion
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: rule.workosOrgId,
      entityType: 'rateRule',
      entityId: args.ruleId,
      entityName: rule.name,
      action: 'deleted',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deleted rate rule "${rule.name}"`,
      changesBefore: JSON.stringify(rule),
    });

    await ctx.db.delete(args.ruleId);

    return args.ruleId;
  },
});

// Toggle rule active status
export const toggleActive = mutation({
  args: {
    ruleId: v.id('rateRules'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rule = await ctx.db.get(args.ruleId);
    if (!rule) throw new Error('Rate rule not found');

    const newStatus = !rule.isActive;

    await ctx.db.patch(args.ruleId, {
      isActive: newStatus,
    });

    // Log the toggle
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: rule.workosOrgId,
      entityType: 'rateRule',
      entityId: args.ruleId,
      entityName: rule.name,
      action: newStatus ? 'activated' : 'deactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `${newStatus ? 'Activated' : 'Deactivated'} rate rule "${rule.name}"`,
    });

    return args.ruleId;
  },
});

// Bulk create rules (useful for profile templates)
export const bulkCreate = mutation({
  args: {
    profileId: v.id('rateProfiles'),
    rules: v.array(
      v.object({
        name: v.string(),
        category: categoryValidator,
        triggerEvent: triggerEventValidator,
        rateAmount: v.number(),
        minThreshold: v.optional(v.number()),
        maxCap: v.optional(v.number()),
      })
    ),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // Verify profile exists
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('Rate profile not found');

    const ruleIds: string[] = [];

    for (const rule of args.rules) {
      const ruleId = await ctx.db.insert('rateRules', {
        profileId: args.profileId,
        workosOrgId: profile.workosOrgId,
        name: rule.name,
        category: rule.category,
        triggerEvent: rule.triggerEvent,
        rateAmount: rule.rateAmount,
        minThreshold: rule.minThreshold,
        maxCap: rule.maxCap,
        isActive: true,
      });
      ruleIds.push(ruleId);
    }

    // Log bulk creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: profile.workosOrgId,
      entityType: 'rateRule',
      entityId: args.profileId,
      entityName: profile.name,
      action: 'bulk_created',
      performedBy: args.userId,
      description: `Created ${args.rules.length} rules for profile "${profile.name}"`,
    });

    return ruleIds;
  },
});
