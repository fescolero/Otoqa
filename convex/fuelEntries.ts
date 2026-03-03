import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { paginationOptsValidator } from 'convex/server';

const paymentMethodValidator = v.optional(v.union(
  v.literal('FUEL_CARD'),
  v.literal('CASH'),
  v.literal('CHECK'),
  v.literal('CREDIT_CARD'),
  v.literal('EFS'),
  v.literal('COMDATA'),
));

const locationValidator = v.optional(v.object({
  city: v.string(),
  state: v.string(),
}));

export const list = query({
  args: {
    organizationId: v.string(),
    paginationOpts: paginationOptsValidator,
    dateRangeStart: v.optional(v.number()),
    dateRangeEnd: v.optional(v.number()),
    driverId: v.optional(v.id('drivers')),
    carrierId: v.optional(v.id('carrierPartnerships')),
    truckId: v.optional(v.id('trucks')),
    vendorId: v.optional(v.id('fuelVendors')),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    let q = ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) => {
        const base = q.eq('organizationId', args.organizationId);
        if (args.dateRangeStart !== undefined && args.dateRangeEnd !== undefined) {
          return base.gte('entryDate', args.dateRangeStart).lte('entryDate', args.dateRangeEnd);
        }
        if (args.dateRangeStart !== undefined) {
          return base.gte('entryDate', args.dateRangeStart);
        }
        if (args.dateRangeEnd !== undefined) {
          return base.lte('entryDate', args.dateRangeEnd);
        }
        return base;
      })
      .order('desc');

    const result = await q.paginate(args.paginationOpts);

    let filtered = result.page;
    if (args.driverId) {
      filtered = filtered.filter((e) => e.driverId === args.driverId);
    }
    if (args.carrierId) {
      filtered = filtered.filter((e) => e.carrierId === args.carrierId);
    }
    if (args.truckId) {
      filtered = filtered.filter((e) => e.truckId === args.truckId);
    }
    if (args.vendorId) {
      filtered = filtered.filter((e) => e.vendorId === args.vendorId);
    }

    const enriched = await Promise.all(
      filtered.map(async (entry) => {
        const [vendor, driver, carrier, truck] = await Promise.all([
          ctx.db.get(entry.vendorId),
          entry.driverId ? ctx.db.get(entry.driverId) : null,
          entry.carrierId ? ctx.db.get(entry.carrierId) : null,
          entry.truckId ? ctx.db.get(entry.truckId) : null,
        ]);
        return {
          ...entry,
          vendorName: vendor?.name ?? 'Unknown',
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : undefined,
          carrierName: carrier?.carrierName ?? undefined,
          truckUnitId: truck?.unitId ?? undefined,
        };
      })
    );

    return {
      ...result,
      page: enriched,
    };
  },
});

export const get = query({
  args: {
    entryId: v.id('fuelEntries'),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const entry = await ctx.db.get(args.entryId);
    if (!entry) return null;

    const [vendor, driver, carrier, truck, load] = await Promise.all([
      ctx.db.get(entry.vendorId),
      entry.driverId ? ctx.db.get(entry.driverId) : null,
      entry.carrierId ? ctx.db.get(entry.carrierId) : null,
      entry.truckId ? ctx.db.get(entry.truckId) : null,
      entry.loadId ? ctx.db.get(entry.loadId) : null,
    ]);

    let receiptUrl: string | null = null;
    if (entry.receiptStorageId) {
      receiptUrl = await ctx.storage.getUrl(entry.receiptStorageId);
    }

    return {
      ...entry,
      vendorName: vendor?.name ?? 'Unknown',
      driverName: driver ? `${driver.firstName} ${driver.lastName}` : undefined,
      carrierName: carrier?.carrierName ?? undefined,
      truckUnitId: truck?.unitId ?? undefined,
      loadReference: load ? (load as Record<string, unknown>).referenceNumber as string | undefined : undefined,
      receiptUrl,
    };
  },
});

export const create = mutation({
  args: {
    organizationId: v.string(),
    entryDate: v.number(),
    driverId: v.optional(v.id('drivers')),
    carrierId: v.optional(v.id('carrierPartnerships')),
    truckId: v.optional(v.id('trucks')),
    vendorId: v.id('fuelVendors'),
    gallons: v.number(),
    pricePerGallon: v.number(),
    odometerReading: v.optional(v.number()),
    location: locationValidator,
    fuelCardNumber: v.optional(v.string()),
    receiptNumber: v.optional(v.string()),
    loadId: v.optional(v.id('loadInformation')),
    paymentMethod: paymentMethodValidator,
    notes: v.optional(v.string()),
    receiptStorageId: v.optional(v.id('_storage')),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const now = Date.now();
    const totalCost = Math.round(args.gallons * args.pricePerGallon * 100) / 100;

    const entryId = await ctx.db.insert('fuelEntries', {
      organizationId: args.organizationId,
      entryDate: args.entryDate,
      driverId: args.driverId,
      carrierId: args.carrierId,
      truckId: args.truckId,
      vendorId: args.vendorId,
      gallons: args.gallons,
      pricePerGallon: args.pricePerGallon,
      totalCost,
      odometerReading: args.odometerReading,
      location: args.location,
      fuelCardNumber: args.fuelCardNumber,
      receiptNumber: args.receiptNumber,
      loadId: args.loadId,
      paymentMethod: args.paymentMethod,
      notes: args.notes,
      receiptStorageId: args.receiptStorageId,
      createdAt: now,
      updatedAt: now,
      createdBy: args.createdBy,
    });

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'fuelEntry',
      entityId: entryId,
      action: 'CREATE',
      performedBy: args.createdBy,
      description: `Created fuel entry: ${args.gallons} gal @ $${args.pricePerGallon}/gal = $${totalCost}`,
    });

    return entryId;
  },
});

export const update = mutation({
  args: {
    entryId: v.id('fuelEntries'),
    entryDate: v.optional(v.number()),
    driverId: v.optional(v.id('drivers')),
    carrierId: v.optional(v.id('carrierPartnerships')),
    truckId: v.optional(v.id('trucks')),
    vendorId: v.optional(v.id('fuelVendors')),
    gallons: v.optional(v.number()),
    pricePerGallon: v.optional(v.number()),
    odometerReading: v.optional(v.number()),
    location: locationValidator,
    fuelCardNumber: v.optional(v.string()),
    receiptNumber: v.optional(v.string()),
    loadId: v.optional(v.id('loadInformation')),
    paymentMethod: paymentMethodValidator,
    notes: v.optional(v.string()),
    receiptStorageId: v.optional(v.id('_storage')),
    updatedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const existing = await ctx.db.get(args.entryId);
    if (!existing) throw new Error('Fuel entry not found');

    const { entryId, updatedBy, ...updates } = args;
    const changedFields: Array<string> = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && JSON.stringify((existing as Record<string, unknown>)[key]) !== JSON.stringify(value)) {
        changedFields.push(key);
        before[key] = (existing as Record<string, unknown>)[key];
        after[key] = value;
      }
    }

    const gallons = updates.gallons ?? existing.gallons;
    const pricePerGallon = updates.pricePerGallon ?? existing.pricePerGallon;
    const totalCost = Math.round(gallons * pricePerGallon * 100) / 100;

    await ctx.db.patch(args.entryId, {
      ...updates,
      totalCost,
      updatedAt: Date.now(),
    });

    if (changedFields.length > 0) {
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId: existing.organizationId,
        entityType: 'fuelEntry',
        entityId: args.entryId,
        action: 'UPDATE',
        performedBy: updatedBy,
        description: `Updated fuel entry`,
        changesBefore: JSON.stringify(before),
        changesAfter: JSON.stringify(after),
        changedFields,
      });
    }

    return args.entryId;
  },
});

export const remove = mutation({
  args: {
    entryId: v.id('fuelEntries'),
    deletedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const existing = await ctx.db.get(args.entryId);
    if (!existing) throw new Error('Fuel entry not found');

    await ctx.db.delete(args.entryId);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: existing.organizationId,
      entityType: 'fuelEntry',
      entityId: args.entryId,
      action: 'DELETE',
      performedBy: args.deletedBy,
      description: `Deleted fuel entry: ${existing.gallons} gal @ $${existing.pricePerGallon}/gal`,
      changesBefore: JSON.stringify({
        entryDate: existing.entryDate,
        gallons: existing.gallons,
        pricePerGallon: existing.pricePerGallon,
        totalCost: existing.totalCost,
      }),
    });
  },
});

export const bulkCreate = mutation({
  args: {
    organizationId: v.string(),
    entries: v.array(v.object({
      entryDate: v.number(),
      driverId: v.optional(v.id('drivers')),
      carrierId: v.optional(v.id('carrierPartnerships')),
      truckId: v.optional(v.id('trucks')),
      vendorId: v.id('fuelVendors'),
      gallons: v.number(),
      pricePerGallon: v.number(),
      odometerReading: v.optional(v.number()),
      location: locationValidator,
      fuelCardNumber: v.optional(v.string()),
      receiptNumber: v.optional(v.string()),
      loadId: v.optional(v.id('loadInformation')),
      paymentMethod: paymentMethodValidator,
      notes: v.optional(v.string()),
    })),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const now = Date.now();
    const ids: Array<string> = [];

    for (const entry of args.entries) {
      const totalCost = Math.round(entry.gallons * entry.pricePerGallon * 100) / 100;
      const entryId = await ctx.db.insert('fuelEntries', {
        organizationId: args.organizationId,
        ...entry,
        totalCost,
        createdAt: now,
        updatedAt: now,
        createdBy: args.createdBy,
      });
      ids.push(entryId);
    }

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'fuelEntry',
      entityId: 'bulk',
      action: 'BULK_CREATE',
      performedBy: args.createdBy,
      description: `Bulk imported ${args.entries.length} fuel entries`,
    });

    return ids;
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');
    return await ctx.storage.generateUploadUrl();
  },
});
