import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';

/**
 * Load Carrier Payables - Calculated carrier pay line items
 * The actual money lines displayed in UI for carrier payments
 * Mirrors loadPayables.ts but for carrier partnerships
 */

// Get all carrier payables for a load (grouped by leg/carrier)
export const getByLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    const payables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Enrich with carrier partnership and leg details
    const enrichedPayables = await Promise.all(
      payables.map(async (payable) => {
        const [partnership, leg] = await Promise.all([
          ctx.db.get(payable.carrierPartnershipId),
          payable.legId ? ctx.db.get(payable.legId) : null,
        ]);

        return {
          ...payable,
          carrierName: partnership?.carrierName ?? 'Unknown',
          carrierMcNumber: partnership?.mcNumber,
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

// Get all payables for a carrier partnership (for settlement view)
export const getByCarrierPartnership = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const payablesQuery = ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId));

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

// Get a single carrier payable by ID
export const get = query({
  args: {
    payableId: v.id('loadCarrierPayables'),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.payableId);
  },
});

// Add a manual carrier pay line item
export const addManual = mutation({
  args: {
    loadId: v.id('loadInformation'),
    legId: v.optional(v.id('dispatchLegs')),
    carrierPartnershipId: v.id('carrierPartnerships'),
    description: v.string(),
    quantity: v.number(),
    rate: v.number(),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

    const partnership = await ctx.db.get(args.carrierPartnershipId);
    if (!partnership) throw new Error('Carrier partnership not found');

    const totalAmount = args.quantity * args.rate;
    const now = Date.now();

    const payableId = await ctx.db.insert('loadCarrierPayables', {
      loadId: args.loadId,
      legId: args.legId,
      carrierPartnershipId: args.carrierPartnershipId,
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

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: load.workosOrgId,
      entityType: 'loadCarrierPayable',
      entityId: payableId,
      entityName: args.description,
      action: 'created',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Added manual carrier pay "${args.description}" ($${totalAmount.toFixed(2)}) for ${partnership.carrierName}`,
    });

    return payableId;
  },
});

// Update a carrier payable (editing sets isLocked = true)
export const update = mutation({
  args: {
    payableId: v.id('loadCarrierPayables'),
    description: v.optional(v.string()),
    quantity: v.optional(v.number()),
    rate: v.optional(v.number()),
    totalAmount: v.optional(v.number()), // Allow direct total override
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    if (!payable) throw new Error('Carrier payable not found');

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
      updatedAt: Date.now(),
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
      entityType: 'loadCarrierPayable',
      entityId: payableId,
      entityName: updates.description ?? payable.description,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      description: `Updated carrier pay "${updates.description ?? payable.description}" to $${newTotal.toFixed(2)}`,
      changedFields: Object.keys(updates),
    });

    return payableId;
  },
});

// Delete a carrier payable (only manual items can be deleted by users)
export const remove = mutation({
  args: {
    payableId: v.id('loadCarrierPayables'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    if (!payable) throw new Error('Carrier payable not found');

    // Only allow deleting manual items
    if (payable.sourceType === 'SYSTEM' && !payable.isLocked) {
      throw new Error('Cannot delete system-calculated items. Use recalculate instead.');
    }

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: payable.workosOrgId,
      entityType: 'loadCarrierPayable',
      entityId: args.payableId,
      entityName: payable.description,
      action: 'deleted',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Deleted carrier pay "${payable.description}" ($${payable.totalAmount.toFixed(2)})`,
    });

    await ctx.db.delete(args.payableId);

    return args.payableId;
  },
});

// Recalculate carrier pay for a leg (triggered by UI button)
export const recalculate = mutation({
  args: {
    legId: v.id('dispatchLegs'),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');

    if (!leg.carrierPartnershipId) {
      throw new Error('Cannot recalculate carrier pay: no carrier assigned');
    }

    // Trigger recalculation
    await ctx.runMutation(internal.carrierPayCalculation.calculateCarrierPay, {
      legId: args.legId,
      userId: args.userId,
    });

    return args.legId;
  },
});

// Get summary statistics for carrier payables in an organization
export const getOrgSummary = query({
  args: {
    workosOrgId: v.string(),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const payables = await ctx.db
      .query('loadCarrierPayables')
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

    // Calculate totals
    const totalAmount = filtered.reduce((sum, p) => sum + p.totalAmount, 0);
    const systemTotal = filtered
      .filter((p) => p.sourceType === 'SYSTEM')
      .reduce((sum, p) => sum + p.totalAmount, 0);
    const manualTotal = filtered
      .filter((p) => p.sourceType === 'MANUAL')
      .reduce((sum, p) => sum + p.totalAmount, 0);
    const pendingSettlement = filtered
      .filter((p) => !p.settlementId)
      .reduce((sum, p) => sum + p.totalAmount, 0);

    return {
      totalAmount,
      systemTotal,
      manualTotal,
      pendingSettlement,
      payableCount: filtered.length,
    };
  },
});

// Get unassigned carrier payables (not yet in a settlement)
export const getUnassigned = query({
  args: {
    carrierPartnershipId: v.id('carrierPartnerships'),
  },
  handler: async (ctx, args) => {
    // Query all payables for this carrier
    const allPayables = await ctx.db
      .query('loadCarrierPayables')
      .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.carrierPartnershipId))
      .collect();

    // Filter to only unassigned (no settlementId)
    const payables = allPayables.filter((p) => !p.settlementId);

    // Enrich with load info
    const enrichedPayables = await Promise.all(
      payables.map(async (payable) => {
        const load = payable.loadId ? await ctx.db.get(payable.loadId) : null;
        return {
          ...payable,
          loadOrderNumber: load?.orderNumber,
          loadInternalId: load?.internalId,
        };
      })
    );

    const total = enrichedPayables.reduce((sum, p) => sum + p.totalAmount, 0);

    return {
      payables: enrichedPayables,
      total,
      count: enrichedPayables.length,
    };
  },
});

// Assign carrier payables to a settlement
export const assignToSettlement = mutation({
  args: {
    payableIds: v.array(v.id('loadCarrierPayables')),
    settlementId: v.id('carrierSettlements'),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    // Only allow assigning to DRAFT settlements
    if (settlement.status !== 'DRAFT') {
      throw new Error('Can only assign payables to DRAFT settlements');
    }

    const now = Date.now();
    let totalAdded = 0;

    for (const payableId of args.payableIds) {
      const payable = await ctx.db.get(payableId);
      if (!payable) continue;

      // Verify payable belongs to same carrier partnership
      if (payable.carrierPartnershipId !== settlement.carrierPartnershipId) {
        throw new Error('Payable does not belong to this carrier');
      }

      // Skip if already assigned
      if (payable.settlementId) continue;

      await ctx.db.patch(payableId, {
        settlementId: args.settlementId,
        updatedAt: now,
      });

      totalAdded += payable.totalAmount;
    }

    // Update settlement totals
    const newGross = settlement.totalGross + totalAdded;
    await ctx.db.patch(args.settlementId, {
      totalGross: newGross,
      totalNet: newGross - (settlement.totalDeductions ?? 0),
      updatedAt: now,
    });

    return {
      assignedCount: args.payableIds.length,
      totalAdded,
    };
  },
});

// Remove carrier payables from a settlement
export const removeFromSettlement = mutation({
  args: {
    payableIds: v.array(v.id('loadCarrierPayables')),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    let totalRemoved = 0;
    let settlementId: Id<'carrierSettlements'> | null = null;

    for (const payableId of args.payableIds) {
      const payable = await ctx.db.get(payableId);
      if (!payable || !payable.settlementId) continue;

      // Track the settlement for updating totals
      if (!settlementId) {
        settlementId = payable.settlementId;
      }

      // Verify settlement is in DRAFT status
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement?.status !== 'DRAFT') {
        throw new Error('Can only remove payables from DRAFT settlements');
      }

      await ctx.db.patch(payableId, {
        settlementId: undefined,
        updatedAt: now,
      });

      totalRemoved += payable.totalAmount;
    }

    // Update settlement totals if we had one
    if (settlementId) {
      const settlement = await ctx.db.get(settlementId);
      if (settlement) {
        const newGross = settlement.totalGross - totalRemoved;
        await ctx.db.patch(settlementId, {
          totalGross: newGross,
          totalNet: newGross - (settlement.totalDeductions ?? 0),
          updatedAt: now,
        });
      }
    }

    return {
      removedCount: args.payableIds.length,
      totalRemoved,
    };
  },
});
