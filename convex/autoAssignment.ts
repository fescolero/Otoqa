import { v } from 'convex/values';
import { internalMutation, internalAction, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';

/**
 * Auto-Assignment System
 * Automatically assigns loads to pre-configured drivers/carriers based on route rules
 */

// Result type for auto-assignment attempts
type AutoAssignResult = {
  success: boolean;
  loadId: Id<'loadInformation'>;
  action:
    | 'ASSIGNED_DRIVER'
    | 'ASSIGNED_CARRIER'
    | 'NO_MATCH'
    | 'ALREADY_ASSIGNED'
    | 'CONFLICT'
    | 'DRIVER_INACTIVE'
    | 'CARRIER_INACTIVE'
    | 'ERROR';
  message: string;
  routeAssignmentId?: Id<'routeAssignments'>;
  driverId?: Id<'drivers'>;
  carrierPartnershipId?: Id<'carrierPartnerships'>;
};

const autoAssignResultValidator = v.object({
  success: v.boolean(),
  loadId: v.id('loadInformation'),
  action: v.union(
    v.literal('ASSIGNED_DRIVER'),
    v.literal('ASSIGNED_CARRIER'),
    v.literal('NO_MATCH'),
    v.literal('ALREADY_ASSIGNED'),
    v.literal('CONFLICT'),
    v.literal('DRIVER_INACTIVE'),
    v.literal('CARRIER_INACTIVE'),
    v.literal('ERROR')
  ),
  message: v.string(),
  routeAssignmentId: v.optional(v.id('routeAssignments')),
  driverId: v.optional(v.id('drivers')),
  carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
});

// Internal query to get auto-assignment settings
export const getAutoAssignmentSettings = internalQuery({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
  },
});

// Internal query to find matching route assignment
export const findRouteAssignment = internalQuery({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // First try exact match (HCR + Trip)
    if (args.tripNumber) {
      const exactMatch = await ctx.db
        .query('routeAssignments')
        .withIndex('by_org_hcr_trip', (q) =>
          q
            .eq('workosOrgId', args.workosOrgId)
            .eq('hcr', args.hcr)
            .eq('tripNumber', args.tripNumber)
        )
        .filter((q) => q.eq(q.field('isActive'), true))
        .first();

      if (exactMatch) return exactMatch;
    }

    // Fall back to HCR-only match
    const hcrMatch = await ctx.db
      .query('routeAssignments')
      .withIndex('by_org_hcr', (q) => q.eq('workosOrgId', args.workosOrgId).eq('hcr', args.hcr))
      .filter((q) =>
        q.and(q.eq(q.field('isActive'), true), q.eq(q.field('tripNumber'), undefined))
      )
      .first();

    return hcrMatch;
  },
});

/**
 * Auto-assign a single load based on its HCR + Trip
 * Called after load creation or during scheduled runs
 */
export const autoAssignLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    userId: v.string(), // System user ID for audit
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AutoAssignResult> => {
    // 1. Get the load
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'ERROR',
        message: 'Load not found',
      };
    }

    // 2. Skip if already assigned
    if (load.status === 'Assigned' || load.primaryDriverId || load.primaryCarrierPartnershipId) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'ALREADY_ASSIGNED',
        message: 'Load is already assigned',
      };
    }

    // 3. Skip if no HCR
    if (!load.parsedHcr) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'NO_MATCH',
        message: 'Load has no HCR - cannot auto-assign',
      };
    }

    // 4. Check if auto-assignment is enabled for this org
    const settings = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', load.workosOrgId))
      .first();

    if (!settings?.enabled) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'NO_MATCH',
        message: 'Auto-assignment is disabled for this organization',
      };
    }

    // 5. Find matching route assignment - try exact match first, then HCR-only
    let routeAssignment: Doc<'routeAssignments'> | null = null;

    if (load.parsedTripNumber) {
      routeAssignment = await ctx.db
        .query('routeAssignments')
        .withIndex('by_org_hcr_trip', (q) =>
          q
            .eq('workosOrgId', load.workosOrgId)
            .eq('hcr', load.parsedHcr!)
            .eq('tripNumber', load.parsedTripNumber)
        )
        .filter((q) => q.eq(q.field('isActive'), true))
        .first();
    }

    if (!routeAssignment) {
      routeAssignment = await ctx.db
        .query('routeAssignments')
        .withIndex('by_org_hcr', (q) => q.eq('workosOrgId', load.workosOrgId).eq('hcr', load.parsedHcr!))
        .filter((q) =>
          q.and(q.eq(q.field('isActive'), true), q.eq(q.field('tripNumber'), undefined))
        )
        .first();
    }

    if (!routeAssignment) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'NO_MATCH',
        message: `No route assignment found for HCR ${load.parsedHcr}${load.parsedTripNumber ? ` / Trip ${load.parsedTripNumber}` : ''}`,
      };
    }

    // 6. Assign to driver or carrier based on route assignment
    if (routeAssignment.driverId) {
      // Check if driver is still active
      const driver = await ctx.db.get(routeAssignment.driverId);
      if (!driver || driver.isDeleted || driver.employmentStatus !== 'Active') {
        return {
          success: false,
          loadId: args.loadId,
          action: 'DRIVER_INACTIVE',
          message: `Driver for route ${routeAssignment.name || routeAssignment.hcr} is inactive or deleted. Please update the route assignment.`,
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      }

      // Call existing assignDriver mutation
      const result = await ctx.runMutation(internal.dispatchLegs.assignDriverInternal, {
        loadId: args.loadId,
        driverId: routeAssignment.driverId,
        truckId: driver.currentTruckId,
        assignedBy: args.userId,
        assignedByName: args.userName ?? 'Auto-Assignment System',
      });

      if (result.status === 'SUCCESS') {
        return {
          success: true,
          loadId: args.loadId,
          action: 'ASSIGNED_DRIVER',
          message: `Auto-assigned to driver ${driver.firstName} ${driver.lastName}`,
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      } else if (result.status === 'CONFLICT') {
        return {
          success: false,
          loadId: args.loadId,
          action: 'CONFLICT',
          message: `Driver ${driver.firstName} ${driver.lastName} has a conflicting load`,
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      } else {
        return {
          success: false,
          loadId: args.loadId,
          action: 'ERROR',
          message: result.message ?? 'Failed to assign driver',
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      }
    } else if (routeAssignment.carrierPartnershipId) {
      // Check if carrier is still active
      const carrier = await ctx.db.get(routeAssignment.carrierPartnershipId);
      if (!carrier || carrier.status !== 'ACTIVE') {
        return {
          success: false,
          loadId: args.loadId,
          action: 'CARRIER_INACTIVE',
          message: `Carrier for route ${routeAssignment.name || routeAssignment.hcr} is inactive. Please update the route assignment.`,
          routeAssignmentId: routeAssignment._id,
          carrierPartnershipId: routeAssignment.carrierPartnershipId,
        };
      }

      // Call existing assignCarrier mutation
      const result = await ctx.runMutation(internal.dispatchLegs.assignCarrierInternal, {
        loadId: args.loadId,
        carrierPartnershipId: routeAssignment.carrierPartnershipId,
        assignedBy: args.userId,
        assignedByName: args.userName ?? 'Auto-Assignment System',
      });

      if (result.status === 'SUCCESS') {
        return {
          success: true,
          loadId: args.loadId,
          action: 'ASSIGNED_CARRIER',
          message: `Auto-assigned to carrier ${carrier.carrierName}`,
          routeAssignmentId: routeAssignment._id,
          carrierPartnershipId: routeAssignment.carrierPartnershipId,
        };
      } else {
        return {
          success: false,
          loadId: args.loadId,
          action: 'ERROR',
          message: result.message ?? 'Failed to assign carrier',
          routeAssignmentId: routeAssignment._id,
          carrierPartnershipId: routeAssignment.carrierPartnershipId,
        };
      }
    }

    return {
      success: false,
      loadId: args.loadId,
      action: 'ERROR',
      message: 'Route assignment has no driver or carrier configured',
      routeAssignmentId: routeAssignment._id,
    };
  },
});

/**
 * Process all pending loads for auto-assignment
 * Called by scheduled cron job
 */
export const autoAssignPendingLoads = internalAction({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args): Promise<{
    processed: number;
    assigned: number;
    skipped: number;
    errors: number;
    results: AutoAssignResult[];
  }> => {
    // 1. Check if scheduled auto-assignment is enabled
    const settings = await ctx.runQuery(internal.autoAssignment.getAutoAssignmentSettings, {
      workosOrgId: args.workosOrgId,
    });

    if (!settings?.enabled || !settings.scheduledEnabled) {
      return {
        processed: 0,
        assigned: 0,
        skipped: 0,
        errors: 0,
        results: [],
      };
    }

    // 2. Get all Open loads that have HCR
    const openLoads = await ctx.runQuery(internal.autoAssignment.getOpenLoadsWithHcr, {
      workosOrgId: args.workosOrgId,
    });

    const results: AutoAssignResult[] = [];

    let assigned = 0;
    let skipped = 0;
    let errors = 0;

    // 3. Process each load
    for (const load of openLoads) {
      const result = await ctx.runMutation(internal.autoAssignment.autoAssignLoad, {
        loadId: load._id,
        userId: 'system',
        userName: 'Scheduled Auto-Assignment',
      });

      results.push(result);

      if (result.success) {
        assigned++;
      } else if (result.action === 'NO_MATCH' || result.action === 'ALREADY_ASSIGNED') {
        skipped++;
      } else {
        errors++;
      }
    }

    return {
      processed: openLoads.length,
      assigned,
      skipped,
      errors,
      results,
    };
  },
});

// Internal query to get open loads with HCR
export const getOpenLoadsWithHcr = internalQuery({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const loads = await ctx.db
      .query('loadInformation')
      .withIndex('by_status', (q) => q.eq('workosOrgId', args.workosOrgId).eq('status', 'Open'))
      .collect();

    // Filter to only loads with HCR
    return loads
      .filter((load) => load.parsedHcr)
      .map((load) => ({
        _id: load._id,
        parsedHcr: load.parsedHcr!,
        parsedTripNumber: load.parsedTripNumber,
      }));
  },
});

/**
 * Trigger auto-assignment for a newly created load
 * Called from createLoad mutation when triggerOnCreate is enabled
 */
export const triggerAutoAssignmentForLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    workosOrgId: v.string(),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<AutoAssignResult | null> => {
    // Check if auto-assignment is enabled and triggerOnCreate is true
    const settings = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    if (!settings?.enabled || !settings.triggerOnCreate) {
      return null;
    }

    // Trigger auto-assignment (inline to avoid circular reference)
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'ERROR',
        message: 'Load not found',
      };
    }

    // Skip if already assigned
    if (load.status === 'Assigned' || load.primaryDriverId || load.primaryCarrierPartnershipId) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'ALREADY_ASSIGNED',
        message: 'Load is already assigned',
      };
    }

    // Skip if no HCR
    if (!load.parsedHcr) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'NO_MATCH',
        message: 'Load has no HCR - cannot auto-assign',
      };
    }

    // Find matching route assignment
    let routeAssignment: Doc<'routeAssignments'> | null = null;

    if (load.parsedTripNumber) {
      routeAssignment = await ctx.db
        .query('routeAssignments')
        .withIndex('by_org_hcr_trip', (q) =>
          q
            .eq('workosOrgId', load.workosOrgId)
            .eq('hcr', load.parsedHcr!)
            .eq('tripNumber', load.parsedTripNumber)
        )
        .filter((q) => q.eq(q.field('isActive'), true))
        .first();
    }

    if (!routeAssignment) {
      routeAssignment = await ctx.db
        .query('routeAssignments')
        .withIndex('by_org_hcr', (q) => q.eq('workosOrgId', load.workosOrgId).eq('hcr', load.parsedHcr!))
        .filter((q) =>
          q.and(q.eq(q.field('isActive'), true), q.eq(q.field('tripNumber'), undefined))
        )
        .first();
    }

    if (!routeAssignment) {
      return {
        success: false,
        loadId: args.loadId,
        action: 'NO_MATCH',
        message: `No route assignment found for HCR ${load.parsedHcr}`,
      };
    }

    // Assign to driver or carrier
    if (routeAssignment.driverId) {
      const driver = await ctx.db.get(routeAssignment.driverId);
      if (!driver || driver.isDeleted || driver.employmentStatus !== 'Active') {
        return {
          success: false,
          loadId: args.loadId,
          action: 'DRIVER_INACTIVE',
          message: `Driver for route is inactive or deleted`,
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      }

      const result = await ctx.runMutation(internal.dispatchLegs.assignDriverInternal, {
        loadId: args.loadId,
        driverId: routeAssignment.driverId,
        truckId: driver.currentTruckId,
        assignedBy: args.userId,
        assignedByName: args.userName ?? 'Auto-Assignment System',
      });

      if (result.status === 'SUCCESS') {
        return {
          success: true,
          loadId: args.loadId,
          action: 'ASSIGNED_DRIVER',
          message: `Auto-assigned to driver ${driver.firstName} ${driver.lastName}`,
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      } else if (result.status === 'CONFLICT') {
        return {
          success: false,
          loadId: args.loadId,
          action: 'CONFLICT',
          message: `Driver has a conflicting load`,
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      } else {
        return {
          success: false,
          loadId: args.loadId,
          action: 'ERROR',
          message: result.message ?? 'Failed to assign driver',
          routeAssignmentId: routeAssignment._id,
          driverId: routeAssignment.driverId,
        };
      }
    } else if (routeAssignment.carrierPartnershipId) {
      const carrier = await ctx.db.get(routeAssignment.carrierPartnershipId);
      if (!carrier || carrier.status !== 'ACTIVE') {
        return {
          success: false,
          loadId: args.loadId,
          action: 'CARRIER_INACTIVE',
          message: `Carrier for route is inactive`,
          routeAssignmentId: routeAssignment._id,
          carrierPartnershipId: routeAssignment.carrierPartnershipId,
        };
      }

      const result = await ctx.runMutation(internal.dispatchLegs.assignCarrierInternal, {
        loadId: args.loadId,
        carrierPartnershipId: routeAssignment.carrierPartnershipId,
        assignedBy: args.userId,
        assignedByName: args.userName ?? 'Auto-Assignment System',
      });

      if (result.status === 'SUCCESS') {
        return {
          success: true,
          loadId: args.loadId,
          action: 'ASSIGNED_CARRIER',
          message: `Auto-assigned to carrier ${carrier.carrierName}`,
          routeAssignmentId: routeAssignment._id,
          carrierPartnershipId: routeAssignment.carrierPartnershipId,
        };
      } else {
        return {
          success: false,
          loadId: args.loadId,
          action: 'ERROR',
          message: result.message ?? 'Failed to assign carrier',
          routeAssignmentId: routeAssignment._id,
          carrierPartnershipId: routeAssignment.carrierPartnershipId,
        };
      }
    }

    return {
      success: false,
      loadId: args.loadId,
      action: 'ERROR',
      message: 'Route assignment has no driver or carrier configured',
      routeAssignmentId: routeAssignment._id,
    };
  },
});
