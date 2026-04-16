import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { paginationOptsValidator } from 'convex/server';
import type { Id } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';

const paymentMethodValidator = v.optional(
  v.union(
    v.literal('FUEL_CARD'),
    v.literal('CASH'),
    v.literal('CHECK'),
    v.literal('CREDIT_CARD'),
    v.literal('EFS'),
    v.literal('COMDATA'),
  ),
);

const locationValidator = v.optional(
  v.object({
    city: v.string(),
    state: v.string(),
  }),
);

const listArgs = {
  organizationId: v.string(),
  dateRangeStart: v.optional(v.number()),
  dateRangeEnd: v.optional(v.number()),
  driverId: v.optional(v.id('drivers')),
  carrierId: v.optional(v.id('carrierPartnerships')),
  truckId: v.optional(v.id('trucks')),
  vendorId: v.optional(v.id('fuelVendors')),
  search: v.optional(v.string()),
};

interface DefListFilters {
  organizationId: string;
  dateRangeStart?: number;
  dateRangeEnd?: number;
  driverId?: Id<'drivers'>;
  carrierId?: Id<'carrierPartnerships'>;
  truckId?: Id<'trucks'>;
  vendorId?: Id<'fuelVendors'>;
  search?: string;
}

function buildDefEntriesQuery(ctx: any, args: DefListFilters) {
  return ctx.db
    .query('defEntries')
    .withIndex('by_organization_and_date', (q: any) => {
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
}

function matchesDefFilters(entry: any, args: DefListFilters) {
  if (args.driverId && entry.driverId !== args.driverId) {
    return false;
  }
  if (args.carrierId && entry.carrierId !== args.carrierId) {
    return false;
  }
  if (args.truckId && entry.truckId !== args.truckId) {
    return false;
  }
  if (args.vendorId && entry.vendorId !== args.vendorId) {
    return false;
  }
  return true;
}

function matchesDefSearch(entry: any, search: string | undefined) {
  if (!search) {
    return true;
  }

  const normalizedSearch = search.trim().toLowerCase();
  if (!normalizedSearch) {
    return true;
  }

  const haystack = [
    entry.vendorName,
    entry.driverName,
    entry.carrierName,
    entry.truckUnitId,
    entry.receiptNumber,
    entry.fuelCardNumber,
    entry.paymentMethod,
    entry.notes,
    entry.location ? `${entry.location.city}, ${entry.location.state}` : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return haystack.includes(normalizedSearch);
}

async function enrichDefEntry(ctx: any, entry: any) {
  const [vendor, driver, carrier, truck] = (await Promise.all([
    ctx.db.get(entry.vendorId),
    entry.driverId ? ctx.db.get(entry.driverId) : null,
    entry.carrierId ? ctx.db.get(entry.carrierId) : null,
    entry.truckId ? ctx.db.get(entry.truckId) : null,
  ])) as any[];

  return {
    ...entry,
    vendorName: vendor?.name ?? 'Unknown',
    driverName: driver ? `${driver.firstName} ${driver.lastName}` : undefined,
    carrierName: carrier?.carrierName ?? undefined,
    truckUnitId: truck?.unitId ?? undefined,
  };
}

export const list = query({
  args: {
    ...listArgs,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const filters: DefListFilters = args;
    const result = await buildDefEntriesQuery(ctx, filters).paginate(args.paginationOpts);
    const filtered = result.page.filter((entry: any) => matchesDefFilters(entry, filters));

    const enriched = await Promise.all(filtered.map((entry: any) => enrichDefEntry(ctx, entry)));
    const searched = enriched.filter((entry: any) => matchesDefSearch(entry, filters.search));

    return {
      ...result,
      page: searched,
    };
  },
});

export const count = query({
  args: listArgs,
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const filters: DefListFilters = args;
    const entries = await buildDefEntriesQuery(ctx, filters).collect();
    const filtered = entries.filter((entry: any) => matchesDefFilters(entry, filters));
    const enriched = await Promise.all(filtered.map((entry: any) => enrichDefEntry(ctx, entry)));
    return enriched.filter((entry: any) => matchesDefSearch(entry, filters.search)).length;
  },
});

export const get = query({
  args: {
    entryId: v.id('defEntries'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const entry = await ctx.db.get(args.entryId);
    if (!entry || entry.organizationId !== callerOrgId) return null;

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
      loadReference: load ? ((load as Record<string, unknown>).referenceNumber as string | undefined) : undefined,
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
    const { userId } = await assertCallerOwnsOrg(ctx, args.organizationId);
    const now = Date.now();
    const totalCost = Math.round(args.gallons * args.pricePerGallon * 100) / 100;

    const entryId = await ctx.db.insert('defEntries', {
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
      createdBy: userId,
    });

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'defEntry',
      entityId: entryId,
      action: 'CREATE',
      performedBy: userId,
      description: `Created DEF entry: ${args.gallons} gal @ $${args.pricePerGallon}/gal = $${totalCost}`,
    });

    return entryId;
  },
});

export const update = mutation({
  args: {
    entryId: v.id('defEntries'),
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
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const existing = await ctx.db.get(args.entryId);
    if (!existing || existing.organizationId !== callerOrgId) throw new Error('DEF entry not found');

    const { entryId, updatedBy: _updatedBy, ...updates } = args;
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
        entityType: 'defEntry',
        entityId: args.entryId,
        action: 'UPDATE',
        performedBy: userId,
        description: `Updated DEF entry`,
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
    entryId: v.id('defEntries'),
    deletedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const existing = await ctx.db.get(args.entryId);
    if (!existing || existing.organizationId !== callerOrgId) throw new Error('DEF entry not found');

    await ctx.db.delete(args.entryId);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: existing.organizationId,
      entityType: 'defEntry',
      entityId: args.entryId,
      action: 'DELETE',
      performedBy: userId,
      description: `Deleted DEF entry: ${existing.gallons} gal @ $${existing.pricePerGallon}/gal`,
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
    entries: v.array(
      v.object({
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
      }),
    ),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const { userId } = await assertCallerOwnsOrg(ctx, args.organizationId);
    const now = Date.now();
    const ids: Array<string> = [];

    for (const entry of args.entries) {
      const totalCost = Math.round(entry.gallons * entry.pricePerGallon * 100) / 100;
      const entryId = await ctx.db.insert('defEntries', {
        organizationId: args.organizationId,
        ...entry,
        totalCost,
        createdAt: now,
        updatedAt: now,
        createdBy: userId,
      });
      ids.push(entryId);
    }

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'defEntry',
      entityId: 'bulk',
      action: 'BULK_CREATE',
      performedBy: userId,
      description: `Bulk imported ${args.entries.length} DEF entries`,
    });

    return ids;
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCallerOrgId(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});
