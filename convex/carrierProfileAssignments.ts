import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

/**
 * Carrier Profile Assignments
 * Links Carrier Partnerships to Rate Profiles for pay calculation
 * Mirror of driverProfileAssignments but for external carriers
 */

const selectionStrategyValidator = v.union(
  v.literal('ALWAYS_ACTIVE'),
  v.literal('DISTANCE_THRESHOLD'),
  v.literal('MANUAL_ONLY')
);

// Get all profile assignments for a carrier partnership
export const getForCarrierPartnership = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
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

// Assign a profile to a carrier partnership
export const assign = mutation({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
    profileId: v.id('rateProfiles'),
    isDefault: v.optional(v.boolean()),
    selectionStrategy: selectionStrategyValidator,
    thresholdValue: v.optional(v.number()),
    effectiveDate: v.optional(v.string()),
    userId: v.string(),
    userName: v.optional(v.string()),
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Verify carrier partnership and profile exist
    const [partnership, profile] = await Promise.all([
      ctx.db.get(args.carrierPartnershipId),
      ctx.db.get(args.profileId),
    ]);

    if (!partnership) throw new Error('Carrier partnership not found');
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
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .collect();

    // Check if this profile is already assigned
    const existingForProfile = existingAssignments.find(
      (a) => a.profileId === args.profileId
    );
    if (existingForProfile) {
      throw new Error('This profile is already assigned to this carrier');
    }

    // If setting as default, remove default from others
    if (args.isDefault) {
      for (const assignment of existingAssignments) {
        if (assignment.isDefault) {
          await ctx.db.patch(assignment._id, { isDefault: false });
        }
      }
    }

    // If this is the first assignment, make it default
    const shouldBeDefault = args.isDefault || existingAssignments.length === 0;

    // Create the assignment
    const assignmentId = await ctx.db.insert('carrierProfileAssignments', {
      carrierPartnershipId: args.carrierPartnershipId,
      profileId: args.profileId,
      workosOrgId: args.workosOrgId,
      isDefault: shouldBeDefault,
      selectionStrategy: args.selectionStrategy,
      thresholdValue: args.thresholdValue,
      effectiveDate: args.effectiveDate,
    });

    return { assignmentId, isDefault: shouldBeDefault };
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
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    // Validate threshold for DISTANCE_THRESHOLD
    const newStrategy = args.selectionStrategy ?? assignment.selectionStrategy;
    if (newStrategy === 'DISTANCE_THRESHOLD') {
      const newThreshold = args.thresholdValue ?? assignment.thresholdValue;
      if (!newThreshold) {
        throw new Error('Threshold value is required for DISTANCE_THRESHOLD strategy');
      }
    }

    // If setting as default, remove default from others
    if (args.isDefault && !assignment.isDefault) {
      const otherAssignments = await ctx.db
        .query('carrierProfileAssignments')
        .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', assignment.carrierPartnershipId))
        .collect();

      for (const other of otherAssignments) {
        if (other._id !== args.assignmentId && other.isDefault) {
          await ctx.db.patch(other._id, { isDefault: false });
        }
      }
    }

    // Build updates object
    const updates: Record<string, unknown> = {};
    if (args.isDefault !== undefined) updates.isDefault = args.isDefault;
    if (args.selectionStrategy !== undefined) updates.selectionStrategy = args.selectionStrategy;
    if (args.thresholdValue !== undefined) updates.thresholdValue = args.thresholdValue;
    if (args.effectiveDate !== undefined) updates.effectiveDate = args.effectiveDate;

    await ctx.db.patch(args.assignmentId, updates);

    return { success: true };
  },
});

// Remove a profile assignment
export const remove = mutation({
  args: {
    assignmentId: v.id('carrierProfileAssignments'),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    const wasDefault = assignment.isDefault;

    // Delete the assignment
    await ctx.db.delete(args.assignmentId);

    // If we deleted the default, make another one default
    if (wasDefault) {
      const remainingAssignments = await ctx.db
        .query('carrierProfileAssignments')
        .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', assignment.carrierPartnershipId))
        .collect();

      if (remainingAssignments.length > 0) {
        await ctx.db.patch(remainingAssignments[0]._id, { isDefault: true });
      }
    }

    return { success: true };
  },
});

// Set a profile as the default for a carrier partnership
export const setDefault = mutation({
  args: {
    assignmentId: v.id('carrierProfileAssignments'),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) throw new Error('Assignment not found');

    if (assignment.isDefault) {
      return { success: true, message: 'Already the default' };
    }

    // Remove default from all other assignments
    const allAssignments = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', assignment.carrierPartnershipId))
      .collect();

    for (const other of allAssignments) {
      if (other.isDefault) {
        await ctx.db.patch(other._id, { isDefault: false });
      }
    }

    // Set this one as default
    await ctx.db.patch(args.assignmentId, { isDefault: true });

    return { success: true };
  },
});

// Check if a carrier partnership has any profile assignments
export const hasAssignments = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .first();

    return !!assignment;
  },
});

// Get the default profile for a carrier partnership
export const getDefaultProfile = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .collect();

    const defaultAssignment = assignments.find((a) => a.isDefault);
    if (!defaultAssignment) return null;

    const profile = await ctx.db.get(defaultAssignment.profileId);
    if (!profile) return null;

    // Get the base rate
    const rules = await ctx.db
      .query('rateRules')
      .withIndex('by_profile', (q) => q.eq('profileId', defaultAssignment.profileId))
      .collect();
    const baseRule = rules.find((r) => r.category === 'BASE' && r.isActive);

    return {
      assignment: defaultAssignment,
      profile,
      baseRate: baseRule?.rateAmount,
    };
  },
});

// Select the appropriate profile for a load based on miles
export const selectProfileForLoad = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
    loadMiles: v.number(),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('carrierProfileAssignments')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .collect();

    if (assignments.length === 0) return null;

    // First, check for DISTANCE_THRESHOLD profiles that match
    const distanceProfiles = assignments.filter(
      (a) => a.selectionStrategy === 'DISTANCE_THRESHOLD' && 
             a.thresholdValue && 
             args.loadMiles >= a.thresholdValue
    );

    // Sort by threshold descending (use most specific match)
    distanceProfiles.sort((a, b) => (b.thresholdValue ?? 0) - (a.thresholdValue ?? 0));

    if (distanceProfiles.length > 0) {
      const selected = distanceProfiles[0];
      const profile = await ctx.db.get(selected.profileId);
      return { assignment: selected, profile, selectionReason: 'DISTANCE_THRESHOLD' };
    }

    // Next, check for ALWAYS_ACTIVE profiles
    const alwaysActive = assignments.find((a) => a.selectionStrategy === 'ALWAYS_ACTIVE');
    if (alwaysActive) {
      const profile = await ctx.db.get(alwaysActive.profileId);
      return { assignment: alwaysActive, profile, selectionReason: 'ALWAYS_ACTIVE' };
    }

    // Fall back to default
    const defaultAssignment = assignments.find((a) => a.isDefault);
    if (defaultAssignment) {
      const profile = await ctx.db.get(defaultAssignment.profileId);
      return { assignment: defaultAssignment, profile, selectionReason: 'DEFAULT' };
    }

    // Last resort: first assignment
    const firstAssignment = assignments[0];
    const profile = await ctx.db.get(firstAssignment.profileId);
    return { assignment: firstAssignment, profile, selectionReason: 'FIRST_AVAILABLE' };
  },
});
