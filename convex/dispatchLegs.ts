import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';
import { getLegTimeRange, doTimeRangesOverlap } from './_helpers/timeUtils';

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

// Response type for assignment mutations (structured responses instead of throws)
const assignmentResponseValidator = v.union(
  v.object({ status: v.literal('SUCCESS') }),
  v.object({
    status: v.literal('CONFLICT'),
    conflictingLoad: v.object({
      orderNumber: v.optional(v.string()),
      loadId: v.id('loadInformation'),
    }),
  }),
  v.object({ status: v.literal('ERROR'), message: v.string() })
);

// Get all legs for a load
export const getByLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
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
    const leg = await ctx.db.get(args.legId);
    if (!leg) return null;

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
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

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
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Created leg ${maxSequence + 1} for load ${load.internalId}`,
    });

    // Trigger pay calculation if driver is assigned
    if (args.driverId) {
      await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
        legId,
        userId: args.userId,
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
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');

    const { legId, userId, userName, ...updates } = args;
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
// Enhanced with conflict detection, structured responses, and accounting-safe updates
export const assignDriver = mutation({
  args: {
    loadId: v.id('loadInformation'),
    driverId: v.id('drivers'),
    truckId: v.optional(v.id('trucks')),
    trailerId: v.optional(v.id('trailers')),
    userId: v.string(),
    userName: v.optional(v.string()),
    workosOrgId: v.string(),
    force: v.optional(v.boolean()), // Skip conflict check if true
  },
  returns: assignmentResponseValidator,
  handler: async (ctx, args) => {
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
    let legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    if (legs.length === 0) {
      // Create default leg from first to last stop
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      if (stops.length < 2) {
        return { status: 'ERROR' as const, message: 'Load must have at least 2 stops to assign a driver' };
      }

      // Sort stops by sequenceNumber (Convex doesn't guarantee order)
      const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const firstStop = sortedStops[0];
      const lastStop = sortedStops[sortedStops.length - 1];

      const legId = await ctx.db.insert('dispatchLegs', {
        loadId: args.loadId,
        driverId: args.driverId,
        truckId: args.truckId,
        trailerId: args.trailerId,
        sequence: 1,
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

    // 4. Conflict detection (skip if force === true)
    if (!args.force) {
      // Get time ranges for the legs of the NEW load
      const newLegRanges: ({ start: number; end: number } | null)[] = [];
      for (const leg of legs) {
        const range = await getLegTimeRange(ctx, leg);
        newLegRanges.push(range);
      }

      // Get all PENDING/ACTIVE legs already assigned to this driver (excluding current load)
      const existingDriverLegs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
        .collect();

      // Filter to only PENDING/ACTIVE and not current load
      const activeDriverLegs = existingDriverLegs.filter(
        (leg) =>
          leg.loadId !== args.loadId &&
          (leg.status === 'PENDING' || leg.status === 'ACTIVE')
      );

      // Check for overlaps
      for (const existingLeg of activeDriverLegs) {
        const existingRange = await getLegTimeRange(ctx, existingLeg);
        if (!existingRange) continue;

        for (const newRange of newLegRanges) {
          if (!newRange) continue;

          if (doTimeRangesOverlap(newRange, existingRange)) {
            const conflictLoad = await ctx.db.get(existingLeg.loadId);
            return {
              status: 'CONFLICT' as const,
              conflictingLoad: {
                orderNumber: conflictLoad?.orderNumber,
                loadId: existingLeg.loadId,
              },
            };
          }
        }
      }
    }

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

    // 6. Update all PENDING/ACTIVE legs
    let updatedLegCount = 0;
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          driverId: args.driverId,
          truckId: args.truckId,
          trailerId: args.trailerId,
          carrierPartnershipId: undefined, // Clear carrier (exclusive assignment)
          updatedAt: now,
        });
        updatedLegCount++;
      }
    }

    // 7. Update load
    const nextStatus = load.status === 'Open' ? 'Assigned' : load.status;
    await ctx.db.patch(args.loadId, {
      primaryDriverId: args.driverId,
      primaryCarrierPartnershipId: undefined, // Clear carrier
      status: nextStatus,
      updatedAt: now,
    });

    // 8. Audit log
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'ASSIGN_DRIVER',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Assigned driver ${driver.firstName} ${driver.lastName} to load ${load.orderNumber} (${updatedLegCount} leg${updatedLegCount !== 1 ? 's' : ''} updated)`,
    });

    // 9. Trigger pay recalculation
    await ctx.runMutation(internal.driverPayCalculation.recalculateForLoad, {
      loadId: args.loadId,
      userId: args.userId,
    });

    // 10. Return success
    return { status: 'SUCCESS' as const };
  },
});

// Internal version of assignDriver for system calls (auto-assignment, load creation)
export const assignDriverInternal = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    driverId: v.id('drivers'),
    truckId: v.optional(v.id('trucks')),
    assignedBy: v.string(),
    assignedByName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ status: 'SUCCESS' | 'ERROR' | 'CONFLICT'; message?: string }> => {
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

    let legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    if (legs.length === 0) {
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
        sequence: 1,
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
      if (newLeg) legs = [newLeg];
    }

    // Update all PENDING/ACTIVE legs
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          driverId: args.driverId,
          truckId: args.truckId,
          carrierPartnershipId: undefined,
          updatedAt: now,
        });
      }
    }

    // Update load
    await ctx.db.patch(args.loadId, {
      primaryDriverId: args.driverId,
      primaryCarrierPartnershipId: undefined,
      status: 'Assigned',
      updatedAt: now,
    });

    // Audit log
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: load.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'ASSIGN_DRIVER',
      performedBy: args.assignedBy,
      performedByName: args.assignedByName,
      description: `Auto-assigned driver ${driver.firstName} ${driver.lastName} to load ${load.orderNumber}`,
    });

    // Trigger pay recalculation
    await ctx.runMutation(internal.driverPayCalculation.recalculateForLoad, {
      loadId: args.loadId,
      userId: args.assignedBy,
    });

    return { status: 'SUCCESS' };
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

    let legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    if (legs.length === 0) {
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
        carrierPartnershipId: args.carrierPartnershipId,
        sequence: 1,
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
      if (newLeg) legs = [newLeg];
    }

    // Update all PENDING/ACTIVE legs
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          carrierPartnershipId: args.carrierPartnershipId,
          driverId: undefined,
          truckId: undefined,
          updatedAt: now,
        });
      }
    }

    // Update load
    await ctx.db.patch(args.loadId, {
      primaryCarrierPartnershipId: args.carrierPartnershipId,
      primaryDriverId: undefined,
      status: 'Assigned',
      updatedAt: now,
    });

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
    let legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const now = Date.now();

    if (legs.length === 0) {
      // Create default leg from first to last stop
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      if (stops.length < 2) {
        return { status: 'ERROR' as const, message: 'Load must have at least 2 stops to assign a carrier' };
      }

      // Sort stops by sequenceNumber (Convex doesn't guarantee order)
      const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      const firstStop = sortedStops[0];
      const lastStop = sortedStops[sortedStops.length - 1];

      const legId = await ctx.db.insert('dispatchLegs', {
        loadId: args.loadId,
        carrierPartnershipId: args.carrierPartnershipId,
        trailerId: args.trailerId, // May be undefined for full carrier service
        sequence: 1,
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

    // 4. NO conflict detection for carriers (they can be double-booked)

    // 5. Update all PENDING/ACTIVE legs
    let updatedLegCount = 0;
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.db.patch(leg._id, {
          carrierPartnershipId: args.carrierPartnershipId,
          driverId: undefined, // Clear driver (exclusive assignment)
          truckId: undefined, // Clear truck (carrier provides power unit)
          trailerId: args.trailerId, // Keep if provided (Power Only), clear if not
          updatedAt: now,
        });
        updatedLegCount++;
      }
    }

    // 6. Update load - use partnership ID as carrier reference
    const nextStatus = load.status === 'Open' ? 'Assigned' : load.status;
    await ctx.db.patch(args.loadId, {
      primaryDriverId: undefined, // Clear driver
      status: nextStatus,
      updatedAt: now,
    });

    // 7. Audit log
    await ctx.runMutation(internal.auditLog.logAction, {
      organizationId: args.workosOrgId,
      entityType: 'LOAD',
      entityId: args.loadId as string,
      entityName: `Load ${load.internalId}`,
      action: 'ASSIGN_CARRIER',
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Assigned carrier ${partnership.carrierName} to load ${load.orderNumber}${args.trailerId ? ' (Power Only)' : ''} (${updatedLegCount} leg${updatedLegCount !== 1 ? 's' : ''} updated)`,
    });

    // 8. Calculate carrier pay for each leg
    for (const leg of legs) {
      if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
        await ctx.runMutation(internal.carrierPayCalculation.calculateCarrierPay, {
          legId: leg._id,
          userId: args.userId,
        });
      }
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
      performedBy: args.userId,
      performedByName: args.userName,
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
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

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
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Split load ${load.internalId} at stop ${splitStop.sequenceNumber}. Leg 1: ${driverA?.firstName ?? 'Unassigned'}, Leg 2: ${driverB?.firstName}`,
    });

    // IMPORTANT: Recalculate pay for BOTH legs
    if (existingLeg.driverId) {
      await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
        legId: existingLeg._id,
        userId: args.userId,
      });
    }

    await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
      legId: legBId,
      userId: args.userId,
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
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');

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
      performedBy: args.userId,
      performedByName: args.userName,
      description: `Removed driver from leg ${leg.sequence}`,
    });

    return args.legId;
  },
});

// Get available drivers for a time window (optimized: legs first, then filter)
// Enhanced to include truck/equipment data for dispatch planning
export const getAvailableDrivers = query({
  args: {
    workosOrgId: v.string(),
    startTime: v.number(), // Unix timestamp (ms)
    endTime: v.number(), // Unix timestamp (ms)
    excludeLoadId: v.optional(v.id('loadInformation')), // Exclude legs from this load
  },
  handler: async (ctx, args) => {
    // 1. Get all legs with drivers in PENDING/ACTIVE status for this org
    const allOrgLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .filter((q) =>
        q.and(
          q.or(
            q.eq(q.field('status'), 'PENDING'),
            q.eq(q.field('status'), 'ACTIVE')
          ),
          q.neq(q.field('driverId'), undefined)
        )
      )
      .collect();

    // 2. Build set of busy driver IDs by checking time overlaps
    const busyDriverIds = new Set<string>();
    const requestedRange = { start: args.startTime, end: args.endTime };

    for (const leg of allOrgLegs) {
      // Skip legs from the excluded load
      if (args.excludeLoadId && leg.loadId === args.excludeLoadId) continue;
      if (!leg.driverId) continue;

      const legRange = await getLegTimeRange(ctx, leg);
      if (!legRange) continue; // Skip legs without valid times

      if (doTimeRangesOverlap(requestedRange, legRange)) {
        busyDriverIds.add(leg.driverId);
      }
    }

    // 3. Get all active drivers for the org
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

    // 4. Filter available and enrich with truck data
    const availableDrivers = [];
    for (const driver of allDrivers) {
      if (busyDriverIds.has(driver._id)) continue;

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

        availableDrivers.push({
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
      });
    }

    return availableDrivers;
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
                windowBeginDate: startStop.windowBeginDate,
                windowBeginTime: startStop.windowBeginTime,
              }
            : null,
          endStop: endStop
            ? {
                _id: endStop._id,
                address: endStop.address,
                city: endStop.city,
                state: endStop.state,
                windowEndDate: endStop.windowEndDate,
                windowEndTime: endStop.windowEndTime,
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
