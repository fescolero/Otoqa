import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';
import {
  getLegTimeRange,
  doTimeRangesOverlap,
  calculateOverlapMinutes,
  detectDriverOverlaps,
  parseStopDateTime,
} from './_helpers/timeUtils';
import type { OverlapInfo } from './_helpers/timeUtils';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';

/**
 * Dispatch Legs - The atomic unit of work
 * A Load can have multiple Legs (for splits/repowers)
 */

const legStatusValidator = v.union(
  v.literal('PENDING'),
  v.literal('ACTIVE'),
  v.literal('COMPLETED'),
  v.literal('CANCELED')
);

// Response type for assignment mutations
// Assignments always proceed — overlaps are surfaced as insight, not blocks
const overlapInfoValidator = v.object({
  loadId: v.string(),
  orderNumber: v.optional(v.string()),
  overlapMinutes: v.number(),
});

const assignmentResponseValidator = v.union(
  v.object({ status: v.literal('SUCCESS'), overlaps: v.optional(v.array(overlapInfoValidator)) }),
  v.object({ status: v.literal('ERROR'), message: v.string() })
);

// Get all legs for a load
export const getByLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Enrich with driver, truck, trailer details
    const enrichedLegs = await Promise.all(
      legs.map(async (leg) => {
        const [driver, truck, trailer, startStop, endStop] = await Promise.all([
          leg.driverId ? ctx.db.get(leg.driverId) : null,
          leg.truckId ? ctx.db.get(leg.truckId) : null,
          leg.trailerId ? ctx.db.get(leg.trailerId) : null,
          ctx.db.get(leg.startStopId),
          ctx.db.get(leg.endStopId),
        ]);

        return {
          ...leg,
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : null,
          truckUnitId: truck?.unitId ?? null,
          trailerUnitId: trailer?.unitId ?? null,
          startStopCity: startStop?.city,
          startStopState: startStop?.state,
          endStopCity: endStop?.city,
          endStopState: endStop?.state,
        };
      })
    );

    // Sort by sequence
    return enrichedLegs.sort((a, b) => a.sequence - b.sequence);
  },
});

// Get all legs for a driver (with status filter)
export const getByDriver = query({
  args: {
    driverId: v.id('drivers'),
    status: v.optional(legStatusValidator),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) return [];

    let legsQuery = ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => {
        if (args.status) {
          return q.eq('driverId', args.driverId).eq('status', args.status);
        }
        return q.eq('driverId', args.driverId);
      });

    const legs = await legsQuery.collect();

    // Enrich with load details
    const enrichedLegs = await Promise.all(
      legs.map(async (leg) => {
        const load = await ctx.db.get(leg.loadId);
        return {
          ...leg,
          loadInternalId: load?.internalId,
          loadOrderNumber: load?.orderNumber,
          loadStatus: load?.status,
        };
      })
    );

    return enrichedLegs;
  },
});

// Get a single leg by ID
export const get = query({
  args: {
    legId: v.id('dispatchLegs'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const leg = await ctx.db.get(args.legId);
    if (!leg) return null;
    if (leg.workosOrgId !== callerOrgId) return null;

    const [driver, truck, trailer, load] = await Promise.all([
      leg.driverId ? ctx.db.get(leg.driverId) : null,
      leg.truckId ? ctx.db.get(leg.truckId) : null,
      leg.trailerId ? ctx.db.get(leg.trailerId) : null,
      ctx.db.get(leg.loadId),
    ]);

    return {
      ...leg,
      driverName: driver ? `${driver.firstName} ${driver.lastName}` : null,
      truckUnitId: truck?.unitId ?? null,
      trailerUnitId: trailer?.unitId ?? null,
      loadInternalId: load?.internalId,
    };
  },
});

// Create a new leg (usually auto-created when assigning driver to load)
export const create = mutation({
  args: {
    loadId: v.id('loadInformation'),
    driverId: v.optional(v.id('drivers')),
    truckId: v.optional(v.id('trucks')),
    trailerId: v.optional(v.id('trailers')),
    startStopId: v.id('loadStops'),
    endStopId: v.id('loadStops'),
    legLoadedMiles: v.number(),
    legEmptyMiles: v.optional(v.number()),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName } = await requireCallerIdentity(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    // Get existing legs to determine sequence
    const existingLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const maxSequence = existingLegs.reduce((max, l) => Math.max(max, l.sequence), 0);
    const now = Date.now();

    const legId = await ctx.db.insert('dispatchLegs', {
      loadId: args.loadId,
      driverId: args.driverId,
      truckId: args.truckId,
      trailerId: args.trailerId,
      sequence: maxSequence + 1,
      startStopId: args.startStopId,
      endStopId: args.endStopId,
      legLoadedMiles: args.legLoadedMiles,
      legEmptyMiles: args.legEmptyMiles ?? 0,
      status: 'PENDING',
      workosOrgId: load.workosOrgId,
      createdAt: now,
      updatedAt: now,
    });

    // Update primaryDriverId cache if this is the first leg with a driver
    if (args.driverId && !load.primaryDriverId) {
      await ctx.db.patch(args.loadId, { primaryDriverId: args.driverId });
    }

    // Log creation
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: load.workosOrgId,
      entityType: 'dispatchLeg',
      entityId: legId,
      entityName: `Leg ${maxSequence + 1} for Load ${load.internalId}`,
      action: 'created',
      performedBy: userId,
      performedByName: userName,
      description: `Created leg ${maxSequence + 1} for load ${load.internalId}`,
    });

    // Trigger pay calculation if driver is assigned
    if (args.driverId) {
      await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
        legId,
        userId,
      });
    }

    return legId;
  },
});

// Update leg details
export const update = mutation({
  args: {
    legId: v.id('dispatchLegs'),
    driverId: v.optional(v.id('drivers')),
    truckId: v.optional(v.id('trucks')),
    trailerId: v.optional(v.id('trailers')),
    legLoadedMiles: v.optional(v.number()),
    legEmptyMiles: v.optional(v.number()),
    status: v.optional(legStatusValidator),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName } = await requireCallerIdentity(ctx);
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');
    if (leg.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    const { legId, userId: _argUserId, userName: _argUserName, ...updates } = args;
    const now = Date.now();

    // Build update object
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (updates.driverId !== undefined) updateData.driverId = updates.driverId;
    if (updates.truckId !== undefined) updateData.truckId = updates.truckId;
    if (updates.trailerId !== undefined) updateData.trailerId = updates.trailerId;
    if (updates.legLoadedMiles !== undefined) updateData.legLoadedMiles = updates.legLoadedMiles;
    if (updates.legEmptyMiles !== undefined) updateData.legEmptyMiles = updates.legEmptyMiles;
    if (updates.status !== undefined) updateData.status = updates.status;

    await ctx.db.patch(legId, updateData);

    // Log update
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: leg.workosOrgId,
      entityType: 'dispatchLeg',
      entityId: legId,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      description: `Updated leg ${leg.sequence}`,
      changedFields: Object.keys(updates),
    });

    // Recalculate pay if driver or miles changed
    if (updates.driverId !== undefined || updates.legLoadedMiles !== undefined) {
      const finalDriverId = updates.driverId ?? leg.driverId;
      if (finalDriverId) {
        await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
          legId,
          userId,
        });
      }
    }

    return legId;
  },
});

// Assign driver to a load (creates leg if none exists, or updates existing)
// Always proceeds with assignment — overlaps are detected and returned as insight
export const assignDriver = mutation({
  args: {
    loadId: v.id('loadInformation'),
    driverId: v.id('drivers'),
    truckId: v.optional(v.id('trucks')),
    trailerId: v.optional(v.id('trailers')),
    userId: v.string(),
    userName: v.optional(v.string()),
    workosOrgId: v.string(),
  },
  returns: assignmentResponseValidator,
  handler: async (ctx, args) => {
    const { userId, userName } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // 1. Validate driver exists, is active, and not deleted
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || driver.employmentStatus !== 'Active') {
      return { status: 'ERROR' as const, message: 'Driver is inactive or not found' };
    }

    // 2. Validate load exists and is not canceled
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return { status: 'ERROR' as const, message: 'Load not found' };
    }
    if (load.status === 'Canceled') {
      return { status: 'ERROR' as const, message: 'Cannot assign driver to a canceled load' };
    }

    // 3. Get or create legs
    const allLegsForLoad = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    let legs = allLegsForLoad.filter(
      (leg) => leg.status === 'PENDING' || leg.status === 'ACTIVE'
    );

    if (legs.length === 0) {
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      if (stops.length < 2) {
        return { status: 'ERROR' as const, message: 'Load must have at least 2 stops to assign a driver' };
      }

      const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const firstStop = sortedStops[0];
      const lastStop = sortedStops[sortedStops.length - 1];

      const legId = await ctx.db.insert('dispatchLegs', {
        loadId: args.loadId,
        driverId: args.driverId,
        truckId: args.truckId,
        trailerId: args.trailerId,
        sequence: allLegsForLoad.length + 1,
        startStopId: firstStop._id,
        endStopId: lastStop._id,
        legLoadedMiles: load.effectiveMiles ?? 0,
        legEmptyMiles: 0,
        status: 'PENDING',
        workosOrgId: args.workosOrgId,
        createdAt: now,
        updatedAt: now,
      });

      const newLeg = await ctx.db.get(legId);
      if (newLeg) legs = [newLeg];
    }

    // 4. Detect overlaps (informational — never blocks assignment)
    const newLegRanges: ({ start: number; end: number } | null)[] = [];
    for (const leg of legs) {
      const range = await getLegTimeRange(ctx, leg);
      newLegRanges.push(range);
    }

    const overlaps = await detectDriverOverlaps(
      ctx,
      args.driverId,
      newLegRanges,
      args.loadId
    );

    // 5. Delete existing SYSTEM payables (non-locked) for affected legs before recalculating
    for (const leg of legs) {
      const payables = await ctx.db
        .query('loadPayables')
        .withIndex('by_leg', (q) => q.eq('legId', leg._id))
        .collect();

      for (const payable of payables) {
        if (payable.sourceType === 'SYSTEM' && !payable.isLocked) {
          await ctx.db.delete(payable._id);
        }
      }
    }

    // 6. Update all assignable legs (already filtered to PENDING/ACTIVE)
    for (const leg of legs) {
      await ctx.db.patch(leg._id, {
        driverId: args.driverId,
        truckId: args.truckId,
        trailerId: args.trailerId,
        carrierPartnershipId: undefined,
        updatedAt: now,
      });
    }

    // 7. Update load
    const nextStatus = load.status === 'Open' ? 'Assigned' : load.status;
    await ctx.db.patch(args.loadId, {
      primaryDriverId: args.driverId,
      primaryCarrierPartnershipId: undefined,
      status: nextStatus,
      updatedAt: now,
    });

    // 8. Audit log — include overlap context when present
    const overlapNote = overlaps.length > 0
      ? ` (schedule overlap with ${overlaps.map((o) => `Load #${o.orderNumber ?? o.loadId}`).join(', ')})`
      : '';

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'ASSIGN_DRIVER',
      performedBy: userId,
      performedByName: userName,
      description: `Assigned driver ${driver.firstName} ${driver.lastName} to load ${load.orderNumber} (${legs.length} leg${legs.length !== 1 ? 's' : ''} updated)${overlapNote}`,
    });

    // 9. Trigger pay recalculation
    await ctx.runMutation(internal.driverPayCalculation.recalculateForLoad, {
      loadId: args.loadId,
      userId,
    });

    // 10. Return success with overlap insight
    return {
      status: 'SUCCESS' as const,
      overlaps: overlaps.length > 0 ? overlaps : undefined,
    };
  },
});

// Internal version of assignDriver for system calls (auto-assignment, load creation)
// Always proceeds — returns overlap insight alongside SUCCESS for logging/visibility
export const assignDriverInternal = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    driverId: v.id('drivers'),
    truckId: v.optional(v.id('trucks')),
    assignedBy: v.string(),
    assignedByName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: 'SUCCESS' | 'ERROR'; message?: string; overlaps?: OverlapInfo[] }> => {
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.isDeleted || driver.employmentStatus !== 'Active') {
      return { status: 'ERROR', message: 'Driver is inactive or not found' };
    }

    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return { status: 'ERROR', message: 'Load not found' };
    }
    if (load.status === 'Canceled') {
      return { status: 'ERROR', message: 'Cannot assign driver to a canceled load' };
    }

    const allLegsForLoad = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    let assignableLegs = allLegsForLoad.filter(
      (leg) => leg.status === 'PENDING' || leg.status === 'ACTIVE'
    );

    if (assignableLegs.length > 0) {
      for (const leg of assignableLegs) {
        await ctx.db.patch(leg._id, {
          driverId: args.driverId,
          truckId: args.truckId,
          carrierPartnershipId: undefined,
          updatedAt: now,
        });
      }
    } else {
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      if (stops.length < 2) {
        return { status: 'ERROR', message: 'Load must have at least 2 stops' };
      }

      const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const firstStop = sortedStops[0];
      const lastStop = sortedStops[sortedStops.length - 1];

      const legId = await ctx.db.insert('dispatchLegs', {
        loadId: args.loadId,
        driverId: args.driverId,
        truckId: args.truckId,
        sequence: allLegsForLoad.length + 1,
        startStopId: firstStop._id,
        endStopId: lastStop._id,
        legLoadedMiles: load.effectiveMiles ?? 0,
        legEmptyMiles: 0,
        status: 'PENDING',
        workosOrgId: load.workosOrgId,
        createdAt: now,
        updatedAt: now,
      });

      const newLeg = await ctx.db.get(legId);
      if (newLeg) assignableLegs = [newLeg];
    }

    // Detect overlaps for insight (never blocks)
    const legRanges: ({ start: number; end: number } | null)[] = [];
    for (const leg of assignableLegs) {
      const range = await getLegTimeRange(ctx, leg);
      legRanges.push(range);
    }

    const overlaps = await detectDriverOverlaps(
      ctx,
      args.driverId,
      legRanges,
      args.loadId
    );

    // Update load
    await ctx.db.patch(args.loadId, {
      primaryDriverId: args.driverId,
      primaryCarrierPartnershipId: undefined,
      status: 'Assigned',
      updatedAt: now,
    });

    // Audit log — include overlap context
    const overlapNote = overlaps.length > 0
      ? ` (schedule overlap with ${overlaps.map((o) => `Load #${o.orderNumber ?? o.loadId}`).join(', ')})`
      : '';

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: load.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'ASSIGN_DRIVER',
      performedBy: args.assignedBy,
      performedByName: args.assignedByName,
      description: `Auto-assigned driver ${driver.firstName} ${driver.lastName} to load ${load.orderNumber}${overlapNote}`,
    });

    // Trigger pay recalculation
    await ctx.runMutation(internal.driverPayCalculation.recalculateForLoad, {
      loadId: args.loadId,
      userId: args.assignedBy,
    });

    return {
      status: 'SUCCESS',
      overlaps: overlaps.length > 0 ? overlaps : undefined,
    };
  },
});

// Internal version of assignCarrier for system calls
export const assignCarrierInternal = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    carrierPartnershipId: v.id('carrierPartnerships'),
    carrierRate: v.optional(v.number()),
    assignedBy: v.string(),
    assignedByName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: 'SUCCESS' | 'ERROR'; message?: string }> => {
    const carrier = await ctx.db.get(args.carrierPartnershipId);
    if (!carrier || carrier.status !== 'ACTIVE') {
      return { status: 'ERROR', message: 'Carrier is inactive or not found' };
    }

    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return { status: 'ERROR', message: 'Load not found' };
    }
    if (load.status === 'Canceled') {
      return { status: 'ERROR', message: 'Cannot assign carrier to a canceled load' };
    }

    const allLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    const assignableLegs = allLegs.filter(
      (leg) => leg.status === 'PENDING' || leg.status === 'ACTIVE'
    );

    if (assignableLegs.length > 0) {
      // Update existing PENDING/ACTIVE legs
      for (const leg of assignableLegs) {
        await ctx.db.patch(leg._id, {
          carrierPartnershipId: args.carrierPartnershipId,
          driverId: undefined,
          truckId: undefined,
          updatedAt: now,
        });
      }
    } else {
      // No assignable legs — create a new one
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      if (stops.length < 2) {
        return { status: 'ERROR', message: 'Load must have at least 2 stops' };
      }

      const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const firstStop = sortedStops[0];
      const lastStop = sortedStops[sortedStops.length - 1];

      await ctx.db.insert('dispatchLegs', {
        loadId: args.loadId,
        carrierPartnershipId: args.carrierPartnershipId,
        sequence: allLegs.length + 1,
        startStopId: firstStop._id,
        endStopId: lastStop._id,
        legLoadedMiles: load.effectiveMiles ?? 0,
        legEmptyMiles: 0,
        status: 'PENDING',
        workosOrgId: load.workosOrgId,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Update load
    await ctx.db.patch(args.loadId, {
      primaryCarrierPartnershipId: args.carrierPartnershipId,
      primaryDriverId: undefined,
      status: 'Assigned',
      updatedAt: now,
    });

    // Create loadCarrierAssignment so the carrier can see this load on mobile
    const existingAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();
    const hasActiveAssignment = existingAssignments.some(
      (a) => a.status === 'AWARDED' || a.status === 'IN_PROGRESS'
    );
    if (!hasActiveAssignment) {
      await ctx.db.insert('loadCarrierAssignments', {
        loadId: args.loadId,
        brokerOrgId: load.workosOrgId,
        carrierOrgId: carrier.carrierOrgId,
        partnershipId: args.carrierPartnershipId,
        carrierName: carrier.carrierName,
        carrierMcNumber: carrier.mcNumber,
        carrierRate: args.carrierRate,
        carrierRateType: 'FLAT',
        currency: 'USD',
        carrierTotalAmount: args.carrierRate,
        usePayProfile: args.carrierRate === undefined,
        status: 'AWARDED',
        offeredAt: now,
        acceptedAt: now,
        awardedAt: now,
        createdBy: args.assignedBy,
      });
    }

    // Audit log
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: load.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'ASSIGN_CARRIER',
      performedBy: args.assignedBy,
      performedByName: args.assignedByName,
      description: `Auto-assigned carrier ${carrier.carrierName} to load ${load.orderNumber}`,
    });

    // Trigger carrier pay calculation
    await ctx.runMutation(internal.carrierPayCalculation.recalculateForLoad, {
      loadId: args.loadId,
      userId: args.assignedBy,
    });

    return { status: 'SUCCESS' };
  },
});

// Assign carrier partnership to a load (for brokered/outsourced loads)
// Supports "Power Only" scenarios where carrier provides truck but uses your trailer
export const assignCarrier = mutation({
  args: {
    loadId: v.id('loadInformation'),
    carrierPartnershipId: v.id('carrierPartnerships'),
    trailerId: v.optional(v.id('trailers')), // For "Power Only" - carrier truck + your trailer
    userId: v.string(),
    userName: v.optional(v.string()),
    workosOrgId: v.string(),
  },
  returns: assignmentResponseValidator,
  handler: async (ctx, args) => {
    const { userId, userName } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // 1. Validate carrier partnership exists and is active
    const partnership = await ctx.db.get(args.carrierPartnershipId);
    if (!partnership || partnership.status !== 'ACTIVE') {
      return { status: 'ERROR' as const, message: 'Carrier partnership is inactive or not found' };
    }

    // 2. Validate load exists and is not canceled
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return { status: 'ERROR' as const, message: 'Load not found' };
    }
    if (load.status === 'Canceled') {
      return { status: 'ERROR' as const, message: 'Cannot assign carrier to a canceled load' };
    }

    // 3. Get or create legs
    const allLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    const assignableLegs = allLegs.filter(
      (leg) => leg.status === 'PENDING' || leg.status === 'ACTIVE'
    );

    // 4. NO conflict detection for carriers (they can be double-booked)

    if (assignableLegs.length > 0) {
      // 5. Update existing PENDING/ACTIVE legs
      for (const leg of assignableLegs) {
        await ctx.db.patch(leg._id, {
          carrierPartnershipId: args.carrierPartnershipId,
          driverId: undefined,
          truckId: undefined,
          trailerId: args.trailerId,
          updatedAt: now,
        });
      }
    } else {
      // No assignable legs — create a new one
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      if (stops.length < 2) {
        return { status: 'ERROR' as const, message: 'Load must have at least 2 stops to assign a carrier' };
      }

      const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const firstStop = sortedStops[0];
      const lastStop = sortedStops[sortedStops.length - 1];

      await ctx.db.insert('dispatchLegs', {
        loadId: args.loadId,
        carrierPartnershipId: args.carrierPartnershipId,
        trailerId: args.trailerId,
        sequence: allLegs.length + 1,
        startStopId: firstStop._id,
        endStopId: lastStop._id,
        legLoadedMiles: load.effectiveMiles ?? 0,
        legEmptyMiles: 0,
        status: 'PENDING',
        workosOrgId: args.workosOrgId,
        createdAt: now,
        updatedAt: now,
      });
    }

    // 6. Update load - use partnership ID as carrier reference
    const nextStatus = load.status === 'Open' ? 'Assigned' : load.status;
    await ctx.db.patch(args.loadId, {
      primaryCarrierPartnershipId: args.carrierPartnershipId,
      primaryDriverId: undefined,
      status: nextStatus,
      updatedAt: now,
    });

    // 6b. Create loadCarrierAssignment so the carrier can see this load on mobile
    const existingLCA = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();
    const hasActiveLCA = existingLCA.some(
      (a) => a.status === 'AWARDED' || a.status === 'IN_PROGRESS'
    );
    if (!hasActiveLCA) {
      await ctx.db.insert('loadCarrierAssignments', {
        loadId: args.loadId,
        brokerOrgId: args.workosOrgId,
        carrierOrgId: partnership.carrierOrgId,
        partnershipId: args.carrierPartnershipId,
        carrierName: partnership.carrierName,
        carrierMcNumber: partnership.mcNumber,
        status: 'AWARDED',
        usePayProfile: true,
        offeredAt: now,
        acceptedAt: now,
        awardedAt: now,
        createdBy: userId,
      });
    }

    // 7. Audit log
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'ASSIGN_CARRIER',
      performedBy: userId,
      performedByName: userName,
      description: `Assigned carrier ${partnership.carrierName} to load ${load.orderNumber}${args.trailerId ? ' (Power Only)' : ''} (${assignableLegs.length} leg${assignableLegs.length !== 1 ? 's' : ''} updated)`,
    });

    // 8. Calculate carrier pay for each assignable leg
    for (const leg of assignableLegs) {
      await ctx.runMutation(internal.carrierPayCalculation.calculateCarrierPay, {
        legId: leg._id,
        userId,
      });
    }

    // 9. Return success
    return { status: 'SUCCESS' as const };
  },
});

// Unassign all resources from a load (move back to Open status)
export const unassignResource = mutation({
  args: {
    loadId: v.id('loadInformation'),
    userId: v.string(),
    userName: v.optional(v.string()),
    workosOrgId: v.string(),
  },
  returns: assignmentResponseValidator,
  handler: async (ctx, args) => {
    const { userId, userName } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // 1. Validate load exists
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return { status: 'ERROR' as const, message: 'Load not found' };
    }

    // 2. Get all PENDING/ACTIVE legs for the load
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();
    let clearedLegCount = 0;

    // 3. Update each leg - clear all assignments
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          driverId: undefined,
          carrierPartnershipId: undefined,
          truckId: undefined,
          trailerId: undefined,
          updatedAt: now,
        });
        clearedLegCount++;
      }
    }

    // 4. Update load
    await ctx.db.patch(args.loadId, {
      primaryDriverId: undefined,
      primaryCarrierPartnershipId: undefined,
      status: 'Open',
      updatedAt: now,
    });

    // 5. Delete existing SYSTEM payables for cleared legs (non-locked only)
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        const payables = await ctx.db
          .query('loadPayables')
          .withIndex('by_leg', (q) => q.eq('legId', leg._id))
          .collect();

        for (const payable of payables) {
          if (payable.sourceType === 'SYSTEM' && !payable.isLocked) {
            await ctx.db.delete(payable._id);
          }
        }
      }
    }

    // 6. Audit log
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'UNASSIGN_RESOURCE',
      performedBy: userId,
      performedByName: userName,
      description: `Unassigned all resources from load ${load.orderNumber} (${clearedLegCount} leg${clearedLegCount !== 1 ? 's' : ''} cleared)`,
    });

    // 7. Return success
    return { status: 'SUCCESS' as const };
  },
});

// Split load at a specific stop (for repowers)
export const splitAtStop = mutation({
  args: {
    loadId: v.id('loadInformation'),
    splitStopId: v.id('loadStops'), // The stop where the split occurs
    newDriverId: v.id('drivers'),
    newTruckId: v.optional(v.id('trucks')),
    newTrailerId: v.optional(v.id('trailers')),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName } = await requireCallerIdentity(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    // Get all stops
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const sortedStops = stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    // Find the split stop
    const splitStop = sortedStops.find((s) => s._id === args.splitStopId);
    if (!splitStop) throw new Error('Split stop not found');

    const splitIndex = sortedStops.findIndex((s) => s._id === args.splitStopId);
    if (splitIndex === 0) throw new Error('Cannot split at the first stop');
    if (splitIndex === sortedStops.length - 1) {
      throw new Error('Cannot split at the last stop');
    }

    // Get existing leg (Leg A - will be truncated)
    const existingLeg = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .filter((q) => q.eq(q.field('sequence'), 1))
      .first();

    if (!existingLeg) throw new Error('No existing leg to split');

    const now = Date.now();
    const firstStop = sortedStops[0];
    const lastStop = sortedStops[sortedStops.length - 1];

    // Calculate miles for each leg (proportional split based on stop position)
    const totalMiles = load.effectiveMiles ?? 0;
    const legAStopCount = splitIndex + 1; // Include split stop
    const legBStopCount = sortedStops.length - splitIndex;
    const totalStops = sortedStops.length;

    // Simple proportional split (could be enhanced with actual distance calculation)
    const legAMiles = Math.round((totalMiles * legAStopCount) / totalStops);
    const legBMiles = totalMiles - legAMiles;

    // Update Leg A: truncate to end at split stop
    await ctx.db.patch(existingLeg._id, {
      endStopId: args.splitStopId,
      legLoadedMiles: legAMiles,
      updatedAt: now,
    });

    // Create Leg B: starts at split stop, ends at final destination
    const legBId = await ctx.db.insert('dispatchLegs', {
      loadId: args.loadId,
      driverId: args.newDriverId,
      truckId: args.newTruckId,
      trailerId: args.newTrailerId,
      sequence: 2,
      startStopId: args.splitStopId,
      endStopId: lastStop._id,
      legLoadedMiles: legBMiles,
      legEmptyMiles: 0,
      status: 'PENDING',
      workosOrgId: load.workosOrgId,
      createdAt: now,
      updatedAt: now,
    });

    // Get driver names for logging
    const [driverA, driverB] = await Promise.all([
      existingLeg.driverId ? ctx.db.get(existingLeg.driverId) : null,
      ctx.db.get(args.newDriverId),
    ]);

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: load.workosOrgId,
      entityType: 'dispatchLeg',
      entityId: args.loadId,
      entityName: `Load ${load.internalId}`,
      action: 'split',
      performedBy: userId,
      performedByName: userName,
      description: `Split load ${load.internalId} at stop ${splitStop.sequenceNumber}. Leg 1: ${driverA?.firstName ?? 'Unassigned'}, Leg 2: ${driverB?.firstName}`,
    });

    // IMPORTANT: Recalculate pay for BOTH legs
    if (existingLeg.driverId) {
      await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
        legId: existingLeg._id,
        userId,
      });
    }

    await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
      legId: legBId,
      userId,
    });

    return { legAId: existingLeg._id, legBId };
  },
});

// Internal mutation to update leg status (called by other systems)
export const updateStatus = internalMutation({
  args: {
    legId: v.id('dispatchLegs'),
    status: legStatusValidator,
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.legId, {
      status: args.status,
      updatedAt: Date.now(),
    });
  },
});

// Remove driver from a leg
export const removeDriver = mutation({
  args: {
    legId: v.id('dispatchLegs'),
    userId: v.string(),
    userName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName } = await requireCallerIdentity(ctx);
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');
    if (leg.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    const now = Date.now();

    await ctx.db.patch(args.legId, {
      driverId: undefined,
      updatedAt: now,
    });

    // Delete associated payables for this leg
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_leg', (q) => q.eq('legId', args.legId))
      .collect();

    for (const payable of payables) {
      await ctx.db.delete(payable._id);
    }

    // Update load's primaryDriverId if this was the primary
    const load = await ctx.db.get(leg.loadId);
    if (load?.primaryDriverId === leg.driverId) {
      // Find another leg with a driver
      const otherLeg = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
        .filter((q) => q.neq(q.field('_id'), args.legId))
        .first();

      await ctx.db.patch(leg.loadId, {
        primaryDriverId: otherLeg?.driverId ?? undefined,
        updatedAt: now,
      });
    }

    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: leg.workosOrgId,
      entityType: 'dispatchLeg',
      entityId: args.legId,
      action: 'driver_removed',
      performedBy: userId,
      performedByName: userName,
      description: `Removed driver from leg ${leg.sequence}`,
    });

    return args.legId;
  },
});

// Get drivers for a time window with overlap insight
// Returns ALL active drivers — overlapping drivers are flagged, not hidden
export const getAvailableDrivers = query({
  args: {
    workosOrgId: v.string(),
    startTime: v.number(), // Unix timestamp (ms)
    endTime: v.number(), // Unix timestamp (ms)
    excludeLoadId: v.optional(v.id('loadInformation')),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // 1. Get all active drivers for the org (bounded by org headcount).
    const allDrivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .filter((q) =>
        q.and(
          q.eq(q.field('employmentStatus'), 'Active'),
          q.neq(q.field('isDeleted'), true)
        )
      )
      .collect();

    if (allDrivers.length === 0) return [];

    // 2. For each active driver, read ONLY their PENDING and ACTIVE legs via the
    //    compound index [driverId, status]. Selective indexed range — avoids the
    //    full by_org scan (which read every historical leg, including COMPLETED /
    //    CANCELED) that triggered the "too many reads" warning.
    const driverLegPairs = await Promise.all(
      allDrivers.map(async (driver) => {
        const [pendingLegs, activeLegs] = await Promise.all([
          ctx.db
            .query('dispatchLegs')
            .withIndex('by_driver', (q) =>
              q.eq('driverId', driver._id).eq('status', 'PENDING')
            )
            .collect(),
          ctx.db
            .query('dispatchLegs')
            .withIndex('by_driver', (q) =>
              q.eq('driverId', driver._id).eq('status', 'ACTIVE')
            )
            .collect(),
        ]);
        return { driver, legs: [...pendingLegs, ...activeLegs] };
      })
    );

    // 3. Dedup stop IDs across all candidate legs and batch-read once. Legs in
    //    the same load share stops (end of leg N = start of leg N+1), so this
    //    typically cuts stop reads ~25-40%.
    const stopIdSet = new Set<Id<'loadStops'>>();
    for (const { legs } of driverLegPairs) {
      for (const leg of legs) {
        if (args.excludeLoadId && leg.loadId === args.excludeLoadId) continue;
        stopIdSet.add(leg.startStopId);
        stopIdSet.add(leg.endStopId);
      }
    }
    const stopIds = Array.from(stopIdSet);
    const stopDocs = await Promise.all(stopIds.map((id) => ctx.db.get(id)));
    const stopsById = new Map<Id<'loadStops'>, Doc<'loadStops'>>();
    stopIds.forEach((id, i) => {
      const doc = stopDocs[i];
      if (doc) stopsById.set(id, doc);
    });

    // 4. Compute max-overlap-per-driver in memory from the dedup'd stop map.
    const requestedRange = { start: args.startTime, end: args.endTime };
    const winningLegByDriver = new Map<string, { overlapMinutes: number; loadId: Id<'loadInformation'> }>();

    for (const { driver, legs } of driverLegPairs) {
      for (const leg of legs) {
        if (args.excludeLoadId && leg.loadId === args.excludeLoadId) continue;
        const startStop = stopsById.get(leg.startStopId);
        const endStop = stopsById.get(leg.endStopId);
        if (!startStop || !endStop) continue;
        const start = parseStopDateTime(startStop.windowBeginDate, startStop.windowBeginTime);
        const end = parseStopDateTime(endStop.windowBeginDate, endStop.windowBeginTime);
        if (start === null || end === null) continue;
        const legRange = { start, end };
        if (!doTimeRangesOverlap(requestedRange, legRange)) continue;

        const minutes = calculateOverlapMinutes(requestedRange, legRange);
        const existing = winningLegByDriver.get(driver._id);
        if (!existing || minutes > existing.overlapMinutes) {
          winningLegByDriver.set(driver._id, { overlapMinutes: minutes, loadId: leg.loadId });
        }
      }
    }

    // 5. Fetch conflict load docs (one per driver with an overlap) in parallel.
    const driverOverlaps = new Map<string, { overlapMinutes: number; orderNumber?: string; loadId: string }>();
    await Promise.all(
      Array.from(winningLegByDriver.entries()).map(async ([driverId, winner]) => {
        const conflictLoad = await ctx.db.get(winner.loadId);
        driverOverlaps.set(driverId, {
          overlapMinutes: winner.overlapMinutes,
          orderNumber: conflictLoad?.orderNumber,
          loadId: winner.loadId as string,
        });
      })
    );

    // 6. Enrich drivers with truck data and overlap insight (parallel).
    const drivers = await Promise.all(
      allDrivers.map(async (driver) => {
        let truck = null;
        if (driver.currentTruckId) {
          truck = await ctx.db.get(driver.currentTruckId);
        }
        if (!truck) {
          const lastLeg = await ctx.db
            .query('dispatchLegs')
            .withIndex('by_driver', (q) => q.eq('driverId', driver._id))
            .order('desc')
            .first();
          truck = lastLeg?.truckId ? await ctx.db.get(lastLeg.truckId) : null;
        }

        const overlap = driverOverlaps.get(driver._id) ?? null;

        return {
          _id: driver._id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          email: driver.email,
          phone: driver.phone,
          licenseState: driver.licenseState,
          city: driver.city,
          state: driver.state,
          assignedTruck: truck
            ? {
                _id: truck._id,
                unitId: truck.unitId,
                bodyType: truck.bodyType,
                lastLocationLat: truck.lastLocationLat,
                lastLocationLng: truck.lastLocationLng,
                lastLocationUpdatedAt: truck.lastLocationUpdatedAt,
              }
            : null,
          overlap,
        };
      })
    );

    // Sort: available drivers first, then by overlap minutes ascending
    drivers.sort((a, b) => {
      if (!a.overlap && !b.overlap) return 0;
      if (!a.overlap) return -1;
      if (!b.overlap) return 1;
      return a.overlap.overlapMinutes - b.overlap.overlapMinutes;
    });

    return drivers;
  },
});

// Get driver's scheduled legs (for dispatch calendar view)
export const getDriverSchedule = query({
  args: {
    driverId: v.id('drivers'),
    startDate: v.optional(v.number()), // Unix timestamp (ms)
    endDate: v.optional(v.number()), // Unix timestamp (ms)
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) return [];

    // 1. Get all legs for this driver
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
      .collect();

    if (legs.length === 0) return [];

    // 2. Enrich with time ranges and load details
    const enrichedLegs = await Promise.all(
      legs.map(async (leg) => {
        const [load, startStop, endStop, truck, trailer] = await Promise.all([
          ctx.db.get(leg.loadId),
          ctx.db.get(leg.startStopId),
          ctx.db.get(leg.endStopId),
          leg.truckId ? ctx.db.get(leg.truckId) : null,
          leg.trailerId ? ctx.db.get(leg.trailerId) : null,
        ]);

        const timeRange = await getLegTimeRange(ctx, leg);

        return {
          _id: leg._id,
          loadId: leg.loadId,
          sequence: leg.sequence,
          status: leg.status,
          legLoadedMiles: leg.legLoadedMiles,
          legEmptyMiles: leg.legEmptyMiles,
          startTime: timeRange?.start ?? null,
          endTime: timeRange?.end ?? null,
          load: load
            ? {
                _id: load._id,
                orderNumber: load.orderNumber,
                internalId: load.internalId,
                status: load.status,
              }
            : null,
          startStop: startStop
            ? {
                _id: startStop._id,
                address: startStop.address,
                city: startStop.city,
                state: startStop.state,
                windowBeginDate: startStop.windowBeginDate ?? undefined,
                windowBeginTime: startStop.windowBeginTime ?? undefined,
              }
            : null,
          endStop: endStop
            ? {
                _id: endStop._id,
                address: endStop.address,
                city: endStop.city,
                state: endStop.state,
                windowEndDate: endStop.windowEndDate ?? undefined,
                windowEndTime: endStop.windowEndTime ?? undefined,
              }
            : null,
          truck: truck
            ? { _id: truck._id, unitId: truck.unitId }
            : null,
          trailer: trailer
            ? { _id: trailer._id, unitId: trailer.unitId }
            : null,
        };
      })
    );

    // 3. Filter by date range if provided
    let filteredLegs = enrichedLegs;
    if (args.startDate || args.endDate) {
      filteredLegs = enrichedLegs.filter((leg) => {
        if (!leg.startTime) return false;
        if (args.startDate && leg.startTime < args.startDate) return false;
        if (args.endDate && leg.endTime && leg.endTime > args.endDate) return false;
        return true;
      });
    }

    // 4. Sort by start time
    return filteredLegs.sort((a, b) => {
      if (!a.startTime) return 1;
      if (!b.startTime) return -1;
      return a.startTime - b.startTime;
    });
  },
});

// Get ALL active drivers with truck data (for dispatch planner default view)
// Unlike getAvailableDrivers, this returns all drivers regardless of time window
export const getAllActiveDrivers = query({
  args: {
    workosOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    // Get all active drivers for the org
    const allDrivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .filter((q) =>
        q.and(
          q.eq(q.field('employmentStatus'), 'Active'),
          q.neq(q.field('isDeleted'), true)
        )
      )
      .collect();

    if (allDrivers.length === 0) return [];

    // Enrich with truck data
    const driversWithTrucks = await Promise.all(
      allDrivers.map(async (driver) => {
        // Get truck - first try currentTruckId, then fallback to last dispatch leg
        let truck = null;
        if (driver.currentTruckId) {
          truck = await ctx.db.get(driver.currentTruckId);
        }
        if (!truck) {
          // Fallback: check last dispatch leg
          const lastLeg = await ctx.db
            .query('dispatchLegs')
            .withIndex('by_driver', (q) => q.eq('driverId', driver._id))
            .order('desc')
            .first();
          truck = lastLeg?.truckId ? await ctx.db.get(lastLeg.truckId) : null;
        }

        return {
          _id: driver._id,
          firstName: driver.firstName,
          lastName: driver.lastName,
          email: driver.email,
          phone: driver.phone,
          licenseState: driver.licenseState,
          city: driver.city,
          state: driver.state,
          // Equipment data for filtering/display
          assignedTruck: truck
            ? {
                _id: truck._id,
                unitId: truck.unitId,
                bodyType: truck.bodyType,
                // Location for deadhead calculation
                lastLocationLat: truck.lastLocationLat,
                lastLocationLng: truck.lastLocationLng,
                lastLocationUpdatedAt: truck.lastLocationUpdatedAt,
              }
            : null,
        };
      })
    );

    return driversWithTrucks;
  },
});

// ============================================================================
// DRIVER SESSION SYSTEM — Phase 1
// Leg lifecycle hooks driven by check-in / checkout / handoff flows.
// ============================================================================

/**
 * Transition a leg from PENDING to ACTIVE. Called from checkInAtStop when
 * a driver arrives at stop 1 of a leg they own. Idempotent: a leg already
 * ACTIVE is untouched (common on retry).
 *
 * Internal — auth happens in the caller (driverMobile.checkInAtStop).
 */
export const startLeg = internalMutation({
  args: {
    legId: v.id('dispatchLegs'),
    sessionId: v.id('driverSessions'),
    startedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');
    if (leg.status === 'ACTIVE') return null; // idempotent
    if (leg.status !== 'PENDING') {
      throw new Error(`Cannot start leg in status ${leg.status}`);
    }

    await ctx.db.patch(args.legId, {
      status: 'ACTIVE',
      sessionId: args.sessionId,
      startedAt: args.startedAt,
      updatedAt: args.startedAt,
    });
    return null;
  },
});

/**
 * Transition an ACTIVE leg to COMPLETED with a reason. Called from
 * checkOutFromStop on the last stop (endReason='completed'), from the
 * handoff flow (endReason='handoff'), and from session teardown paths
 * (endReason='session_ended').
 *
 * Internal — auth happens in the caller.
 */
export const completeLeg = internalMutation({
  args: {
    legId: v.id('dispatchLegs'),
    endReason: v.union(
      v.literal('completed'),
      v.literal('handoff'),
      v.literal('unassigned'),
      v.literal('session_ended')
    ),
    endedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');
    if (leg.status === 'COMPLETED') return null; // idempotent

    await ctx.db.patch(args.legId, {
      status: 'COMPLETED',
      endedAt: args.endedAt,
      endReason: args.endReason,
      updatedAt: args.endedAt,
    });
    return null;
  },
});

/**
 * Dispatcher-initiated handoff: the driver currently on a load cannot
 * finish it (out of hours, emergency, unreachable, etc.) so a new driver
 * takes over from the current position.
 *
 * Atomic in one mutation:
 *   1. Find from-driver's ACTIVE leg for this load; complete it with
 *      endReason='handoff'.
 *   2. Determine where the new leg starts. Prefer the current tracking
 *      frontier (next unarrived stop); fall back to the old leg's startStop
 *      if no tracking state exists (driver never checked in).
 *   3. Create the new leg for the to-driver (sequence = max + 1, status
 *      PENDING, plannedStartAt = now, carrier partnership preserved).
 *   4. Transfer loadTrackingState to the new driver/session if it exists.
 *   5. Update loadInformation.primaryDriverId if this handoff is on leg 1.
 *   6. If from-driver has no other ACTIVE legs, end their session with
 *      endReason='handoff_complete'.
 *
 * Only dispatchers can initiate.
 */
export const handoffLoad = mutation({
  args: {
    loadId: v.id('loadInformation'),
    fromDriverId: v.id('drivers'),
    toDriverId: v.id('drivers'),
  },
  returns: v.object({
    newLegId: v.id('dispatchLegs'),
    fromSessionEnded: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const caller = await requireCallerIdentity(ctx);

    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');
    if (load.workosOrgId !== caller.orgId) {
      throw new Error('Not authorized for this load');
    }

    const [fromDriver, toDriver] = await Promise.all([
      ctx.db.get(args.fromDriverId),
      ctx.db.get(args.toDriverId),
    ]);
    if (!fromDriver || !toDriver) throw new Error('Driver not found');
    if (toDriver.isDeleted || toDriver.employmentStatus !== 'Active') {
      throw new Error('Destination driver is inactive');
    }
    if (toDriver.organizationId !== caller.orgId) {
      throw new Error('Destination driver not in your organization');
    }

    const now = Date.now();

    // Find the from-driver's ACTIVE leg on this load.
    const activeLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', args.fromDriverId).eq('status', 'ACTIVE'))
      .collect();
    const oldLeg = activeLegs.find((l) => l.loadId === args.loadId);
    if (!oldLeg) throw new Error('From-driver has no active leg on this load');

    // Figure out where the new leg starts. Prefer the tracking frontier
    // (where the from-driver was heading); fall back to the old leg's start.
    const trackingState = await ctx.db
      .query('loadTrackingState')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .first();

    let newLegStartStopId: Id<'loadStops'> = oldLeg.startStopId;
    if (trackingState) {
      const frontierStop = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect()
        .then((stops) =>
          stops.find((s) => s.sequenceNumber === trackingState.currentStopSequenceNumber)
        );
      if (frontierStop) newLegStartStopId = frontierStop._id;
    }

    // Complete the old leg.
    await ctx.db.patch(oldLeg._id, {
      status: 'COMPLETED',
      endedAt: now,
      endReason: 'handoff',
      updatedAt: now,
    });

    // Determine new leg sequence.
    const allLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();
    const maxSequence = Math.max(...allLegs.map((l) => l.sequence));

    // Create the new relay leg. Miles start at 0; pay calc can backfill.
    const newLegId = await ctx.db.insert('dispatchLegs', {
      loadId: args.loadId,
      driverId: args.toDriverId,
      truckId: toDriver.currentTruckId,
      carrierPartnershipId: oldLeg.carrierPartnershipId,
      sequence: maxSequence + 1,
      startStopId: newLegStartStopId,
      endStopId: oldLeg.endStopId,
      legLoadedMiles: 0,
      legEmptyMiles: 0,
      status: 'PENDING',
      plannedStartAt: now,
      workosOrgId: load.workosOrgId,
      createdAt: now,
      updatedAt: now,
    });

    // Transfer tracking state, if present. The new driver's session will
    // be stamped on the tracking state when they check in at the new leg's
    // first stop. For now, clear the tracking state's sessionId binding
    // to the old session by setting driverId — sessionId stays as the old
    // value until the relay driver's session activates on check-in.
    if (trackingState) {
      await ctx.db.patch(trackingState._id, {
        driverId: args.toDriverId,
        updatedAt: now,
      });
    }

    // Maintain the primaryDriverId denorm cache if we just handed off leg 1.
    if (oldLeg.sequence === 1 && load.primaryDriverId === args.fromDriverId) {
      await ctx.db.patch(args.loadId, {
        primaryDriverId: args.toDriverId,
        updatedAt: now,
      });
    }

    // If the from-driver has no other ACTIVE legs, end their session.
    const remainingActive = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_driver', (q) => q.eq('driverId', args.fromDriverId).eq('status', 'ACTIVE'))
      .collect();
    let fromSessionEnded = false;
    if (remainingActive.length === 0 && oldLeg.sessionId) {
      await ctx.runMutation(internal.driverSessions.endSessionForHandoff, {
        sessionId: oldLeg.sessionId,
      });
      fromSessionEnded = true;
    }

    return { newLegId, fromSessionEnded };
  },
});

/**
 * Mobile "what's on my plate" query. Returns PENDING + ACTIVE legs for the
 * driver (the union can't be expressed in a single index scan on
 * by_driver because the compound key is [driverId, status] — so we do two
 * scans and merge).
 *
 * Used by the session-mode home screen's IN PROGRESS + UP NEXT sections.
 */
export const listPlannedAndActiveForDriver = query({
  args: {
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) return [];

    const [pendingLegs, activeLegs] = await Promise.all([
      ctx.db
        .query('dispatchLegs')
        .withIndex('by_driver', (q) => q.eq('driverId', args.driverId).eq('status', 'PENDING'))
        .collect(),
      ctx.db
        .query('dispatchLegs')
        .withIndex('by_driver', (q) => q.eq('driverId', args.driverId).eq('status', 'ACTIVE'))
        .collect(),
    ]);
    const legs = [...activeLegs, ...pendingLegs];

    // Sort: ACTIVE first, then PENDING by plannedStartAt ascending (nulls last).
    legs.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'ACTIVE' ? -1 : 1;
      const aPlan = a.plannedStartAt ?? Number.POSITIVE_INFINITY;
      const bPlan = b.plannedStartAt ?? Number.POSITIVE_INFINITY;
      return aPlan - bPlan;
    });

    return legs;
  },
});

/**
 * Returns drivers in the caller's org who are eligible to take a handoff
 * of the given load — i.e., drivers with no PENDING/ACTIVE legs that
 * overlap the handoff load's remaining scheduled window.
 *
 * "Remaining window" is defined as [now, last-stop scheduled end). Off-
 * shift drivers scheduled later are eligible; drivers on a conflicting
 * load are not.
 *
 * Query-wise this is O(drivers × their legs). Paginate on the client if
 * an org has more than ~500 drivers.
 */
export const getEligibleDriversForHandoff = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const load = await ctx.db.get(args.loadId);
    if (!load || load.workosOrgId !== callerOrgId) return [];

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();
    if (stops.length === 0) return [];
    const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const lastStop = sortedStops[sortedStops.length - 1];
    // Prefer the end of the delivery window; fall back to the begin time; then
    // to "24 hours from now" as a last-ditch bound so we still return a list.
    const handoffEnd =
      parseStopDateTime(lastStop.windowEndDate, lastStop.windowEndTime) ??
      parseStopDateTime(lastStop.windowBeginDate, lastStop.windowBeginTime) ??
      Date.now() + 24 * 60 * 60 * 1000;
    const handoffStart = Date.now();

    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', callerOrgId))
      .collect();
    const activeDrivers = drivers.filter(
      (d) => !d.isDeleted && d.employmentStatus === 'Active'
    );

    const eligible: Doc<'drivers'>[] = [];
    for (const driver of activeDrivers) {
      const conflictLegs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_driver', (q) => q.eq('driverId', driver._id))
        .filter((q) =>
          q.or(q.eq(q.field('status'), 'PENDING'), q.eq(q.field('status'), 'ACTIVE'))
        )
        .collect();

      const hasOverlap = await Promise.all(
        conflictLegs.map(async (leg) => {
          if (leg.loadId === args.loadId) return false; // handoff target itself
          const range = await getLegTimeRange(ctx, leg);
          if (!range) return false;
          return doTimeRangesOverlap(
            { start: handoffStart, end: handoffEnd },
            { start: range.start, end: range.end }
          );
        })
      ).then((flags) => flags.some(Boolean));

      if (!hasOverlap) eligible.push(driver);
    }

    return eligible.map((d) => ({
      _id: d._id,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      currentTruckId: d.currentTruckId,
    }));
  },
});
