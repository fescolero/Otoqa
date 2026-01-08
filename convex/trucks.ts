import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';

// Helper function to determine expiration status
const getExpirationStatus = (dateString?: string) => {
  if (!dateString) return 'unknown';
  
  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const diffTime = date.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring';
  return 'valid';
};

// Count trucks by status for tab badges
export const countTrucksByStatus = query({
  args: {
    organizationId: v.string(),
  },
  handler: async (ctx, args) => {
    const trucks = await ctx.db
      .query('trucks')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    const counts = {
      all: 0,
      active: 0,
      outOfService: 0,
      inRepair: 0,
      maintenance: 0,
      sold: 0,
      deleted: 0,
    };

    trucks.forEach((truck) => {
      if (truck.isDeleted) {
        counts.deleted++;
      } else {
        counts.all++;
        if (truck.status === 'Active') counts.active++;
        else if (truck.status === 'Out of Service') counts.outOfService++;
        else if (truck.status === 'In Repair') counts.inRepair++;
        else if (truck.status === 'Maintenance') counts.maintenance++;
        else if (truck.status === 'Sold') counts.sold++;
      }
    });

    return counts;
  },
});

// Get all trucks for an organization with filtering
export const list = query({
  args: {
    organizationId: v.string(),
    includeDeleted: v.optional(v.boolean()),
    // Filters
    search: v.optional(v.string()),
    status: v.optional(v.string()),
    registrationStatus: v.optional(v.string()),
    insuranceStatus: v.optional(v.string()),
    yearMin: v.optional(v.number()),
    yearMax: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let trucks = await ctx.db
      .query('trucks')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    // Filter out soft-deleted trucks unless explicitly requested
    if (!args.includeDeleted) {
      trucks = trucks.filter((truck) => !truck.isDeleted);
    }

    // Apply search filter
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      trucks = trucks.filter(
        (truck) =>
          truck.unitId.toLowerCase().includes(searchLower) ||
          truck.vin.toLowerCase().includes(searchLower) ||
          truck.plate?.toLowerCase().includes(searchLower) ||
          truck.make?.toLowerCase().includes(searchLower) ||
          truck.model?.toLowerCase().includes(searchLower)
      );
    }

    // Apply status filter
    if (args.status) {
      trucks = trucks.filter((truck) => truck.status === args.status);
    }

    // Apply registration status filter
    if (args.registrationStatus) {
      trucks = trucks.filter((truck) => {
        const status = getExpirationStatus(truck.registrationExpiration);
        return status === args.registrationStatus;
      });
    }

    // Apply insurance status filter
    if (args.insuranceStatus) {
      trucks = trucks.filter((truck) => {
        const status = getExpirationStatus(truck.insuranceExpiration);
        return status === args.insuranceStatus;
      });
    }

    // Apply year range filter
    if (args.yearMin !== undefined) {
      trucks = trucks.filter((truck) => truck.year && truck.year >= args.yearMin!);
    }
    if (args.yearMax !== undefined) {
      trucks = trucks.filter((truck) => truck.year && truck.year <= args.yearMax!);
    }

    return trucks;
  },
});

// Get a single truck by ID
export const get = query({
  args: {
    id: v.id('trucks'),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Create a new truck
export const create = mutation({
  args: {
    // Identity & Basic Info
    unitId: v.string(),
    vin: v.string(),
    plate: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    status: v.string(),
    // Specifications
    bodyType: v.optional(v.string()),
    fuelType: v.optional(v.string()),
    gvwr: v.optional(v.number()),
    gcwr: v.optional(v.number()),
    // Registration & Compliance
    registrationExpiration: v.optional(v.string()),
    arb: v.optional(v.boolean()),
    ifta: v.optional(v.boolean()),
    comments: v.optional(v.string()),
    // Insurance
    insuranceFirm: v.optional(v.string()),
    insurancePolicyNumber: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceComments: v.optional(v.string()),
    // Financial
    purchaseDate: v.optional(v.string()),
    purchasePrice: v.optional(v.number()),
    ownershipType: v.optional(v.string()),
    lienholder: v.optional(v.string()),
    // Engine Information
    engineModel: v.optional(v.string()),
    engineFamilyName: v.optional(v.string()),
    engineModelYear: v.optional(v.number()),
    engineSerialNumber: v.optional(v.string()),
    engineManufacturer: v.optional(v.string()),
    // WorkOS Integration
    organizationId: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const truckId = await ctx.db.insert('trucks', {
      ...args,
      createdAt: now,
      updatedAt: now,
    });

    // Log the creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'truck',
      entityId: truckId,
      entityName: `${args.unitId}`,
      action: 'created',
      performedBy: args.createdBy,
      description: `Created truck ${args.unitId}`,
    });

    return truckId;
  },
});

// Update a truck
export const update = mutation({
  args: {
    id: v.id('trucks'),
    // Audit fields
    userId: v.optional(v.string()),
    userName: v.optional(v.string()),
    organizationId: v.optional(v.string()),
    // All fields as optional for partial updates
    unitId: v.optional(v.string()),
    vin: v.optional(v.string()),
    plate: v.optional(v.string()),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    status: v.optional(v.string()),
    bodyType: v.optional(v.string()),
    fuelType: v.optional(v.string()),
    gvwr: v.optional(v.number()),
    gcwr: v.optional(v.number()),
    registrationExpiration: v.optional(v.string()),
    arb: v.optional(v.boolean()),
    ifta: v.optional(v.boolean()),
    comments: v.optional(v.string()),
    insuranceFirm: v.optional(v.string()),
    insurancePolicyNumber: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceComments: v.optional(v.string()),
    purchaseDate: v.optional(v.string()),
    purchasePrice: v.optional(v.number()),
    ownershipType: v.optional(v.string()),
    lienholder: v.optional(v.string()),
    engineModel: v.optional(v.string()),
    engineFamilyName: v.optional(v.string()),
    engineModelYear: v.optional(v.number()),
    engineSerialNumber: v.optional(v.string()),
    engineManufacturer: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, userId, userName, organizationId, ...updates } = args;

    // Get current truck data for audit log
    const truck = await ctx.db.get(id);

    await ctx.db.patch(id, {
      ...updates,
      updatedAt: Date.now(),
    });

    // Log the update if audit info provided
    if (userId && truck && organizationId) {
      const changedFields = Object.keys(updates).filter((key) => key !== 'updatedAt');
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId,
        entityType: 'truck',
        entityId: id,
        entityName: `${truck.unitId}`,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        description: `Updated truck ${truck.unitId}`,
        changedFields,
        changesAfter: JSON.stringify(updates),
      });
    }

    return id;
  },
});

// Soft delete (deactivate) a truck
export const deactivate = mutation({
  args: {
    id: v.id('trucks'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get truck data before deactivation
    const truck = await ctx.db.get(args.id);
    if (!truck) throw new Error('Truck not found');

    await ctx.db.patch(args.id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: args.userId,
      status: 'Sold', // Change status when deactivated
      updatedAt: Date.now(),
    });

    // Log the deactivation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: truck.organizationId,
      entityType: 'truck',
      entityId: args.id,
      entityName: `${truck.unitId}`,
      action: 'deactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deactivated truck ${truck.unitId}`,
    });

    return args.id;
  },
});

// Get available (active, not deleted) trucks for dispatch assignment
export const getAvailableTrucks = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const trucks = await ctx.db
      .query('trucks')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .filter((q) =>
        q.and(
          q.neq(q.field('isDeleted'), true),
          q.eq(q.field('status'), 'Active')
        )
      )
      .collect();

    return trucks.map((truck) => ({
      _id: truck._id,
      unitId: truck.unitId,
      make: truck.make,
      model: truck.model,
      bodyType: truck.bodyType,
      plate: truck.plate,
    }));
  },
});

// Bulk deactivate trucks
export const bulkDeactivate = mutation({
  args: {
    ids: v.array(v.id('trucks')),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const results = [];
    for (const id of args.ids) {
      try {
        // Get truck data before deactivation
        const truck = await ctx.db.get(id);
        if (!truck) {
          results.push({ id, success: false, error: 'Truck not found' });
          continue;
        }

        await ctx.db.patch(id, {
          isDeleted: true,
          deletedAt: Date.now(),
          deletedBy: args.userId,
          status: 'Sold', // Change status when deactivated
          updatedAt: Date.now(),
        });

        // Log the deactivation
        await ctx.runMutation(internal.auditLog.logAction, {
          organizationId: truck.organizationId,
          entityType: 'truck',
          entityId: id,
          entityName: `${truck.unitId}`,
          action: 'deactivated',
          performedBy: args.userId,
          performedByName: args.userName,
          description: `Deactivated truck ${truck.unitId}`,
        });

        results.push({ id, success: true });
      } catch (error) {
        results.push({ id, success: false, error: String(error) });
      }
    }
    return results;
  },
});
