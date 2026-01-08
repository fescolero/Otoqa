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

// Count trailers by status for tab badges
export const countTrailersByStatus = query({
  args: {
    organizationId: v.string(),
  },
  handler: async (ctx, args) => {
    const trailers = await ctx.db
      .query('trailers')
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

    trailers.forEach((trailer) => {
      if (trailer.isDeleted) {
        counts.deleted++;
      } else {
        counts.all++;
        if (trailer.status === 'Active') counts.active++;
        else if (trailer.status === 'Out of Service') counts.outOfService++;
        else if (trailer.status === 'In Repair') counts.inRepair++;
        else if (trailer.status === 'Maintenance') counts.maintenance++;
        else if (trailer.status === 'Sold') counts.sold++;
      }
    });

    return counts;
  },
});

// Get all trailers for an organization with filtering
export const list = query({
  args: {
    organizationId: v.string(),
    includeDeleted: v.optional(v.boolean()),
    // Filters
    search: v.optional(v.string()),
    status: v.optional(v.string()),
    registrationStatus: v.optional(v.string()),
    insuranceStatus: v.optional(v.string()),
    size: v.optional(v.string()),
    bodyType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let trailers = await ctx.db
      .query('trailers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();

    // Filter out soft-deleted trailers unless explicitly requested
    if (!args.includeDeleted) {
      trailers = trailers.filter((trailer) => !trailer.isDeleted);
    }

    // Apply search filter
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      trailers = trailers.filter(
        (trailer) =>
          trailer.unitId.toLowerCase().includes(searchLower) ||
          trailer.vin.toLowerCase().includes(searchLower) ||
          trailer.plate?.toLowerCase().includes(searchLower) ||
          trailer.make?.toLowerCase().includes(searchLower) ||
          trailer.model?.toLowerCase().includes(searchLower) ||
          trailer.size?.toLowerCase().includes(searchLower) ||
          trailer.bodyType?.toLowerCase().includes(searchLower)
      );
    }

    // Apply status filter
    if (args.status) {
      trailers = trailers.filter((trailer) => trailer.status === args.status);
    }

    // Apply registration status filter
    if (args.registrationStatus) {
      trailers = trailers.filter((trailer) => {
        const status = getExpirationStatus(trailer.registrationExpiration);
        return status === args.registrationStatus;
      });
    }

    // Apply insurance status filter
    if (args.insuranceStatus) {
      trailers = trailers.filter((trailer) => {
        const status = getExpirationStatus(trailer.insuranceExpiration);
        return status === args.insuranceStatus;
      });
    }

    // Apply size filter
    if (args.size) {
      trailers = trailers.filter((trailer) => trailer.size === args.size);
    }

    // Apply body type filter
    if (args.bodyType) {
      trailers = trailers.filter((trailer) => trailer.bodyType === args.bodyType);
    }

    return trailers;
  },
});

// Get a single trailer by ID
export const get = query({
  args: {
    id: v.id('trailers'),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

// Create a new trailer
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
    size: v.optional(v.string()),
    bodyType: v.optional(v.string()),
    gvwr: v.optional(v.number()),
    // Registration & Compliance
    registrationExpiration: v.optional(v.string()),
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
    // WorkOS Integration
    organizationId: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const trailerId = await ctx.db.insert('trailers', {
      ...args,
      createdAt: now,
      updatedAt: now,
    });

    // Log the creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'trailer',
      entityId: trailerId,
      entityName: `${args.unitId}`,
      action: 'created',
      performedBy: args.createdBy,
      description: `Created trailer ${args.unitId}`,
    });

    return trailerId;
  },
});

// Update a trailer
export const update = mutation({
  args: {
    id: v.id('trailers'),
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
    size: v.optional(v.string()),
    bodyType: v.optional(v.string()),
    gvwr: v.optional(v.number()),
    registrationExpiration: v.optional(v.string()),
    comments: v.optional(v.string()),
    insuranceFirm: v.optional(v.string()),
    insurancePolicyNumber: v.optional(v.string()),
    insuranceExpiration: v.optional(v.string()),
    insuranceComments: v.optional(v.string()),
    purchaseDate: v.optional(v.string()),
    purchasePrice: v.optional(v.number()),
    ownershipType: v.optional(v.string()),
    lienholder: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, userId, userName, organizationId, ...updates } = args;

    // Get current trailer data for audit log
    const trailer = await ctx.db.get(id);

    await ctx.db.patch(id, {
      ...updates,
      updatedAt: Date.now(),
    });

    // Log the update if audit info provided
    if (userId && trailer && organizationId) {
      const changedFields = Object.keys(updates).filter((key) => key !== 'updatedAt');
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId,
        entityType: 'trailer',
        entityId: id,
        entityName: `${trailer.unitId}`,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        description: `Updated trailer ${trailer.unitId}`,
        changedFields,
        changesAfter: JSON.stringify(updates),
      });
    }

    return id;
  },
});

// Soft delete (deactivate) a trailer
export const deactivate = mutation({
  args: {
    id: v.id('trailers'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get trailer data before deactivation
    const trailer = await ctx.db.get(args.id);
    if (!trailer) throw new Error('Trailer not found');

    await ctx.db.patch(args.id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: args.userId,
      status: 'Sold', // Change status when deactivated
      updatedAt: Date.now(),
    });

    // Log the deactivation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: trailer.organizationId,
      entityType: 'trailer',
      entityId: args.id,
      entityName: `${trailer.unitId}`,
      action: 'deactivated',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deactivated trailer ${trailer.unitId}`,
    });

    return args.id;
  },
});

// Bulk deactivate trailers
export const bulkDeactivate = mutation({
  args: {
    ids: v.array(v.id('trailers')),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const results = [];
    for (const id of args.ids) {
      try {
        // Get trailer data before deactivation
        const trailer = await ctx.db.get(id);
        if (!trailer) {
          results.push({ id, success: false, error: 'Trailer not found' });
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
          organizationId: trailer.organizationId,
          entityType: 'trailer',
          entityId: id,
          entityName: `${trailer.unitId}`,
          action: 'deactivated',
          performedBy: args.userId,
          performedByName: args.userName,
          description: `Deactivated trailer ${trailer.unitId}`,
        });

        results.push({ id, success: true });
      } catch (error) {
        results.push({ id, success: false, error: String(error) });
      }
    }
    return results;
  },
});
