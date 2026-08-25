import { ConvexError, v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';
import { matchRouteAssignment } from './lib/routeMatch';

/**
 * Route Assignments - Maps recurring routes (HCR+Trip) to drivers/carriers
 * Used by the auto-assignment system to automatically assign loads
 */

/**
 * Normalize a route's service calendar before it is stored.
 *
 * "Absent = runs every day" is the ONE representation of unrestricted, so
 * a full seven-day selection is stored as absent rather than as
 * [0,1,2,3,4,5,6]. Otherwise the two would behave differently for a load
 * with no service date, which routeMatch declines for any restricted route.
 *
 * An empty array is rejected rather than silently treated as "every day" —
 * a dispatcher who deselects every day means "never", and reading that as
 * "always" is the worst possible guess.
 */
function normalizeActiveDays(activeDays: number[] | undefined): number[] | undefined {
  if (activeDays === undefined) return undefined;
  if (activeDays.length === 0) {
    throw new ConvexError('Select at least one day, or turn off the day restriction');
  }
  const unique = [...new Set(activeDays)].sort((a, b) => a - b);
  if (unique.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ConvexError('Days must be integers 0 (Sunday) through 6 (Saturday)');
  }
  return unique.length === 7 ? undefined : unique;
}

function validateExclusions(dates: string[] | undefined): string[] | undefined {
  if (dates === undefined) return undefined;
  for (const d of dates) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
      throw new ConvexError(`Exclusion dates must be YYYY-MM-DD (got "${d}")`);
    }
  }
  return [...new Set(dates)].sort();
}

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
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
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
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

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
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
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
    const callerOrgId = await requireCallerOrgId(ctx);

    const assignment = await ctx.db.get(args.id);
    if (!assignment) return null;
    if (assignment.workosOrgId !== callerOrgId) return null;

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
    // Business-local YYYY-MM-DD. Omit to ignore route service calendars.
    serviceDate: v.optional(v.string()),
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
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // Shared matcher (lib/routeMatch.ts). This query previously implemented
    // only the first two tiers, so the UI's preview disagreed with what the
    // assignment engine would actually pick.
    const match = await matchRouteAssignment(ctx, {
      workosOrgId: args.workosOrgId,
      hcr: args.hcr,
      trip: args.tripNumber,
      serviceDate: args.serviceDate,
    });
    return match.route;
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
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);

    const assignments = await ctx.db
      .query('routeAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .collect();

    return assignments.filter((a) => a.workosOrgId === callerOrgId);
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
      activeDays: v.optional(v.array(v.number())),
      excludeFederalHolidays: v.optional(v.boolean()),
      customExclusions: v.optional(v.array(v.string())),
      name: v.optional(v.string()),
      notes: v.optional(v.string()),
      createdBy: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);

    const assignments = await ctx.db
      .query('routeAssignments')
      .withIndex('by_carrier', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .collect();

    return assignments.filter((a) => a.workosOrgId === callerOrgId);
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
    // Service calendar — see lib/routeMatch.ts. Omit for "runs every day".
    activeDays: v.optional(v.array(v.number())),
    excludeFederalHolidays: v.optional(v.boolean()),
    customExclusions: v.optional(v.array(v.string())),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.string(),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // Validate that either driver or carrier is set (not both, not neither)
    if (!args.driverId && !args.carrierPartnershipId) {
      throw new ConvexError('Either driverId or carrierPartnershipId must be provided');
    }
    if (args.driverId && args.carrierPartnershipId) {
      throw new ConvexError('Cannot assign to both driver and carrier');
    }

    // Validate driver exists and is active
    if (args.driverId) {
      const driver = await ctx.db.get(args.driverId);
      if (!driver) {
        throw new ConvexError('Driver not found');
      }
      if (driver.isDeleted) {
        throw new ConvexError('Cannot assign to deleted driver');
      }
      if (driver.employmentStatus !== 'Active') {
        throw new ConvexError('Cannot assign to inactive driver');
      }
    }

    // Validate carrier exists and is active
    if (args.carrierPartnershipId) {
      const carrier = await ctx.db.get(args.carrierPartnershipId);
      if (!carrier) {
        throw new ConvexError('Carrier partnership not found');
      }
      if (carrier.status !== 'ACTIVE') {
        throw new ConvexError('Cannot assign to inactive carrier');
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
      throw new ConvexError(
        `Route assignment already exists for HCR ${args.hcr}${args.tripNumber ? ` / Trip ${args.tripNumber}` : ''}`
      );
    }

    const now = Date.now();

    const assignmentId = await ctx.db.insert('routeAssignments', {
      workosOrgId: args.workosOrgId,
      hcr: args.hcr,
      tripNumber: args.tripNumber,
      driverId: args.driverId,
      carrierPartnershipId: args.carrierPartnershipId,
      priority: args.priority ?? 100, // Default priority
      isActive: true,
      activeDays: normalizeActiveDays(args.activeDays),
      excludeFederalHolidays: args.excludeFederalHolidays || undefined,
      customExclusions: validateExclusions(args.customExclusions)?.length
        ? validateExclusions(args.customExclusions)
        : undefined,
      name: args.name,
      notes: args.notes,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'routeAssignment',
      entityId: assignmentId,
      entityName: args.name,
      action: 'created',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Created route assignment for HCR ${args.hcr}${args.tripNumber ? ` / Trip ${args.tripNumber}` : ''}`,
    });

    return assignmentId;
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
    // Service calendar. Send all seven days (or an empty exclusion list) to
    // clear a restriction; normalizeActiveDays stores that as absent.
    activeDays: v.optional(v.array(v.number())),
    excludeFederalHolidays: v.optional(v.boolean()),
    customExclusions: v.optional(v.array(v.string())),
    name: v.optional(v.string()),
    notes: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  returns: v.id('routeAssignments'),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const { id, ...updates } = args;

    const existing = await ctx.db.get(id);
    if (!existing) {
      throw new ConvexError('Route assignment not found');
    }
    if (existing.workosOrgId !== callerOrgId) {
      throw new ConvexError('Not authorized for this organization');
    }

    // Validate driver if being updated
    if (updates.driverId) {
      const driver = await ctx.db.get(updates.driverId);
      if (!driver) {
        throw new ConvexError('Driver not found');
      }
      if (driver.isDeleted) {
        throw new ConvexError('Cannot assign to deleted driver');
      }
    }

    // Validate carrier if being updated
    if (updates.carrierPartnershipId) {
      const carrier = await ctx.db.get(updates.carrierPartnershipId);
      if (!carrier) {
        throw new ConvexError('Carrier partnership not found');
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

    // Calendar fields normalize to `undefined` when unrestricted, and
    // patching a key to undefined removes it — which is exactly the
    // "clear the restriction" path.
    if (updates.activeDays !== undefined) {
      updateData.activeDays = normalizeActiveDays(updates.activeDays);
    }
    if (updates.excludeFederalHolidays !== undefined) {
      updateData.excludeFederalHolidays = updates.excludeFederalHolidays || undefined;
    }
    if (updates.customExclusions !== undefined) {
      const cleaned = validateExclusions(updates.customExclusions);
      updateData.customExclusions = cleaned && cleaned.length > 0 ? cleaned : undefined;
    }

    await ctx.db.patch(id, updateData);

    const changedFields = Object.keys(updateData).filter((key) => key !== 'updatedAt');
    if (changedFields.length > 0) {
      await logAudit(ctx, {
        organizationId: existing.workosOrgId,
        entityType: 'routeAssignment',
        entityId: id,
        entityName: existing.name,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Updated route assignment for HCR ${existing.hcr}${existing.tripNumber ? ` / Trip ${existing.tripNumber}` : ''}`,
        changedFields,
        changesAfter: JSON.stringify(updateData),
      });
    }

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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const assignment = await ctx.db.get(args.id);
    if (!assignment) {
      throw new ConvexError('Route assignment not found');
    }
    if (assignment.workosOrgId !== callerOrgId) {
      throw new ConvexError('Not authorized for this organization');
    }

    const newStatus = !assignment.isActive;

    await ctx.db.patch(args.id, {
      isActive: newStatus,
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: assignment.workosOrgId,
      entityType: 'routeAssignment',
      entityId: args.id,
      entityName: assignment.name,
      action: newStatus ? 'reactivated' : 'deactivated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `${newStatus ? 'Activated' : 'Deactivated'} route assignment for HCR ${assignment.hcr}${assignment.tripNumber ? ` / Trip ${assignment.tripNumber}` : ''}`,
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const assignment = await ctx.db.get(args.id);
    if (!assignment) {
      throw new ConvexError('Route assignment not found');
    }
    if (assignment.workosOrgId !== callerOrgId) {
      throw new ConvexError('Not authorized for this organization');
    }

    await ctx.db.delete(args.id);

    await logAudit(ctx, {
      organizationId: assignment.workosOrgId,
      entityType: 'routeAssignment',
      entityId: args.id,
      entityName: assignment.name,
      action: 'deleted',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Deleted route assignment for HCR ${assignment.hcr}${assignment.tripNumber ? ` / Trip ${assignment.tripNumber}` : ''}`,
      changesBefore: JSON.stringify(assignment),
    });

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
      lastScheduledRunAt: v.optional(v.number()),
      updatedBy: v.string(),
      updatedAt: v.number(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

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
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const existing = await ctx.db
      .query('autoAssignmentSettings')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    const now = Date.now();

    let settingsId;
    if (existing) {
      // Update existing
      const updateData: Record<string, unknown> = {
        updatedBy: userId,
        updatedAt: now,
      };

      if (args.enabled !== undefined) updateData.enabled = args.enabled;
      if (args.triggerOnCreate !== undefined) updateData.triggerOnCreate = args.triggerOnCreate;
      if (args.scheduledEnabled !== undefined) updateData.scheduledEnabled = args.scheduledEnabled;
      if (args.scheduleIntervalMinutes !== undefined)
        updateData.scheduleIntervalMinutes = args.scheduleIntervalMinutes;

      await ctx.db.patch(existing._id, updateData);
      settingsId = existing._id;
    } else {
      // Create new with defaults
      settingsId = await ctx.db.insert('autoAssignmentSettings', {
        workosOrgId: args.workosOrgId,
        enabled: args.enabled ?? false,
        triggerOnCreate: args.triggerOnCreate ?? false,
        scheduledEnabled: args.scheduledEnabled ?? false,
        scheduleIntervalMinutes: args.scheduleIntervalMinutes,
        updatedBy: userId,
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'routeAssignment',
      entityId: settingsId,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: 'Updated route assignment settings',
    });

    return settingsId;
  },
});
