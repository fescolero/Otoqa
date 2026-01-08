import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';
import { internal } from './_generated/api';

// List all contract lanes for a customer
export const listByCustomer = query({
  args: {
    customerCompanyId: v.id('customers'),
    includeDeleted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const lanes = await ctx.db
      .query('contractLanes')
      .withIndex('by_customer', (q) => q.eq('customerCompanyId', args.customerCompanyId))
      .collect();

    // Filter out deleted lanes unless explicitly requested
    if (!args.includeDeleted) {
      return lanes.filter((lane) => !lane.isDeleted);
    }

    return lanes;
  },
});

// Get a single contract lane by ID
export const get = query({
  args: {
    id: v.id('contractLanes'),
  },
  handler: async (ctx, args) => {
    const lane = await ctx.db.get(args.id);
    return lane;
  },
});

// Create a new contract lane
export const create = mutation({
  args: {
    // Contract Information
    contractName: v.string(),
    contractPeriodStart: v.string(),
    contractPeriodEnd: v.string(),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    lanePriority: v.optional(v.union(v.literal('Primary'), v.literal('Secondary'))),
    notes: v.optional(v.string()),

    // Customer Reference
    customerCompanyId: v.id('customers'),

    // Lane Details
    stops: v.array(
      v.object({
        address: v.string(),
        city: v.string(),
        state: v.string(),
        zip: v.string(),
        stopOrder: v.number(),
        stopType: v.union(v.literal('Pickup'), v.literal('Delivery')),
        type: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),
        arrivalTime: v.string(),
      }),
    ),
    miles: v.optional(v.number()),
    loadCommodity: v.optional(v.string()),

    // Equipment Requirements
    equipmentClass: v.optional(
      v.union(
        v.literal('Bobtail'),
        v.literal('Dry Van'),
        v.literal('Refrigerated'),
        v.literal('Flatbed'),
        v.literal('Tanker'),
      ),
    ),
    equipmentSize: v.optional(v.union(v.literal('53ft'), v.literal('48ft'), v.literal('45ft'))),

    // Rate Information
    rate: v.number(),
    rateType: v.union(v.literal('Per Mile'), v.literal('Flat Rate'), v.literal('Per Stop')),
    currency: v.optional(v.string()),
    minimumRate: v.optional(v.number()),
    minimumQuantity: v.optional(v.number()),

    // Additional Info
    subsidiary: v.optional(v.string()),
    isActive: v.optional(v.boolean()),

    // WorkOS Integration
    workosOrgId: v.string(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const laneId = await ctx.db.insert('contractLanes', {
      // Contract Information
      contractName: args.contractName,
      contractPeriodStart: args.contractPeriodStart,
      contractPeriodEnd: args.contractPeriodEnd,
      hcr: args.hcr,
      tripNumber: args.tripNumber,
      lanePriority: args.lanePriority,
      notes: args.notes,

      // Customer Reference
      customerCompanyId: args.customerCompanyId,

      // Lane Details
      stops: args.stops,
      miles: args.miles,
      loadCommodity: args.loadCommodity,

      // Equipment Requirements
      equipmentClass: args.equipmentClass,
      equipmentSize: args.equipmentSize,

      // Rate Information
      rate: args.rate,
      rateType: args.rateType,
      currency: (args.currency as "USD" | "CAD" | "MXN") || 'USD',
      minimumRate: args.minimumRate,
      minimumQuantity: args.minimumQuantity,

      // Additional Info
      subsidiary: args.subsidiary,
      isActive: args.isActive ?? true,

      // WorkOS Integration
      workosOrgId: args.workosOrgId,
      createdBy: args.createdBy,

      // Timestamps
      createdAt: now,
      updatedAt: now,

      // Soft Delete
      isDeleted: false,
    });

    return laneId;
  },
});

// Update an existing contract lane
export const update = mutation({
  args: {
    id: v.id('contractLanes'),

    // Contract Information
    contractName: v.optional(v.string()),
    contractPeriodStart: v.optional(v.string()),
    contractPeriodEnd: v.optional(v.string()),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    lanePriority: v.optional(v.union(v.literal('Primary'), v.literal('Secondary'))),
    notes: v.optional(v.string()),

    // Lane Details
    stops: v.optional(
      v.array(
        v.object({
          address: v.string(),
          city: v.string(),
          state: v.string(),
          zip: v.string(),
          stopOrder: v.number(),
          stopType: v.union(v.literal('Pickup'), v.literal('Delivery')),
          type: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),
          arrivalTime: v.string(),
        }),
      ),
    ),
    miles: v.optional(v.number()),
    loadCommodity: v.optional(v.string()),

    // Equipment Requirements
    equipmentClass: v.optional(
      v.union(
        v.literal('Bobtail'),
        v.literal('Dry Van'),
        v.literal('Refrigerated'),
        v.literal('Flatbed'),
        v.literal('Tanker'),
      ),
    ),
    equipmentSize: v.optional(v.union(v.literal('53ft'), v.literal('48ft'), v.literal('45ft'))),

    // Rate Information
    rate: v.optional(v.number()),
    rateType: v.optional(v.union(v.literal('Per Mile'), v.literal('Flat Rate'), v.literal('Per Stop'))),
    currency: v.optional(v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))),
    minimumRate: v.optional(v.number()),
    minimumQuantity: v.optional(v.number()),

    // Additional Info
    subsidiary: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;

    await ctx.db.patch(id, {
      ...updates,
      updatedAt: Date.now(),
    });

    return id;
  },
});

// Soft delete a contract lane
export const deactivate = mutation({
  args: {
    id: v.id('contractLanes'),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: args.userId,
      updatedAt: Date.now(),
    });

    return args.id;
  },
});

// Restore a soft-deleted contract lane
export const restore = mutation({
  args: {
    id: v.id('contractLanes'),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, {
      isDeleted: false,
      deletedAt: undefined,
      deletedBy: undefined,
      updatedAt: Date.now(),
    });

    return args.id;
  },
});

// Permanently delete a contract lane
export const permanentDelete = mutation({
  args: {
    id: v.id('contractLanes'),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
    return args.id;
  },
});

// Bulk import contract lanes from CSV
export const bulkImport = mutation({
  args: {
    customerId: v.id('customers'),
    workosOrgId: v.string(),
    userId: v.string(),
    lanes: v.array(
      v.object({
        hcr: v.string(),
        tripNumber: v.string(),
        contractName: v.optional(v.string()),
        rateType: v.union(v.literal('Flat Rate'), v.literal('Per Mile'), v.literal('Per Stop')),
        rate: v.number(),
        contractPeriodStart: v.optional(v.string()),
        contractPeriodEnd: v.optional(v.string()),
      })
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let imported = 0;
    let skipped = 0;

    for (const lane of args.lanes) {
      // Check if lane already exists (same HCR + Trip for this customer)
      const existing = await ctx.db
        .query('contractLanes')
        .withIndex('by_customer', (q) => q.eq('customerCompanyId', args.customerId))
        .filter((q) =>
          q.and(
            q.eq(q.field('hcr'), lane.hcr),
            q.eq(q.field('tripNumber'), lane.tripNumber),
            q.eq(q.field('isDeleted'), false)
          )
        )
        .first();

      if (existing) {
        skipped++;
        continue;
      }

      // Set default contract period if not provided
      const contractPeriodStart = lane.contractPeriodStart || new Date().toISOString().split('T')[0];
      const contractPeriodEnd = lane.contractPeriodEnd || (() => {
        const oneYearLater = new Date();
        oneYearLater.setFullYear(oneYearLater.getFullYear() + 1);
        return oneYearLater.toISOString().split('T')[0];
      })();

      // Insert the lane
      await ctx.db.insert('contractLanes', {
        contractName: lane.contractName || `Lane: ${lane.hcr}/${lane.tripNumber}`,
        contractPeriodStart,
        contractPeriodEnd,
        hcr: lane.hcr,
        tripNumber: lane.tripNumber,
        customerCompanyId: args.customerId,
        stops: [],
        rate: lane.rate,
        rateType: lane.rateType,
        currency: 'USD' as const,
        isActive: true,
        workosOrgId: args.workosOrgId,
        createdBy: args.userId,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      });

      imported++;
    }

    // ✅ REMOVED: periodicCleanup was causing excessive reads (15GB+/day)
    // Promotion is now event-driven via createLaneAndBackfill
    
    return { imported, skipped };
  },
});
