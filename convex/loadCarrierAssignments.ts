import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { updateLoadCount } from './stats_helpers';

/**
 * Load Carrier Assignments API
 * Manages load offers/assignments between brokers and carriers
 * Supports multi-carrier offers where broker can choose winner
 */

// ==========================================
// QUERIES
// ==========================================

/**
 * List assignments for a load
 * Returns all offers (for broker to see who accepted/declined)
 */
export const listByLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Enrich with carrier and driver info
    return Promise.all(
      assignments.map(async (assignment) => {
        let carrierOrg = null;
        let driver = null;

        if (assignment.carrierOrgId) {
          carrierOrg = await ctx.db
            .query('organizations')
            .withIndex('by_organization', (q) =>
              q.eq('workosOrgId', assignment.carrierOrgId!)
            )
            .first();
        }

        if (assignment.assignedDriverId) {
          driver = await ctx.db.get(assignment.assignedDriverId);
        }

        return {
          ...assignment,
          carrierOrg,
          driver,
        };
      })
    );
  },
});

/**
 * Get the awarded/active assignment for a load
 */
export const getActiveForLoad = query({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    return assignments.find(
      (a) =>
        a.status === 'AWARDED' ||
        a.status === 'IN_PROGRESS' ||
        a.status === 'COMPLETED'
    );
  },
});

/**
 * List assignments for a broker
 */
export const listForBroker = query({
  args: {
    brokerOrgId: v.string(),
    status: v.optional(
      v.union(
        v.literal('OFFERED'),
        v.literal('ACCEPTED'),
        v.literal('AWARDED'),
        v.literal('DECLINED'),
        v.literal('WITHDRAWN'),
        v.literal('IN_PROGRESS'),
        v.literal('COMPLETED'),
        v.literal('CANCELED')
      )
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let query;
    if (args.status) {
      query = ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_broker', (q) =>
          q.eq('brokerOrgId', args.brokerOrgId).eq('status', args.status!)
        );
    } else {
      query = ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_broker', (q) => q.eq('brokerOrgId', args.brokerOrgId));
    }

    const assignments = await query.collect();

    // Apply limit
    const limited = args.limit ? assignments.slice(0, args.limit) : assignments;

    // Enrich with load info
    return Promise.all(
      limited.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        return {
          ...assignment,
          load,
        };
      })
    );
  },
});

/**
 * List assignments for a carrier
 * (Used in carrier's mobile app)
 */
export const listForCarrier = query({
  args: {
    carrierOrgId: v.string(),
    status: v.optional(
      v.union(
        v.literal('OFFERED'),
        v.literal('ACCEPTED'),
        v.literal('AWARDED'),
        v.literal('DECLINED'),
        v.literal('WITHDRAWN'),
        v.literal('IN_PROGRESS'),
        v.literal('COMPLETED'),
        v.literal('CANCELED')
      )
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let query;
    if (args.status) {
      query = ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_carrier', (q) =>
          q.eq('carrierOrgId', args.carrierOrgId).eq('status', args.status!)
        );
    } else {
      query = ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_carrier', (q) => q.eq('carrierOrgId', args.carrierOrgId));
    }

    const assignments = await query.collect();

    // Apply limit
    const limited = args.limit ? assignments.slice(0, args.limit) : assignments;

    // Enrich with load details (but NOT broker's customer rate - data visibility!)
    return Promise.all(
      limited.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        const stops = load
          ? await ctx.db
              .query('loadStops')
              .withIndex('by_load', (q) => q.eq('loadId', load._id))
              .collect()
          : [];

        // Return load info without sensitive broker data
        const safeLoad = load
          ? {
              _id: load._id,
              internalId: load.internalId,
              orderNumber: load.orderNumber,
              customerName: load.customerName, // Carrier sees customer name
              status: load.status,
              trackingStatus: load.trackingStatus,
              equipmentType: load.equipmentType,
              commodityDescription: load.commodityDescription,
              weight: load.weight,
              effectiveMiles: load.effectiveMiles,
              generalInstructions: load.generalInstructions,
              isHazmat: load.isHazmat,
              requiresTarp: load.requiresTarp,
              // Deliberately omit: rate info, customer billing, profit data
            }
          : null;

        return {
          ...assignment,
          load: safeLoad,
          stops: stops.map((s) => ({
            _id: s._id,
            sequenceNumber: s.sequenceNumber,
            stopType: s.stopType,
            loadingType: s.loadingType,
            address: s.address,
            city: s.city,
            state: s.state,
            postalCode: s.postalCode,
            windowBeginDate: s.windowBeginDate,
            windowBeginTime: s.windowBeginTime,
            windowEndDate: s.windowEndDate,
            windowEndTime: s.windowEndTime,
            commodityDescription: s.commodityDescription,
            instructions: s.instructions,
          })),
        };
      })
    );
  },
});

/**
 * Get assignments for carrier by payment status
 * (Used for carrier's settlement/earnings view)
 */
export const listByCarrierPayment = query({
  args: {
    carrierOrgId: v.string(),
    paymentStatus: v.union(
      v.literal('PENDING'),
      v.literal('INVOICED'),
      v.literal('SCHEDULED'),
      v.literal('PAID'),
      v.literal('DISPUTED')
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier_payment', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('paymentStatus', args.paymentStatus)
      )
      .collect();

    const limited = args.limit ? assignments.slice(0, args.limit) : assignments;

    return Promise.all(
      limited.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        return {
          ...assignment,
          load: load
            ? {
                _id: load._id,
                internalId: load.internalId,
                customerName: load.customerName,
              }
            : null,
        };
      })
    );
  },
});

/**
 * Get a single assignment
 */
export const get = query({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
  },
  handler: async (ctx, args) => {
    return ctx.db.get(args.assignmentId);
  },
});

/**
 * Get assignment with full load and stops details
 * Used by mobile assign-driver page
 */
export const getWithDetails = query({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) return null;

    // Get the load details
    const load = await ctx.db.get(assignment.loadId);
    if (!load) return { ...assignment, load: null, stops: [] };

    // Get the stops for this load
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', assignment.loadId))
      .collect();

    // Sort stops by sequence number
    const sortedStops = stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    // Find first pickup and last delivery
    const pickupStop = sortedStops.find((s) => s.stopType === 'PICKUP');
    const deliveryStop = [...sortedStops].reverse().find((s) => s.stopType === 'DELIVERY');

    return {
      ...assignment,
      load: {
        _id: load._id,
        internalId: load.internalId,
        orderNumber: load.orderNumber,
        status: load.status,
        weight: load.weight,
        units: load.units,
        effectiveMiles: load.effectiveMiles,
        equipmentType: load.equipmentType,
        commodityDescription: load.commodityDescription,
        parsedHcr: load.parsedHcr,
        parsedTripNumber: load.parsedTripNumber,
      },
      pickup: pickupStop
        ? {
            city: pickupStop.city || 'Unknown',
            state: pickupStop.state || '',
            date: pickupStop.windowBeginDate,
            time: pickupStop.windowBeginTime,
            address: pickupStop.address,
          }
        : null,
      delivery: deliveryStop
        ? {
            city: deliveryStop.city || 'Unknown',
            state: deliveryStop.state || '',
            date: deliveryStop.windowBeginDate,
            time: deliveryStop.windowBeginTime,
            address: deliveryStop.address,
          }
        : null,
      stops: sortedStops,
    };
  },
});

// ==========================================
// MUTATIONS
// ==========================================

/**
 * Offer load to carrier
 * Broker creates an assignment with status OFFERED
 */
export const offerLoad = mutation({
  args: {
    loadId: v.id('loadInformation'),
    brokerOrgId: v.string(),
    carrierOrgId: v.optional(v.string()),
    partnershipId: v.optional(v.id('carrierPartnerships')),
    carrierName: v.optional(v.string()),
    carrierMcNumber: v.optional(v.string()),
    carrierRate: v.optional(v.number()),
    carrierRateType: v.optional(v.union(
      v.literal('FLAT'),
      v.literal('PER_MILE'),
      v.literal('PERCENTAGE')
    )),
    currency: v.optional(v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))),
    carrierFuelSurcharge: v.optional(v.number()),
    carrierAccessorials: v.optional(v.number()),
    usePayProfile: v.optional(v.boolean()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Verify load exists
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      throw new Error('Load not found');
    }

    // Calculate total amount (only if not using pay profile)
    let carrierTotalAmount: number | undefined;
    if (!args.usePayProfile && args.carrierRate !== undefined) {
      carrierTotalAmount =
        args.carrierRate +
        (args.carrierFuelSurcharge || 0) +
        (args.carrierAccessorials || 0);
    }

    // Get carrier info from partnership if provided
    let carrierName = args.carrierName;
    let carrierMcNumber = args.carrierMcNumber;
    let carrierOrgId = args.carrierOrgId;

    if (args.partnershipId) {
      const partnership = await ctx.db.get(args.partnershipId);
      if (partnership) {
        // Validate partnership is active
        if (partnership.status === 'TERMINATED') {
          throw new Error('Cannot offer load to terminated partnership');
        }
        if (partnership.status === 'SUSPENDED') {
          throw new Error('Cannot offer load to suspended partnership');
        }
        carrierName = partnership.carrierName;
        carrierMcNumber = partnership.mcNumber;
        carrierOrgId = partnership.carrierOrgId;

        // If using pay profile, verify carrier has one
        if (args.usePayProfile) {
          const profileAssignments = await ctx.db
            .query('carrierProfileAssignments')
            .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.partnershipId!))
            .collect();

          if (profileAssignments.length === 0) {
            throw new Error('Carrier does not have a pay profile configured');
          }
        }
      }
    }

    // Validate rate is provided when not using pay profile
    if (!args.usePayProfile && args.carrierRate === undefined) {
      throw new Error('Rate is required when not using pay profile');
    }

    const assignmentId = await ctx.db.insert('loadCarrierAssignments', {
      loadId: args.loadId,
      brokerOrgId: args.brokerOrgId,
      carrierOrgId,
      partnershipId: args.partnershipId,
      carrierName,
      carrierMcNumber,
      carrierRate: args.usePayProfile ? undefined : args.carrierRate,
      carrierRateType: args.usePayProfile ? undefined : args.carrierRateType,
      currency: args.usePayProfile ? undefined : args.currency,
      carrierFuelSurcharge: args.usePayProfile ? undefined : args.carrierFuelSurcharge,
      carrierAccessorials: args.usePayProfile ? undefined : args.carrierAccessorials,
      carrierTotalAmount: args.usePayProfile ? undefined : carrierTotalAmount,
      usePayProfile: args.usePayProfile,
      status: 'OFFERED',
      offeredAt: now,
      createdBy: args.createdBy,
    });

    return {
      assignmentId,
      carrierTotalAmount,
    };
  },
});

/**
 * Direct assign load to carrier (for contract carriers)
 * Skips offer/accept workflow - creates assignment directly as AWARDED
 * Use when broker has pre-negotiated contract rates with carrier
 */
export const directAssign = mutation({
  args: {
    loadId: v.id('loadInformation'),
    brokerOrgId: v.string(),
    partnershipId: v.id('carrierPartnerships'),
    // Rate can be provided or will use partnership defaults
    carrierRate: v.optional(v.number()),
    carrierRateType: v.optional(
      v.union(v.literal('FLAT'), v.literal('PER_MILE'), v.literal('PERCENTAGE'))
    ),
    currency: v.optional(v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))),
    carrierFuelSurcharge: v.optional(v.number()),
    carrierAccessorials: v.optional(v.number()),
    usePayProfile: v.optional(v.boolean()), // If true, skip rate requirement and use pay profile
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    // Verify load exists and is assignable
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      throw new Error('Load not found');
    }
    if (load.status === 'Canceled') {
      throw new Error('Cannot assign carrier to a canceled load');
    }

    // Get partnership details
    const partnership = await ctx.db.get(args.partnershipId);
    if (!partnership) {
      throw new Error('Partnership not found');
    }
    if (partnership.brokerOrgId !== args.brokerOrgId) {
      throw new Error('Partnership does not belong to this broker');
    }
    if (partnership.status !== 'ACTIVE') {
      throw new Error('Partnership is not active');
    }

    // If using pay profile, verify one exists
    let carrierRate: number | undefined;
    let carrierRateType: 'FLAT' | 'PER_MILE' | 'PERCENTAGE' = 'FLAT';
    let currency: 'USD' | 'CAD' | 'MXN' = 'USD';
    let carrierTotalAmount = 0;

    if (args.usePayProfile) {
      // Check if carrier has a pay profile
      const profileAssignments = await ctx.db
        .query('carrierProfileAssignments')
        .withIndex('by_carrier_partnership', (q) => q.eq('carrierPartnershipId', args.partnershipId))
        .collect();

      if (profileAssignments.length === 0) {
        throw new Error('Carrier does not have a pay profile configured');
      }

      // Rate fields are optional when using pay profile
      // Store null/0 to indicate pay profile is being used
      carrierRate = 0;
      carrierRateType = 'FLAT';
      currency = 'USD';
      carrierTotalAmount = 0; // Will be calculated by pay profile
    } else {
      // Traditional negotiated rate flow
      carrierRate = args.carrierRate ?? partnership.defaultRate;
      carrierRateType = args.carrierRateType ?? partnership.defaultRateType ?? 'FLAT';
      currency = args.currency ?? partnership.defaultCurrency ?? 'USD';

      if (carrierRate === undefined) {
        throw new Error('Rate is required - provide rate or configure default rate on partnership');
      }

      // Calculate total amount based on rate type
      let baseAmount = carrierRate;
      if (carrierRateType === 'PER_MILE') {
        // Multiply rate by effective miles
        const miles = load.effectiveMiles ?? load.importedMiles ?? load.contractMiles ?? 0;
        baseAmount = carrierRate * miles;
      } else if (carrierRateType === 'PERCENTAGE') {
        // For percentage, we'd need the customer rate - for now treat as flat
        baseAmount = carrierRate;
      }
      // FLAT rate uses carrierRate directly

      carrierTotalAmount =
        baseAmount +
        (args.carrierFuelSurcharge || 0) +
        (args.carrierAccessorials || 0);
    }

    // Check if there's already an active assignment for this load
    const existingAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const hasActiveAssignment = existingAssignments.some(
      (a) =>
        a.status === 'AWARDED' ||
        a.status === 'IN_PROGRESS'
    );

    if (hasActiveAssignment) {
      throw new Error('Load already has an active carrier assignment');
    }

    // Withdraw any pending offers for this load
    for (const assignment of existingAssignments) {
      if (assignment.status === 'OFFERED' || assignment.status === 'ACCEPTED') {
        await ctx.db.patch(assignment._id, {
          status: 'WITHDRAWN',
        });
      }
    }

    // Create assignment directly as AWARDED
    const assignmentId = await ctx.db.insert('loadCarrierAssignments', {
      loadId: args.loadId,
      brokerOrgId: args.brokerOrgId,
      carrierOrgId: partnership.carrierOrgId,
      partnershipId: args.partnershipId,
      carrierName: partnership.carrierName,
      carrierMcNumber: partnership.mcNumber,
      carrierRate: args.usePayProfile ? undefined : carrierRate,
      carrierRateType: args.usePayProfile ? undefined : carrierRateType,
      currency: args.usePayProfile ? undefined : currency,
      carrierFuelSurcharge: args.usePayProfile ? undefined : args.carrierFuelSurcharge,
      carrierAccessorials: args.usePayProfile ? undefined : args.carrierAccessorials,
      carrierTotalAmount: args.usePayProfile ? undefined : carrierTotalAmount,
      usePayProfile: args.usePayProfile,
      status: 'AWARDED',
      offeredAt: now,
      acceptedAt: now, // Direct assign = immediately accepted
      awardedAt: now,
      createdBy: args.createdBy,
    });

    // Update load status to Assigned and link carrier partnership
    const oldStatus = load.status;
    await ctx.db.patch(args.loadId, {
      status: 'Assigned',
      primaryCarrierPartnershipId: args.partnershipId,
      updatedAt: now,
    });

    // Update organization stats (badge counts)
    await updateLoadCount(ctx, load.workosOrgId, oldStatus, 'Assigned');

    // Create or update dispatch legs with carrier assignment
    const existingLegs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    if (existingLegs.length === 0) {
      // Create default leg from first to last stop
      const stops = await ctx.db
        .query('loadStops')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      if (stops.length >= 2) {
        const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        const firstStop = sortedStops[0];
        const lastStop = sortedStops[sortedStops.length - 1];

        const legId = await ctx.db.insert('dispatchLegs', {
          loadId: args.loadId,
          carrierPartnershipId: args.partnershipId,
          sequence: 1,
          startStopId: firstStop._id,
          endStopId: lastStop._id,
          legLoadedMiles: load.effectiveMiles ?? 0,
          legEmptyMiles: 0,
          status: 'PENDING',
          workosOrgId: args.brokerOrgId,
          createdAt: now,
          updatedAt: now,
        });

        // Trigger carrier pay calculation for the new leg
        await ctx.runMutation(internal.carrierPayCalculation.calculateCarrierPay, {
          legId,
          userId: args.createdBy,
        });
      }
    } else {
      // Update existing legs with carrier assignment
      for (const leg of existingLegs) {
        if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
          await ctx.db.patch(leg._id, {
            carrierPartnershipId: args.partnershipId,
            driverId: undefined, // Clear driver (exclusive assignment)
            truckId: undefined,
            updatedAt: now,
          });

          // Trigger carrier pay calculation
          await ctx.runMutation(internal.carrierPayCalculation.calculateCarrierPay, {
            legId: leg._id,
            userId: args.createdBy,
          });
        }
      }
    }

    return {
      assignmentId,
      carrierTotalAmount,
      carrierName: partnership.carrierName,
    };
  },
});

/**
 * Carrier accepts a load offer
 */
export const acceptOffer = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    carrierOrgId: v.string(), // For verification
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    if (assignment.carrierOrgId !== args.carrierOrgId) {
      throw new Error('Assignment does not belong to this carrier');
    }

    if (assignment.status !== 'OFFERED') {
      throw new Error(`Cannot accept assignment with status: ${assignment.status}`);
    }

    await ctx.db.patch(args.assignmentId, {
      status: 'ACCEPTED',
      acceptedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Carrier declines a load offer
 */
export const declineOffer = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    if (assignment.carrierOrgId !== args.carrierOrgId) {
      throw new Error('Assignment does not belong to this carrier');
    }

    if (assignment.status !== 'OFFERED') {
      throw new Error(`Cannot decline assignment with status: ${assignment.status}`);
    }

    await ctx.db.patch(args.assignmentId, {
      status: 'DECLINED',
    });

    return { success: true };
  },
});

/**
 * Broker awards load to a specific carrier
 * Withdraws all other accepted offers for the same load
 */
export const awardToCarrier = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    brokerOrgId: v.string(), // For verification
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    if (assignment.brokerOrgId !== args.brokerOrgId) {
      throw new Error('Assignment does not belong to this broker');
    }

    if (assignment.status !== 'ACCEPTED') {
      throw new Error('Can only award to carriers who have accepted');
    }

    // Get all other assignments for this load
    const allAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', assignment.loadId))
      .collect();

    // Award this one, withdraw others
    for (const a of allAssignments) {
      if (a._id === args.assignmentId) {
        await ctx.db.patch(a._id, {
          status: 'AWARDED',
          awardedAt: now,
        });
      } else if (a.status === 'OFFERED' || a.status === 'ACCEPTED') {
        await ctx.db.patch(a._id, {
          status: 'WITHDRAWN',
        });
      }
    }

    // Update load status to Assigned
    await ctx.db.patch(assignment.loadId, {
      status: 'Assigned',
      updatedAt: now,
    });

    return { success: true };
  },
});

/**
 * Broker withdraws an offer
 */
export const withdrawOffer = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    brokerOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    if (assignment.brokerOrgId !== args.brokerOrgId) {
      throw new Error('Assignment does not belong to this broker');
    }

    if (assignment.status !== 'OFFERED' && assignment.status !== 'ACCEPTED') {
      throw new Error(`Cannot withdraw assignment with status: ${assignment.status}`);
    }

    await ctx.db.patch(args.assignmentId, {
      status: 'WITHDRAWN',
    });

    return { success: true };
  },
});

/**
 * Carrier assigns driver to load
 */
export const assignDriver = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    carrierOrgId: v.string(),
    driverId: v.optional(v.id('drivers')),
    driverName: v.string(),
    driverPhone: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    console.log('[assignDriver] Starting assignment:', {
      assignmentId: args.assignmentId,
      carrierOrgId: args.carrierOrgId,
      driverId: args.driverId,
      driverName: args.driverName,
    });

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    console.log('[assignDriver] Assignment found:', {
      assignmentCarrierOrgId: assignment.carrierOrgId,
      status: assignment.status,
      loadId: assignment.loadId,
    });

    if (assignment.carrierOrgId !== args.carrierOrgId) {
      console.log('[assignDriver] Carrier mismatch:', {
        expected: assignment.carrierOrgId,
        received: args.carrierOrgId,
      });
      throw new Error('Assignment does not belong to this carrier');
    }

    if (
      assignment.status !== 'AWARDED' &&
      assignment.status !== 'IN_PROGRESS'
    ) {
      throw new Error('Can only assign driver to awarded or in-progress loads');
    }

    // If driverId provided, verify driver belongs to carrier's org
    if (args.driverId) {
      const driver = await ctx.db.get(args.driverId);
      console.log('[assignDriver] Driver lookup:', {
        driverId: args.driverId,
        driverFound: !!driver,
        driverOrgId: driver?.organizationId,
        expectedOrgId: args.carrierOrgId,
      });
      
      // Note: driver.organizationId is the Convex doc ID, but args.carrierOrgId 
      // might be the external ID. We should validate ownership differently.
      if (!driver) {
        throw new Error('Driver not found');
      }
      // For now, just verify the driver exists and is active
      if (driver.isDeleted) {
        throw new Error('Driver has been deleted');
      }
    }

    await ctx.db.patch(args.assignmentId, {
      assignedDriverId: args.driverId,
      assignedDriverName: args.driverName,
      assignedDriverPhone: args.driverPhone,
    });

    console.log('[assignDriver] Assignment updated successfully');

    return { success: true };
  },
});

/**
 * Start load execution
 */
export const startLoad = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    if (assignment.carrierOrgId !== args.carrierOrgId) {
      throw new Error('Assignment does not belong to this carrier');
    }

    if (assignment.status !== 'AWARDED') {
      throw new Error('Can only start awarded loads');
    }

    await ctx.db.patch(args.assignmentId, {
      status: 'IN_PROGRESS',
    });

    // Update load tracking status
    await ctx.db.patch(assignment.loadId, {
      trackingStatus: 'In Transit',
      updatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Complete load
 */
export const completeLoad = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    if (assignment.carrierOrgId !== args.carrierOrgId) {
      throw new Error('Assignment does not belong to this carrier');
    }

    if (assignment.status !== 'IN_PROGRESS') {
      throw new Error('Can only complete in-progress loads');
    }

    await ctx.db.patch(args.assignmentId, {
      status: 'COMPLETED',
      completedAt: now,
      paymentStatus: 'PENDING', // Now awaiting payment
    });

    // Update load status
    await ctx.db.patch(assignment.loadId, {
      status: 'Completed',
      trackingStatus: 'Completed',
      updatedAt: now,
    });

    return { success: true };
  },
});

/**
 * Cancel assignment (either party)
 */
export const cancelAssignment = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    canceledBy: v.string(),
    canceledByParty: v.union(v.literal('BROKER'), v.literal('CARRIER')),
    cancellationReason: v.union(
      v.literal('DRIVER_UNAVAILABLE'),
      v.literal('EQUIPMENT_ISSUE'),
      v.literal('RATE_DISPUTE'),
      v.literal('LOAD_CANCELED_BY_CUSTOMER'),
      v.literal('WEATHER'),
      v.literal('OTHER')
    ),
    cancellationNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    // Can only cancel awarded or in-progress loads
    if (assignment.status !== 'AWARDED' && assignment.status !== 'IN_PROGRESS') {
      throw new Error(`Cannot cancel assignment with status: ${assignment.status}`);
    }

    await ctx.db.patch(args.assignmentId, {
      status: 'CANCELED',
      canceledAt: now,
      canceledBy: args.canceledBy,
      canceledByParty: args.canceledByParty,
      cancellationReason: args.cancellationReason,
      cancellationNotes: args.cancellationNotes,
    });

    // Update load status back to Open
    await ctx.db.patch(assignment.loadId, {
      status: 'Open',
      trackingStatus: 'Pending',
      updatedAt: now,
    });

    return { success: true };
  },
});

/**
 * Update payment status (broker action)
 */
export const updatePaymentStatus = mutation({
  args: {
    assignmentId: v.id('loadCarrierAssignments'),
    brokerOrgId: v.string(),
    paymentStatus: v.union(
      v.literal('PENDING'),
      v.literal('INVOICED'),
      v.literal('SCHEDULED'),
      v.literal('PAID'),
      v.literal('DISPUTED')
    ),
    paymentMethod: v.optional(
      v.union(
        v.literal('ACH'),
        v.literal('CHECK'),
        v.literal('WIRE'),
        v.literal('QUICKPAY')
      )
    ),
    paymentReference: v.optional(v.string()),
    paymentAmount: v.optional(v.number()),
    paymentNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db.get(args.assignmentId);
    if (!assignment) {
      throw new Error('Assignment not found');
    }

    if (assignment.brokerOrgId !== args.brokerOrgId) {
      throw new Error('Assignment does not belong to this broker');
    }

    const updates: Record<string, unknown> = {
      paymentStatus: args.paymentStatus,
    };

    if (args.paymentMethod !== undefined) {
      updates.paymentMethod = args.paymentMethod;
    }
    if (args.paymentReference !== undefined) {
      updates.paymentReference = args.paymentReference;
    }
    if (args.paymentAmount !== undefined) {
      updates.paymentAmount = args.paymentAmount;
    }
    if (args.paymentNotes !== undefined) {
      updates.paymentNotes = args.paymentNotes;
    }
    if (args.paymentStatus === 'PAID') {
      updates.paymentDate = Date.now();
    }

    await ctx.db.patch(args.assignmentId, updates);

    return { success: true };
  },
});

/**
 * Get carrier earnings summary
 */
export const getCarrierEarningsSummary = query({
  args: {
    carrierOrgId: v.string(),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Get completed assignments
    const completedAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'COMPLETED')
      )
      .collect();

    // Filter by date if provided
    const filtered = completedAssignments.filter((a) => {
      if (!a.completedAt) return false;
      if (args.startDate && a.completedAt < args.startDate) return false;
      if (args.endDate && a.completedAt > args.endDate) return false;
      return true;
    });

    // Calculate totals
    const totalEarnings = filtered.reduce((sum, a) => sum + (a.carrierTotalAmount || 0), 0);
    const paidAmount = filtered
      .filter((a) => a.paymentStatus === 'PAID')
      .reduce((sum, a) => sum + (a.paymentAmount || a.carrierTotalAmount || 0), 0);
    const pendingAmount = filtered
      .filter((a) => a.paymentStatus !== 'PAID')
      .reduce((sum, a) => sum + (a.carrierTotalAmount || 0), 0);

    return {
      totalLoads: filtered.length,
      totalEarnings,
      paidAmount,
      pendingAmount,
      completedLoads: filtered.length,
    };
  },
});
