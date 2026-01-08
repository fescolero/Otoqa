import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Rate Profiles - Pay package definitions
 * e.g., "Standard OTR", "City Hourly", "Owner Op %"
 */

// List all rate profiles for an organization
export const list = query({
  args: {
    workosOrgId: v.string(),
    profileType: v.optional(v.union(v.literal('DRIVER'), v.literal('CARRIER'))),
    includeInactive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    let profiles;
    
    if (args.profileType) {
      // Filter by type - assign to local var for TypeScript narrowing
      const profileType = args.profileType;
      profiles = await ctx.db
        .query('rateProfiles')
        .withIndex('by_org_type', (q) => 
          q.eq('workosOrgId', args.workosOrgId).eq('profileType', profileType)
        )
        .collect();
    } else {
      // Get all profiles
      profiles = await ctx.db
        .query('rateProfiles')
        .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
        .collect();
    }

    // Filter out inactive profiles unless explicitly requested
    if (!args.includeInactive) {
      return profiles.filter((p) => p.isActive);
    }

    return profiles;
  },
});

// Get a single rate profile by ID with its rules
export const get = query({
  args: {
    profileId: v.id('rateProfiles'),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile) return null;

    // Fetch associated rules
    const rules = await ctx.db
      .query('rateRules')
      .withIndex('by_profile', (q) => q.eq('profileId', args.profileId))
      .collect();

    return {
      ...profile,
      rules: rules.filter((r) => r.isActive),
      allRules: rules, // Include inactive for admin view
    };
  },
});

// Create a new rate profile
export const create = mutation({
  args: {
    workosOrgId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    profileType: v.union(v.literal('DRIVER'), v.literal('CARRIER')),
    payBasis: v.union(
      v.literal('MILEAGE'),
      v.literal('HOURLY'),
      v.literal('PERCENTAGE'),
      v.literal('FLAT')
    ),
    isDefault: v.optional(v.boolean()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // If setting as org default, unset other defaults of same profileType
    if (args.isDefault) {
      const existingDefaults = await ctx.db
        .query('rateProfiles')
        .withIndex('by_org_type', (q) => 
          q.eq('workosOrgId', args.workosOrgId).eq('profileType', args.profileType)
        )
        .filter((q) => q.eq(q.field('isDefault'), true))
        .collect();

      for (const profile of existingDefaults) {
        await ctx.db.patch(profile._id, { isDefault: false });
      }
    }

    const profileId = await ctx.db.insert('rateProfiles', {
      workosOrgId: args.workosOrgId,
      name: args.name,
      description: args.description,
      profileType: args.profileType,
      payBasis: args.payBasis,
      isDefault: args.isDefault ?? false,
      isActive: true,
      createdAt: now,
      createdBy: args.createdBy,
    });

    // If this is the org default for DRIVER profiles, assign to all drivers
    if (args.isDefault && args.profileType === 'DRIVER') {
      await ctx.runMutation(internal.rateProfiles.assignOrgDefaultToAllDrivers, {
        profileId,
        workosOrgId: args.workosOrgId,
        userId: args.createdBy,
      });
    }

    // Log the creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'rateProfile',
      entityId: profileId,
      entityName: args.name,
      action: 'created',
      performedBy: args.createdBy,
      description: `Created ${args.profileType.toLowerCase()} rate profile "${args.name}"`,
    });

    return profileId;
  },
});

// Update a rate profile
export const update = mutation({
  args: {
    profileId: v.id('rateProfiles'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    payBasis: v.optional(
      v.union(
        v.literal('MILEAGE'),
        v.literal('HOURLY'),
        v.literal('PERCENTAGE'),
        v.literal('FLAT')
      )
    ),
    isDefault: v.optional(v.boolean()),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('Rate profile not found');

    const { profileId, userId, userName, ...updates } = args;

    // If setting as org default, unset other defaults of same profileType
    if (updates.isDefault === true) {
      const existingDefaults = await ctx.db
        .query('rateProfiles')
        .withIndex('by_org_type', (q) => 
          q.eq('workosOrgId', profile.workosOrgId).eq('profileType', profile.profileType)
        )
        .filter((q) => 
          q.and(
            q.eq(q.field('isDefault'), true),
            q.neq(q.field('_id'), profileId)
          )
        )
        .collect();

      for (const p of existingDefaults) {
        await ctx.db.patch(p._id, { isDefault: false });
      }
    }

    // Build update object with only provided fields
    const updateData: Record<string, unknown> = {};
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.payBasis !== undefined) updateData.payBasis = updates.payBasis;
    if (updates.isDefault !== undefined) updateData.isDefault = updates.isDefault;

    if (Object.keys(updateData).length > 0) {
      await ctx.db.patch(profileId, updateData);

      // If setting as org default for DRIVER profiles, assign to all drivers
      if (updates.isDefault === true && profile.profileType === 'DRIVER') {
        await ctx.runMutation(internal.rateProfiles.assignOrgDefaultToAllDrivers, {
          profileId,
          workosOrgId: profile.workosOrgId,
          userId,
        });
      }

      // Log the update
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId: profile.workosOrgId,
        entityType: 'rateProfile',
        entityId: profileId,
        entityName: updates.name ?? profile.name,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        description: `Updated rate profile "${updates.name ?? profile.name}"`,
        changedFields: Object.keys(updateData),
      });
    }

    return profileId;
  },
});

// Soft deactivate a rate profile
export const deactivate = mutation({
  args: {
    profileId: v.id('rateProfiles'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('Rate profile not found');

    await ctx.db.patch(args.profileId, {
      isActive: false,
      isDefault: false, // Can't be default if inactive
    });

    // Log the deactivation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: profile.workosOrgId,
      entityType: 'rateProfile',
      entityId: args.profileId,
      entityName: profile.name,
      action: 'deactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deactivated rate profile "${profile.name}"`,
    });

    return args.profileId;
  },
});

// Reactivate a rate profile
export const reactivate = mutation({
  args: {
    profileId: v.id('rateProfiles'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const profile = await ctx.db.get(args.profileId);
    if (!profile) throw new Error('Rate profile not found');

    await ctx.db.patch(args.profileId, {
      isActive: true,
    });

    // Log the reactivation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: profile.workosOrgId,
      entityType: 'rateProfile',
      entityId: args.profileId,
      entityName: profile.name,
      action: 'reactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Reactivated rate profile "${profile.name}"`,
    });

    return args.profileId;
  },
});

// Get the default profile for an organization
export const getDefault = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const defaultProfile = await ctx.db
      .query('rateProfiles')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .filter((q) => 
        q.and(
          q.eq(q.field('isDefault'), true),
          q.eq(q.field('isActive'), true)
        )
      )
      .first();

    return defaultProfile;
  },
});

/**
 * Internal mutation to assign org default profile to all drivers
 * Called when a profile is set as org default
 */
export const assignOrgDefaultToAllDrivers = internalMutation({
  args: {
    profileId: v.id('rateProfiles'),
    workosOrgId: v.string(),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    // Get all active drivers in the org
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .filter((q) => q.neq(q.field('isDeleted'), true))
      .collect();

    let assignedCount = 0;

    for (const driver of drivers) {
      // Check if driver already has this profile assigned
      const existingAssignment = await ctx.db
        .query('driverProfileAssignments')
        .withIndex('by_driver', (q) => q.eq('driverId', driver._id))
        .filter((q) => q.eq(q.field('profileId'), args.profileId))
        .first();

      if (!existingAssignment) {
        // Check if driver has any assignments at all
        const anyAssignments = await ctx.db
          .query('driverProfileAssignments')
          .withIndex('by_driver', (q) => q.eq('driverId', driver._id))
          .first();

        // Create the assignment
        // If driver has no other assignments, make this the default
        await ctx.db.insert('driverProfileAssignments', {
          driverId: driver._id,
          profileId: args.profileId,
          workosOrgId: args.workosOrgId,
          isDefault: !anyAssignments, // Set as default if no other assignments
        });
        assignedCount++;
      }
    }

    // Log the bulk assignment
    if (assignedCount > 0) {
      const profile = await ctx.db.get(args.profileId);
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId: args.workosOrgId,
        entityType: 'rateProfile',
        entityId: args.profileId,
        entityName: profile?.name ?? 'Unknown',
        action: 'bulk_assigned',
        performedBy: args.userId,
        description: `Assigned org default profile "${profile?.name}" to ${assignedCount} drivers`,
      });
    }

    return { assignedCount };
  },
});
