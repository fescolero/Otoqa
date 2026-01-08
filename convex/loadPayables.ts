import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';

/**
 * Load Payables - Calculated pay line items
 * The actual money lines displayed in UI
 */

// Get all payables for a load (grouped by leg/driver)
export const getByLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Enrich with driver and leg details
    const enrichedPayables = await Promise.all(
      payables.map(async (payable) => {
        const [driver, leg] = await Promise.all([
          ctx.db.get(payable.driverId),
          payable.legId ? ctx.db.get(payable.legId) : null,
        ]);

        return {
          ...payable,
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown',
          legSequence: leg?.sequence ?? 1,
        };
      })
    );

    // Group by leg for UI display
    const grouped: Record<string, typeof enrichedPayables> = {};
    for (const payable of enrichedPayables) {
      const key = payable.legId ?? 'unassigned';
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(payable);
    }

    // Calculate totals
    const total = payables.reduce((sum, p) => sum + p.totalAmount, 0);
    const hasWarnings = payables.some((p) => p.warningMessage);

    return {
      payables: enrichedPayables,
      grouped,
      total,
      hasWarnings,
    };
  },
});

// Get all payables for a driver (for settlement view)
export const getByDriver = query({
  args: {
    driverId: v.id('drivers'),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let payablesQuery = ctx.db
      .query('loadPayables')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId));

    const payables = await payablesQuery.collect();

    // Filter by date range if provided
    let filtered = payables;
    if (args.startDate || args.endDate) {
      filtered = payables.filter((p) => {
        if (args.startDate && p.createdAt < args.startDate) return false;
        if (args.endDate && p.createdAt > args.endDate) return false;
        return true;
      });
    }

    // Enrich with load details
    const enrichedPayables = await Promise.all(
      filtered.map(async (payable) => {
        if (!payable.loadId) {
          return {
            ...payable,
            loadInternalId: undefined,
            loadOrderNumber: undefined,
          };
        }
        const load = await ctx.db.get(payable.loadId);
        return {
          ...payable,
          loadInternalId: load?.internalId,
          loadOrderNumber: load?.orderNumber,
        };
      })
    );

    // Calculate totals
    const total = enrichedPayables.reduce((sum, p) => sum + p.totalAmount, 0);

    return {
      payables: enrichedPayables,
      total,
      count: enrichedPayables.length,
    };
  },
});

// Get a single payable by ID
export const get = query({
  args: {
    payableId: v.id('loadPayables'),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.payableId);
  },
});

// Add a manual pay line item
export const addManual = mutation({
  args: {
    loadId: v.id('loadInformation'),
    legId: v.optional(v.id('dispatchLegs')),
    driverId: v.id('drivers'),
    description: v.string(),
    quantity: v.number(),
    rate: v.number(),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

    const totalAmount = args.quantity * args.rate;
    const now = Date.now();

    const payableId = await ctx.db.insert('loadPayables', {
      loadId: args.loadId,
      legId: args.legId,
      driverId: args.driverId,
      description: args.description,
      quantity: args.quantity,
      rate: args.rate,
      totalAmount,
      sourceType: 'MANUAL',
      isLocked: true, // Manual items are always locked
      workosOrgId: load.workosOrgId,
      createdAt: now,
      createdBy: args.userId,
    });

    // Get driver name for logging
    const driver = await ctx.db.get(args.driverId);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: load.workosOrgId,
      entityType: 'loadPayable',
      entityId: payableId,
      entityName: args.description,
      action: 'created',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Added manual pay "${args.description}" ($${totalAmount.toFixed(2)}) for ${driver?.firstName} ${driver?.lastName}`,
    });

    return payableId;
  },
});

// Update a payable (editing sets isLocked = true)
export const update = mutation({
  args: {
    payableId: v.id('loadPayables'),
    description: v.optional(v.string()),
    quantity: v.optional(v.number()),
    rate: v.optional(v.number()),
    totalAmount: v.optional(v.number()), // Allow direct total override
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    if (!payable) throw new Error('Payable not found');

    const { payableId, userId, userName, ...updates } = args;

    // Calculate new total if qty or rate changed
    let newTotal = payable.totalAmount;
    if (updates.totalAmount !== undefined) {
      newTotal = updates.totalAmount;
    } else if (updates.quantity !== undefined || updates.rate !== undefined) {
      const qty = updates.quantity ?? payable.quantity;
      const rate = updates.rate ?? payable.rate;
      newTotal = qty * rate;
    }

    // Build update object
    const updateData: Record<string, unknown> = {
      isLocked: true, // Always lock on edit
    };
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.quantity !== undefined) updateData.quantity = updates.quantity;
    if (updates.rate !== undefined) updateData.rate = updates.rate;
    updateData.totalAmount = newTotal;

    // If it was a SYSTEM item, mark as MANUAL now
    if (payable.sourceType === 'SYSTEM') {
      updateData.sourceType = 'MANUAL';
    }

    await ctx.db.patch(payableId, updateData);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: payable.workosOrgId,
      entityType: 'loadPayable',
      entityId: payableId,
      entityName: updates.description ?? payable.description,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      description: `Updated pay "${updates.description ?? payable.description}" to $${newTotal.toFixed(2)}`,
      changedFields: Object.keys(updates),
    });

    return payableId;
  },
});

// Delete a payable (only manual items can be deleted by users)
export const remove = mutation({
  args: {
    payableId: v.id('loadPayables'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    if (!payable) throw new Error('Payable not found');

    // Only allow deleting manual items
    if (payable.sourceType === 'SYSTEM' && !payable.isLocked) {
      throw new Error('Cannot delete system-calculated items. Use recalculate instead.');
    }

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: payable.workosOrgId,
      entityType: 'loadPayable',
      entityId: args.payableId,
      entityName: payable.description,
      action: 'deleted',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deleted pay "${payable.description}" ($${payable.totalAmount.toFixed(2)})`,
    });

    await ctx.db.delete(args.payableId);

    return args.payableId;
  },
});

// Recalculate pay for a leg (triggered by UI button)
export const recalculate = mutation({
  args: {
    legId: v.id('dispatchLegs'),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');

    if (!leg.driverId) {
      throw new Error('Cannot recalculate pay: no driver assigned');
    }

    // Trigger recalculation
    await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
      legId: args.legId,
      userId: args.userId,
    });

    return args.legId;
  },
});

// Get summary statistics for an organization
export const getOrgSummary = query({
  args: {
    workosOrgId: v.string(),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();

    // Filter by date range
    let filtered = payables;
    if (args.startDate || args.endDate) {
      filtered = payables.filter((p) => {
        if (args.startDate && p.createdAt < args.startDate) return false;
        if (args.endDate && p.createdAt > args.endDate) return false;
        return true;
      });
    }

    // Calculate summary
    const totalAmount = filtered.reduce((sum, p) => sum + p.totalAmount, 0);
    const systemTotal = filtered
      .filter((p) => p.sourceType === 'SYSTEM')
      .reduce((sum, p) => sum + p.totalAmount, 0);
    const manualTotal = filtered
      .filter((p) => p.sourceType === 'MANUAL')
      .reduce((sum, p) => sum + p.totalAmount, 0);
    const lockedTotal = filtered
      .filter((p) => p.isLocked)
      .reduce((sum, p) => sum + p.totalAmount, 0);

    // Count by driver
    const byDriver: Record<string, number> = {};
    for (const p of filtered) {
      const key = p.driverId;
      byDriver[key] = (byDriver[key] ?? 0) + p.totalAmount;
    }

    return {
      totalAmount,
      systemTotal,
      manualTotal,
      lockedTotal,
      count: filtered.length,
      driverCount: Object.keys(byDriver).length,
      byDriver,
    };
  },
});

// Unlock a payable (admin only - allows recalculation to overwrite)
export const unlock = mutation({
  args: {
    payableId: v.id('loadPayables'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    if (!payable) throw new Error('Payable not found');

    await ctx.db.patch(args.payableId, {
      isLocked: false,
    });

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: payable.workosOrgId,
      entityType: 'loadPayable',
      entityId: args.payableId,
      entityName: payable.description,
      action: 'unlocked',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Unlocked pay "${payable.description}" for recalculation`,
    });

    return args.payableId;
  },
});
