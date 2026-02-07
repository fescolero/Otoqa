import { v } from 'convex/values';
import { mutation, query } from './_generated/server';

/**
 * Route Assignments - Maps recurring routes (HCR+Trip) to drivers/carriers
 * Used by the auto-assignment system to automatically assign loads
 */

// List all route assignments for an organization
export const list = query({
  args: {
    workosOrgId: v.string(),
    isActive: v.optional(v.boolean()),
    search: v.optional(v.string()),
  },
  returns: v.array(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
      // Enriched data
      driverName: v.optional(v.string()),
      carrierName: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    let assignments = await ctx.db
      .query('routeAssignments')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    // Filter by active status if specified
    if (args.isActive !== undefined) {
      assignments = assignments.filter((a) => a.isActive === args.isActive);
    }

    // Search filter
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      assignments = assignments.filter(
        (a) =>
          a.hcr.toLowerCase().includes(searchLower) ||
          a.tripNumber?.toLowerCase().includes(searchLower) ||
          a.name?.toLowerCase().includes(searchLower)
      );
    }

    // Enrich with driver/carrier names
    const enriched = await Promise.all(
      assignments.map(async (assignment) => {
        let driverName: string | undefined;
        let carrierName: string | undefined;

        if (assignment.driverId) {
          const driver = await ctx.db.get(assignment.driverId);
          if (driver) {
            driverName = `${driver.firstName} ${driver.lastName}`;
          }
        }

        if (assignment.carrierPartnershipId) {
          const carrier = await ctx.db.get(assignment.carrierPartnershipId);
          if (carrier) {
            carrierName = carrier.carrierName;
          }
        }

        return {
          ...assignment,
          driverName,
          carrierName,
        };
      })
    );

    // Sort by priority (lower = higher priority)
    return enriched.sort((a, b) => a.priority - b.priority);
  },
});

// Get a single route assignment by ID
export const get = query({
  args: {
    id: v.id('routeAssignments'),
  },
  returns: v.union(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
      driverName: v.optional(v.string()),
      carrierName: v.optional(v.string()),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.id);
    if (!assignment) return null;

    let driverName: string | undefined;
    let carrierName: string | undefined;

    if (assignment.driverId) {
      const driver = await ctx.db.get(assignment.driverId);
      if (driver) {
        driverName = `${driver.firstName} ${driver.lastName}`;
      }
    }

    if (assignment.carrierPartnershipId) {
      const carrier = await ctx.db.get(assignment.carrierPartnershipId);
      if (carrier) {
        carrierName = carrier.carrierName;
      }
    }

    return {
      ...assignment,
      driverName,
      carrierName,
    };
  },
});

// Find assignment for a specific HCR + Trip (used by auto-assignment)
export const getByRoute = query({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.optional(v.string()),
  },
  returns: v.union(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null()
  ),
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

// List routes assigned to a specific driver
export const getByDriver = query({
  args: {
    driverId: v.id('drivers'),
  },
  returns: v.array(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('routeAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .collect();
  },
});

// List routes assigned to a specific carrier
export const getByCarrier = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
  },
  returns: v.array(
    v.object({
      _id: v.id('routeAssignments'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      hcr: v.string(),
      tripNumber: v.optional(v.string()),
      driverId: v.optional(v.id('drivers')),
      carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
      priority: v.number(),
      isActive: v.boolean(),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('routeAssignments')
      .withIndex('by_carrier', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .collect();
  },
});

// Create a new route assignment
export const create = mutation({
  args: {
    workosOrgId: v.string(),
    hcr: v.string(),
    tripNumber: v.optional(v.string()),
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
    priority: v.optional(v.number()),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.string(),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    // Validate that either driver or carrier is set (not both, not neither)
    if (!args.driverId && !args.carrierPartnershipId) {
      throw new Error('Either driverId or carrierPartnershipId must be provided');
    }
    if (args.driverId && args.carrierPartnershipId) {
      throw new Error('Cannot assign to both driver and carrier');
    }

    // Validate driver exists and is active
    if (args.driverId) {
      const driver = await ctx.db.get(args.driverId);
      if (!driver) {
        throw new Error('Driver not found');
      }
      if (driver.isDeleted) {
        throw new Error('Cannot assign to deleted driver');
      }
      if (driver.employmentStatus !== 'Active') {
        throw new Error('Cannot assign to inactive driver');
      }
    }

    // Validate carrier exists and is active
    if (args.carrierPartnershipId) {
      const carrier = await ctx.db.get(args.carrierPartnershipId);
      if (!carrier) {
        throw new Error('Carrier partnership not found');
      }
      if (carrier.status !== 'ACTIVE') {
        throw new Error('Cannot assign to inactive carrier');
      }
    }

    // Check for duplicate route assignment
    const existing = await ctx.db
      .query('routeAssignments')
      .withIndex('by_org_hcr_trip', (q) =>
        q
          .eq('workosOrgId', args.workosOrgId)
          .eq('hcr', args.hcr)
          .eq('tripNumber', args.tripNumber)
      )
      .first();

    if (existing) {
      throw new Error(
        `Route assignment already exists for HCR ${args.hcr}${args.tripNumber ? ` / Trip ${args.tripNumber}` : ''}`
      );
    }

    const now = Date.now();

    return await ctx.db.insert('routeAssignments', {
      workosOrgId: args.workosOrgId,
      hcr: args.hcr,
      tripNumber: args.tripNumber,
      driverId: args.driverId,
      carrierPartnershipId: args.carrierPartnershipId,
      priority: args.priority ?? 100, // Default priority
      isActive: true,
      name: args.name,
      notes: args.notes,
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  },
});

// Update an existing route assignment
export const update = mutation({
  args: {
    id: v.id('routeAssignments'),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    driverId: v.optional(v.id('drivers')),
    carrierPartnershipId: v.optional(v.id('carrierPartnerships')),
    priority: v.optional(v.number()),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    const { id, ...updates } = args;

    const existing = await ctx.db.get(id);
    if (!existing) {
      throw new Error('Route assignment not found');
    }

    // Validate driver if being updated
    if (updates.driverId) {
      const driver = await ctx.db.get(updates.driverId);
      if (!driver) {
        throw new Error('Driver not found');
      }
      if (driver.isDeleted) {
        throw new Error('Cannot assign to deleted driver');
      }
    }

    // Validate carrier if being updated
    if (updates.carrierPartnershipId) {
      const carrier = await ctx.db.get(updates.carrierPartnershipId);
      if (!carrier) {
        throw new Error('Carrier partnership not found');
      }
    }

    // Build update object, only including defined values
    const updateData: Record<string, unknown> = {
      updatedAt: Date.now(),
    };

    if (updates.hcr !== undefined) updateData.hcr = updates.hcr;
    if (updates.tripNumber !== undefined) updateData.tripNumber = updates.tripNumber;
    if (updates.driverId !== undefined) {
      updateData.driverId = updates.driverId;
      updateData.carrierPartnershipId = undefined; // Clear carrier if assigning driver
    }
    if (updates.carrierPartnershipId !== undefined) {
      updateData.carrierPartnershipId = updates.carrierPartnershipId;
      updateData.driverId = undefined; // Clear driver if assigning carrier
    }
    if (updates.priority !== undefined) updateData.priority = updates.priority;
    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.notes !== undefined) updateData.notes = updates.notes;
    if (updates.isActive !== undefined) updateData.isActive = updates.isActive;

    await ctx.db.patch(id, updateData);

    return id;
  },
});

// Toggle active status
export const toggleActive = mutation({
  args: {
    id: v.id('routeAssignments'),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.id);
    if (!assignment) {
      throw new Error('Route assignment not found');
    }

    const newStatus = !assignment.isActive;

    await ctx.db.patch(args.id, {
      isActive: newStatus,
      updatedAt: Date.now(),
    });

    return newStatus;
  },
});

// Delete a route assignment (hard delete)
export const remove = mutation({
  args: {
    id: v.id('routeAssignments'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.id);
    if (!assignment) {
      throw new Error('Route assignment not found');
    }

    await ctx.db.delete(args.id);

    return null;
  },
});

// Get/create auto-assignment settings for an organization
export const getSettings = query({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.union(
    v.object({
      _id: v.id('autoAssignmentSettings'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      enabled: v.boolean(),
      triggerOnCreate: v.boolean(),
      scheduledEnabled: v.boolean(),
      scheduleIntervalMinutes: v.optional(v.number()),
      updatedBy: v.string(),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    return await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();
  },
});

// Update auto-assignment settings
export const updateSettings = mutation({
  args: {
    workosOrgId: v.string(),
    enabled: v.optional(v.boolean()),
    triggerOnCreate: v.optional(v.boolean()),
    scheduledEnabled: v.optional(v.boolean()),
    scheduleIntervalMinutes: v.optional(v.number()),
    updatedBy: v.string(),
  },
  returns: v.id('autoAssignmentSettings'),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    const now = Date.now();

    if (existing) {
      // Update existing
      const updateData: Record<string, unknown> = {
        updatedBy: args.updatedBy,
        updatedAt: now,
      };

      if (args.enabled !== undefined) updateData.enabled = args.enabled;
      if (args.triggerOnCreate !== undefined) updateData.triggerOnCreate = args.triggerOnCreate;
      if (args.scheduledEnabled !== undefined) updateData.scheduledEnabled = args.scheduledEnabled;
      if (args.scheduleIntervalMinutes !== undefined)
        updateData.scheduleIntervalMinutes = args.scheduleIntervalMinutes;

      await ctx.db.patch(existing._id, updateData);
      return existing._id;
    } else {
      // Create new with defaults
      return await ctx.db.insert('autoAssignmentSettings', {
        workosOrgId: args.workosOrgId,
        enabled: args.enabled ?? false,
        triggerOnCreate: args.triggerOnCreate ?? false,
        scheduledEnabled: args.scheduledEnabled ?? false,
        scheduleIntervalMinutes: args.scheduleIntervalMinutes,
        updatedBy: args.updatedBy,
        updatedAt: now,
      });
    }
  },
});
