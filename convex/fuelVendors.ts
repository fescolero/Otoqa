import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';

export const list = query({
  args: {
    organizationId: v.string(),
    activeOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);

    if (args.activeOnly) {
      return await ctx.db
        .query('fuelVendors')
        .withIndex('by_organization_and_active', (q) =>
          q.eq('organizationId', args.organizationId).eq('isActive', true)
        )
        .collect();
    }

    return await ctx.db
      .query('fuelVendors')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.organizationId))
      .collect();
  },
});

export const get = query({
  args: {
    vendorId: v.id('fuelVendors'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const vendor = await ctx.db.get(args.vendorId);
    if (!vendor || vendor.organizationId !== callerOrgId) return null;
    return vendor;
  },
});

export const create = mutation({
  args: {
    organizationId: v.string(),
    name: v.string(),
    code: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    discountProgram: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    addressLine: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const now = Date.now();
    const vendorId = await ctx.db.insert('fuelVendors', {
      organizationId: args.organizationId,
      name: args.name,
      code: args.code,
      accountNumber: args.accountNumber,
      discountProgram: args.discountProgram,
      contactName: args.contactName,
      contactEmail: args.contactEmail,
      contactPhone: args.contactPhone,
      addressLine: args.addressLine,
      city: args.city,
      state: args.state,
      zip: args.zip,
      country: args.country,
      notes: args.notes,
      isActive: true,
      createdAt: now,
      updatedAt: now,
      createdBy: args.createdBy,
    });

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.organizationId,
      entityType: 'fuelVendor',
      entityId: vendorId,
      action: 'CREATE',
      performedBy: args.createdBy,
      description: `Created fuel vendor "${args.name}"`,
    });

    return vendorId;
  },
});

export const update = mutation({
  args: {
    vendorId: v.id('fuelVendors'),
    name: v.optional(v.string()),
    code: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    discountProgram: v.optional(v.string()),
    contactName: v.optional(v.string()),
    contactEmail: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    addressLine: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    country: v.optional(v.string()),
    notes: v.optional(v.string()),
    updatedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const existing = await ctx.db.get(args.vendorId);
    if (!existing || existing.organizationId !== callerOrgId) throw new Error('Vendor not found');

    const { vendorId, updatedBy, ...updates } = args;
    const changedFields: Array<string> = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && (existing as Record<string, unknown>)[key] !== value) {
        changedFields.push(key);
        before[key] = (existing as Record<string, unknown>)[key];
        after[key] = value;
      }
    }

    await ctx.db.patch(args.vendorId, {
      ...updates,
      updatedAt: Date.now(),
    });

    if (changedFields.length > 0) {
      await ctx.runMutation(internal.auditLog.logAction, {
        organizationId: existing.organizationId,
        entityType: 'fuelVendor',
        entityId: args.vendorId,
        action: 'UPDATE',
        performedBy: updatedBy,
        description: `Updated fuel vendor "${existing.name}"`,
        changesBefore: JSON.stringify(before),
        changesAfter: JSON.stringify(after),
        changedFields,
      });
    }

    return args.vendorId;
  },
});

export const toggleActive = mutation({
  args: {
    vendorId: v.id('fuelVendors'),
    updatedBy: v.string(),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const existing = await ctx.db.get(args.vendorId);
    if (!existing || existing.organizationId !== callerOrgId) throw new Error('Vendor not found');

    const newStatus = !existing.isActive;
    await ctx.db.patch(args.vendorId, {
      isActive: newStatus,
      updatedAt: Date.now(),
    });

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: existing.organizationId,
      entityType: 'fuelVendor',
      entityId: args.vendorId,
      action: newStatus ? 'ACTIVATE' : 'DEACTIVATE',
      performedBy: args.updatedBy,
      description: `${newStatus ? 'Activated' : 'Deactivated'} fuel vendor "${existing.name}"`,
    });

    return args.vendorId;
  },
});
