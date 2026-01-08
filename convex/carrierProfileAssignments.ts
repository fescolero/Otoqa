import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Carrier Profile Assignments
 * Links Carriers (owner-ops, external) to Rate Profiles
 */

const selectionStrategyValidator = v.union(
  v.literal('ALWAYS_ACTIVE'),
  v.literal('DISTANCE_THRESHOLD'),
  v.literal('MANUAL_ONLY')
);

// Get all profile assignments for a carrier
export const getForCarrier = query({
  args: {
    carrierId: v.id('carriers'),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier', (q) => q.eq('carrierId', args.carrierId))
      .collect();

    // Enrich with profile details and base rate
    const enrichedAssignments = await Promise.all(
      assignments.map(async (assignment) => {
        const profile = await ctx.db.get(assignment.profileId);
        
        // Get the BASE rule to find the base rate
        let baseRate: number | undefined;
        if (profile) {
          const rules = await ctx.db
            .query('rateRules')
            .withIndex('by_profile', (q) => q.eq('profileId', assignment.profileId))
            .collect();
          const baseRule = rules.find((r) => r.category === 'BASE' && r.isActive);
          baseRate = baseRule?.rateAmount;
        }
        
        return {
          ...assignment,
          profileName: profile?.name,
          profilePayBasis: profile?.payBasis,
          profileIsActive: profile?.isActive,
          baseRate,
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

// Assign a profile to a carrier
export const assign = mutation({
  args: {
    carrierId: v.id('carriers'),
    profileId: v.id('rateProfiles'),
    isDefault: v.optional(v.boolean()),
    selectionStrategy: selectionStrategyValidator,
    thresholdValue: v.optional(v.number()),
    effectiveDate: v.optional(v.string()),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Verify carrier and profile exist
    const [carrier, profile] = await Promise.all([
      ctx.db.get(args.carrierId),
      ctx.db.get(args.profileId),
    ]);

    if (!carrier) throw new Error('Carrier not found');
    if (!profile) throw new Error('Rate profile not found');

    // Verify profile is for CARRIER type
    if (profile.profileType !== 'CARRIER') {
      throw new Error('Cannot assign a driver profile to a carrier');
    }

    // Validate threshold is provided for DISTANCE_THRESHOLD strategy
    if (args.selectionStrategy === 'DISTANCE_THRESHOLD' && !args.thresholdValue) {
      throw new Error('Threshold value is required for DISTANCE_THRESHOLD strategy');
    }

    // Get existing assignments
    const existingAssignments = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier', (q) => q.eq('carrierId', args.carrierId))
      .collect();

    // Check if this profile is already assigned
    const alreadyAssigned = existingAssignments.find(
      (a) => a.profileId === args.profileId
    );
    if (alreadyAssigned) {
      throw new Error('This profile is already assigned to the carrier');
    }

    // If setting as default, unset other defaults for this carrier
    const shouldBeDefault = args.isDefault ?? (existingAssignments.length === 0); // First assignment is default
    if (shouldBeDefault) {
      for (const existing of existingAssignments) {
        if (existing.isDefault) {
          await ctx.db.patch(existing._id, { isDefault: false });
        }
      }
    }

    const assignmentId = await ctx.db.insert('carrierProfileAssignments', {
      carrierId: args.carrierId,
      profileId: args.profileId,
      workosOrgId: carrier.workosOrgId,
      isDefault: shouldBeDefault,
      selectionStrategy: args.selectionStrategy,
      thresholdValue: args.thresholdValue,
      effectiveDate: args.effectiveDate,
    });

    // Log the assignment
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: carrier.workosOrgId,
      entityType: 'carrierProfileAssignment',
      entityId: assignmentId,
      entityName: `${carrier.companyName} - ${profile.name}`,
      action: 'created',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Assigned profile "${profile.name}" to carrier ${carrier.companyName}${shouldBeDefault ? ' (default)' : ''}`,
    });

    return assignmentId;
  },
});

// Update a profile assignment
export const update = mutation({
  args: {
    assignmentId: v.id('carrierProfileAssignments'),
    isDefault: v.optional(v.boolean()),
    selectionStrategy: v.optional(selectionStrategyValidator),
    thresholdValue: v.optional(v.number()),
    effectiveDate: v.optional(v.string()),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    const { assignmentId, userId, userName, ...updates } = args;

    // Validate threshold if switching to DISTANCE_THRESHOLD
    if (
      updates.selectionStrategy === 'DISTANCE_THRESHOLD' &&
      !updates.thresholdValue &&
      !assignment.thresholdValue
    ) {
      throw new Error('Threshold value is required for DISTANCE_THRESHOLD strategy');
    }

    // If setting as default, unset other defaults for this carrier
    if (updates.isDefault === true) {
      const otherAssignments = await ctx.db
        .query('carrierProfileAssignments')
        .withIndex('by_carrier', (q) => q.eq('carrierId', assignment.carrierId))
        .collect();
      
      for (const other of otherAssignments) {
        if (other._id !== assignmentId && other.isDefault) {
          await ctx.db.patch(other._id, { isDefault: false });
        }
      }
    }

    // Build update object
    const updateData: Record<string, unknown> = {};
    if (updates.isDefault !== undefined) {
      updateData.isDefault = updates.isDefault;
    }
    if (updates.selectionStrategy !== undefined) {
      updateData.selectionStrategy = updates.selectionStrategy;
    }
    if (updates.thresholdValue !== undefined) {
      updateData.thresholdValue = updates.thresholdValue;
    }
    if (updates.effectiveDate !== undefined) {
      updateData.effectiveDate = updates.effectiveDate;
    }

    if (Object.keys(updateData).length > 0) {
      await ctx.db.patch(assignmentId, updateData);

      // Get carrier and profile for logging
      const [carrier, profile] = await Promise.all([
        ctx.db.get(assignment.carrierId),
        ctx.db.get(assignment.profileId),
      ]);

      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId: assignment.workosOrgId,
        entityType: 'carrierProfileAssignment',
        entityId: assignmentId,
        entityName: `${carrier?.companyName} - ${profile?.name}`,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        description: `Updated profile assignment for ${carrier?.companyName}`,
        changedFields: Object.keys(updateData),
      });
    }

    return assignmentId;
  },
});

// Remove a profile assignment
export const remove = mutation({
  args: {
    assignmentId: v.id('carrierProfileAssignments'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    // Get carrier and profile for logging
    const [carrier, profile] = await Promise.all([
      ctx.db.get(assignment.carrierId),
      ctx.db.get(assignment.profileId),
    ]);

    // Log before deletion
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: assignment.workosOrgId,
      entityType: 'carrierProfileAssignment',
      entityId: args.assignmentId,
      entityName: `${carrier?.companyName} - ${profile?.name}`,
      action: 'deleted',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Removed profile "${profile?.name}" from carrier ${carrier?.companyName}`,
    });

    await ctx.db.delete(args.assignmentId);

    return args.assignmentId;
  },
});

// Set a specific assignment as the carrier's default
export const setDefault = mutation({
  args: {
    assignmentId: v.id('carrierProfileAssignments'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    // Unset other defaults for this carrier
    const otherAssignments = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier', (q) => q.eq('carrierId', assignment.carrierId))
      .collect();
    
    for (const other of otherAssignments) {
      if (other._id !== args.assignmentId && other.isDefault) {
        await ctx.db.patch(other._id, { isDefault: false });
      }
    }

    // Set this one as default
    await ctx.db.patch(args.assignmentId, { isDefault: true });

    // Get carrier and profile for logging
    const [carrier, profile] = await Promise.all([
      ctx.db.get(assignment.carrierId),
      ctx.db.get(assignment.profileId),
    ]);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: assignment.workosOrgId,
      entityType: 'carrierProfileAssignment',
      entityId: args.assignmentId,
      entityName: `${carrier?.companyName} - ${profile?.name}`,
      action: 'set_default',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Set "${profile?.name}" as default profile for ${carrier?.companyName}`,
    });

    return args.assignmentId;
  },
});

// Check if a carrier has any profile assignments
export const hasAssignments = query({
  args: {
    carrierId: v.id('carriers'),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier', (q) => q.eq('carrierId', args.carrierId))
      .first();

    return assignment !== null;
  },
});
