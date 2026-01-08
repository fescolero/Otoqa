import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Driver Profile Assignments
 * Links Drivers to Rate Profiles
 * Distance-based selection uses minThreshold on the profile's BASE rule
 */

// Get all profile assignments for a driver
export const getForDriver = query({
  args: {
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .collect();

    // Enrich with profile details and base rate/threshold
    const enrichedAssignments = await Promise.all(
      assignments.map(async (assignment) => {
        const profile = await ctx.db.get(assignment.profileId);
        
        // Get the BASE rule to find the base rate and minThreshold
        let baseRate: number | undefined;
        let minThreshold: number | undefined;
        if (profile) {
          const rules = await ctx.db
            .query('rateRules')
            .withIndex('by_profile', (q) => q.eq('profileId', assignment.profileId))
            .collect();
          const baseRule = rules.find((r) => r.category === 'BASE' && r.isActive);
          baseRate = baseRule?.rateAmount;
          minThreshold = baseRule?.minThreshold;
        }
        
        return {
          ...assignment,
          profileName: profile?.name,
          profilePayBasis: profile?.payBasis,
          profileIsActive: profile?.isActive,
          baseRate,
          minThreshold,
        };
      })
    );

    // Sort: default first, then by name
    return enrichedAssignments.sort((a, b) => {
      if (a.isDefault && !b.isDefault) return -1;
      if (!a.isDefault && b.isDefault) return 1;
      return (a.profileName ?? '').localeCompare(b.profileName ?? '');
    });
  },
});

// Get all assignments for an organization (admin view)
export const listByOrg = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    // Enrich with driver and profile details
    const enrichedAssignments = await Promise.all(
      assignments.map(async (assignment) => {
        const [driver, profile] = await Promise.all([
          ctx.db.get(assignment.driverId),
          ctx.db.get(assignment.profileId),
        ]);
        return {
          ...assignment,
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown',
          profileName: profile?.name,
          profilePayBasis: profile?.payBasis,
        };
      })
    );

    return enrichedAssignments;
  },
});

// Assign a profile to a driver
export const assign = mutation({
  args: {
    driverId: v.id('drivers'),
    profileId: v.id('rateProfiles'),
    isDefault: v.optional(v.boolean()),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Verify driver and profile exist
    const [driver, profile] = await Promise.all([
      ctx.db.get(args.driverId),
      ctx.db.get(args.profileId),
    ]);

    if (!driver) throw new Error('Driver not found');
    if (!profile) throw new Error('Rate profile not found');

    // Verify profile is for DRIVER type
    if (profile.profileType !== 'DRIVER') {
      throw new Error('Cannot assign a carrier profile to a driver');
    }

    // Get existing assignments
    const existingAssignments = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .collect();

    // Check if this profile is already assigned
    const alreadyAssigned = existingAssignments.find(
      (a) => a.profileId === args.profileId
    );
    if (alreadyAssigned) {
      throw new Error('This profile is already assigned to the driver');
    }

    // If setting as default, unset other defaults for this driver
    const shouldBeDefault = args.isDefault ?? (existingAssignments.length === 0); // First assignment is default
    if (shouldBeDefault) {
      for (const existing of existingAssignments) {
        if (existing.isDefault) {
          await ctx.db.patch(existing._id, { isDefault: false });
        }
      }
    }

    const assignmentId = await ctx.db.insert('driverProfileAssignments', {
      driverId: args.driverId,
      profileId: args.profileId,
      workosOrgId: driver.organizationId,
      isDefault: shouldBeDefault,
    });

    // Log the assignment
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: driver.organizationId,
      entityType: 'driverProfileAssignment',
      entityId: assignmentId,
      entityName: `${driver.firstName} ${driver.lastName} - ${profile.name}`,
      action: 'created',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Assigned profile "${profile.name}" to driver ${driver.firstName} ${driver.lastName}${shouldBeDefault ? ' (default)' : ''}`,
    });

    return assignmentId;
  },
});


// Remove a profile assignment
export const remove = mutation({
  args: {
    assignmentId: v.id('driverProfileAssignments'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    // Get driver and profile for logging
    const [driver, profile] = await Promise.all([
      ctx.db.get(assignment.driverId),
      ctx.db.get(assignment.profileId),
    ]);

    // Log before deletion
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: assignment.workosOrgId,
      entityType: 'driverProfileAssignment',
      entityId: args.assignmentId,
      entityName: `${driver?.firstName} ${driver?.lastName} - ${profile?.name}`,
      action: 'deleted',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Removed profile "${profile?.name}" from driver ${driver?.firstName} ${driver?.lastName}`,
    });

    await ctx.db.delete(args.assignmentId);

    return args.assignmentId;
  },
});

// Set a specific assignment as the driver's default
export const setDefault = mutation({
  args: {
    assignmentId: v.id('driverProfileAssignments'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    // Unset other defaults for this driver
    const otherAssignments = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', assignment.driverId))
      .collect();
    
    for (const other of otherAssignments) {
      if (other._id !== args.assignmentId && other.isDefault) {
        await ctx.db.patch(other._id, { isDefault: false });
      }
    }

    // Set this one as default
    await ctx.db.patch(args.assignmentId, { isDefault: true });

    // Get driver and profile for logging
    const [driver, profile] = await Promise.all([
      ctx.db.get(assignment.driverId),
      ctx.db.get(assignment.profileId),
    ]);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: assignment.workosOrgId,
      entityType: 'driverProfileAssignment',
      entityId: args.assignmentId,
      entityName: `${driver?.firstName} ${driver?.lastName} - ${profile?.name}`,
      action: 'set_default',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Set "${profile?.name}" as default profile for ${driver?.firstName} ${driver?.lastName}`,
    });

    return args.assignmentId;
  },
});

// Remove default status from a driver's profile assignment
export const unsetDefault = mutation({
  args: {
    assignmentId: v.id('driverProfileAssignments'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    if (!assignment.isDefault) {
      return args.assignmentId; // Already not default
    }

    // Unset this assignment as default
    await ctx.db.patch(args.assignmentId, { isDefault: false });

    // Get driver and profile for logging
    const [driver, profile] = await Promise.all([
      ctx.db.get(assignment.driverId),
      ctx.db.get(assignment.profileId),
    ]);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: assignment.workosOrgId,
      entityType: 'driverProfileAssignment',
      entityId: args.assignmentId,
      entityName: `${driver?.firstName} ${driver?.lastName} - ${profile?.name}`,
      action: 'unset_default',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Removed "${profile?.name}" as default profile for ${driver?.firstName} ${driver?.lastName}`,
    });

    return args.assignmentId;
  },
});

// Check if a driver has any profile assignments
export const hasAssignments = query({
  args: {
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .first();

    return assignment !== null;
  },
});
