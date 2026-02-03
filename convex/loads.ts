import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';
import { paginationOptsValidator } from 'convex/server';
import { parseStopDateTime } from './_helpers/timeUtils';
import { updateLoadCount } from './stats_helpers';

// Count loads by status for tab badges
// ✅ Optimized: Reads from aggregate table (1 read instead of 10,000+)
export const countLoadsByStatus = query({
  args: {
    workosOrgId: v.string(),
  },
  returns: v.object({
    Open: v.number(),
    Assigned: v.number(),
    Delivered: v.number(),
    Canceled: v.number(),
  }),
  handler: async (ctx, args) => {
    // Read from organizationStats aggregate table (1 read)
    const stats = await ctx.db
      .query('organizationStats')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .first();

    if (!stats) {
      // Return zeros if stats don't exist yet (before migration)
      return {
        Open: 0,
        Assigned: 0,
        Delivered: 0,
        Canceled: 0,
      };
    }

    // Map 'Completed' to 'Delivered' for UI consistency
    return {
      Open: stats.loadCounts.Open,
      Assigned: stats.loadCounts.Assigned,
      Delivered: stats.loadCounts.Completed, // Map for UI
      Canceled: stats.loadCounts.Canceled,
    };
  },
});

// Helper function to calculate effective miles
// Priority: manual > contract > imported > google
function calculateEffectiveMiles(
  manualMiles?: number,
  contractMiles?: number,
  importedMiles?: number,
  googleMiles?: number,
): number | undefined {
  if (manualMiles != null) return manualMiles;
  if (contractMiles != null) return contractMiles;
  if (importedMiles != null) return importedMiles;
  if (googleMiles != null) return googleMiles;
  return undefined;
}

/**
 * Sync the denormalized firstStopDate field on loadInformation.
 * 
 * This is the SINGLE SOURCE OF TRUTH for keeping firstStopDate in sync.
 * Call this function whenever:
 * - A new load is created with stops
 * - Stop times are updated (especially windowBeginDate)
 * - Stops are synced from external sources (FourKites)
 * 
 * @param ctx - Convex mutation context
 * @param loadId - ID of the load to sync
 * @returns The synced firstStopDate value (or undefined if no valid date)
 */
async function syncFirstStopDate(
  ctx: { db: { query: any; patch: any; get: any } },
  loadId: Id<'loadInformation'>,
): Promise<string | undefined> {
  // Get the first stop (sequenceNumber = 1)
  const firstStop = await ctx.db
    .query('loadStops')
    .withIndex('by_sequence', (q: any) => q.eq('loadId', loadId).eq('sequenceNumber', 1))
    .first();

  // Extract and sanitize the date
  let firstStopDate: string | undefined = undefined;
  
  if (firstStop?.windowBeginDate) {
    const rawDate = firstStop.windowBeginDate;
    
    // Handle TBD or empty values
    if (rawDate && rawDate !== 'TBD') {
      // Extract YYYY-MM-DD from potential ISO string
      const dateOnly = rawDate.split('T')[0];
      
      // Validate format (must be YYYY-MM-DD)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateOnly)) {
        firstStopDate = dateOnly;
      }
    }
  }

  // Update the load with the synced date
  await ctx.db.patch(loadId, { firstStopDate });
  
  return firstStopDate;
}

/**
 * Internal mutation to sync firstStopDate - callable from other files
 * Use this when you need to sync from fourKitesSyncHelpers or other internal mutations
 */
export const syncFirstStopDateMutation = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
  },
  handler: async (ctx, args) => {
    return syncFirstStopDate(ctx, args.loadId);
  },
});

// ✅ 1. GET LOADS (Read) - Optimized with denormalized firstStopDate index
export const getLoads = query({
  args: {
    workosOrgId: v.string(),
    status: v.optional(v.string()),
    trackingStatus: v.optional(v.string()),
    customerId: v.optional(v.id('customers')),
    hcr: v.optional(v.string()),
    tripNumber: v.optional(v.string()),
    startDate: v.optional(v.string()), // Date string in YYYY-MM-DD format
    endDate: v.optional(v.string()), // Date string in YYYY-MM-DD format
    requiresManualReview: v.optional(v.boolean()), // Filter for spot review
    loadType: v.optional(v.string()), // Filter by load type (CONTRACT, SPOT, UNMAPPED)
    search: v.optional(v.string()), // Search query
    mileRange: v.optional(v.string()), // Mile range filter: '0-100', '100-250', '250-500', '500+'
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const hasDateFilter = args.startDate || args.endDate;
    
    // Choose query strategy based on whether date filtering is active
    // Date filtering uses the optimized by_org_first_stop_date index
    let loadsQuery;
    
    // Always use by_org_first_stop_date index to sort by pickup date (newest first)
    // This ensures consistent ordering whether or not a date filter is applied
    if (args.startDate && args.endDate) {
      // Both bounds: inclusive range [startDate, endDate]
      loadsQuery = ctx.db
      .query('loadInformation')
        .withIndex('by_org_first_stop_date', (q) =>
          q.eq('workosOrgId', args.workosOrgId)
            .gte('firstStopDate', args.startDate!)
            .lte('firstStopDate', args.endDate!)
        );
    } else if (args.startDate) {
      // Only start date: from startDate onwards
      loadsQuery = ctx.db
        .query('loadInformation')
        .withIndex('by_org_first_stop_date', (q) =>
          q.eq('workosOrgId', args.workosOrgId)
            .gte('firstStopDate', args.startDate!)
        );
    } else if (args.endDate) {
      // Only end date: up to endDate (inclusive)
      loadsQuery = ctx.db
        .query('loadInformation')
        .withIndex('by_org_first_stop_date', (q) =>
          q.eq('workosOrgId', args.workosOrgId)
            .lte('firstStopDate', args.endDate!)
        );
    } else {
      // No date filter - still use firstStopDate index for consistent sorting
      loadsQuery = ctx.db
        .query('loadInformation')
        .withIndex('by_org_first_stop_date', (q) =>
          q.eq('workosOrgId', args.workosOrgId)
        );
    }

    // Apply additional filters (these work with both index strategies)
    if (args.status) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('status'), args.status));
    }
    if (args.trackingStatus) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('trackingStatus'), args.trackingStatus));
    }
    if (args.customerId) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('customerId'), args.customerId));
    }
    if (args.hcr) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('parsedHcr'), args.hcr));
    }
    if (args.tripNumber) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('parsedTripNumber'), args.tripNumber));
    }
    if (args.requiresManualReview !== undefined) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('requiresManualReview'), args.requiresManualReview));
    }
    if (args.loadType) {
      loadsQuery = loadsQuery.filter((q) => q.eq(q.field('loadType'), args.loadType));
    }

    // Paginate with appropriate ordering
    // Date-filtered queries are sorted by firstStopDate (desc), others by _creationTime (desc)
    const paginatedResult = await loadsQuery.order('desc').paginate(args.paginationOpts);

    let filteredLoads = paginatedResult.page;

    // Client-side search filtering (after pagination)
    if (args.search) {
      const searchLower = args.search.toLowerCase();
      filteredLoads = filteredLoads.filter((load) => {
        return (
          load.orderNumber?.toLowerCase().includes(searchLower) ||
          load.customerName?.toLowerCase().includes(searchLower) ||
          load.internalId?.toLowerCase().includes(searchLower) ||
          load.parsedHcr?.toLowerCase().includes(searchLower) ||
          load.parsedTripNumber?.toLowerCase().includes(searchLower)
        );
      });
    }

    const loadsWithStops = await Promise.all(
      filteredLoads.map(async (load) => {
        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();

        stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

        const firstPickup = stops.find((s) => s.stopType === 'PICKUP');
        const lastDelivery = stops.filter((s) => s.stopType === 'DELIVERY').pop();
        const firstStop = stops[0]; // Get the first stop (earliest in sequence)

        return {
          ...load,
          origin: firstPickup
            ? { city: firstPickup.city, state: firstPickup.state, address: firstPickup.address }
            : null,
          destination: lastDelivery
            ? { city: lastDelivery.city, state: lastDelivery.state, address: lastDelivery.address }
            : null,
          stopsCount: stops.length,
          firstStopDate: firstStop?.windowBeginDate, // ISO 8601 date string
        };
      }),
    );

    // Apply mile range filter after enrichment
    let finalLoads = loadsWithStops;
    if (args.mileRange && args.mileRange !== 'all') {
      finalLoads = finalLoads.filter((load) => {
        const miles = load.effectiveMiles;
        if (!miles) return false;

        switch (args.mileRange) {
          case '0-100':
            return miles >= 0 && miles <= 100;
          case '100-250':
            return miles > 100 && miles <= 250;
          case '250-500':
            return miles > 250 && miles <= 500;
          case '500+':
            return miles > 500;
          default:
            return true;
        }
      });
    }

    // Note: Date range filtering is done early (before enrichment) when hasDateFilter is true.
    // This section is skipped for date filtering since it was already applied.

    return {
      ...paginatedResult,
      page: finalLoads,
    };
  },
});

// ✅ 2. GET SINGLE LOAD (Read)
export const getLoad = query({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) return null;

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    // Fetch dispatch legs for this load
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Get assigned driver (from load's primaryDriverId cache)
    const primaryDriver = load.primaryDriverId 
      ? await ctx.db.get(load.primaryDriverId) 
      : null;

    // Get assigned carrier partnership
    let primaryCarrierPartnership = load.primaryCarrierPartnershipId 
      ? await ctx.db.get(load.primaryCarrierPartnershipId) 
      : null;

    // If no direct partnership, check the marketplace assignment system
    let carrierAssignment = null;
    if (!primaryCarrierPartnership) {
      carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .filter((q) =>
          q.or(
            q.eq(q.field('status'), 'AWARDED'),
            q.eq(q.field('status'), 'IN_PROGRESS')
          )
        )
        .first();
    }

    // Get truck and trailer from first leg (primary equipment)
    const firstLeg = legs.length > 0 
      ? legs.sort((a, b) => a.sequence - b.sequence)[0] 
      : null;
    
    const truck = firstLeg?.truckId 
      ? await ctx.db.get(firstLeg.truckId) 
      : null;
    
    const trailer = firstLeg?.trailerId 
      ? await ctx.db.get(firstLeg.trailerId) 
      : null;

    return { 
      ...load, 
      stops,
      // Enriched assignment data
      assignedDriver: primaryDriver 
        ? { 
            _id: primaryDriver._id,
            name: `${primaryDriver.firstName} ${primaryDriver.lastName}`,
            phone: primaryDriver.phone,
          } 
        : null,
      assignedCarrier: primaryCarrierPartnership 
        ? { 
            _id: primaryCarrierPartnership._id,
            companyName: primaryCarrierPartnership.carrierName,
            phone: primaryCarrierPartnership.contactPhone,
            mcNumber: primaryCarrierPartnership.mcNumber,
          } 
        : carrierAssignment
        ? {
            _id: carrierAssignment._id,
            companyName: carrierAssignment.carrierName,
            phone: carrierAssignment.assignedDriverPhone,
            mcNumber: carrierAssignment.carrierMcNumber,
            carrierRate: carrierAssignment.carrierTotalAmount,
            // Carrier's assigned driver for this load
            driverName: carrierAssignment.assignedDriverName,
            driverPhone: carrierAssignment.assignedDriverPhone,
          }
        : null,
      assignedTruck: truck 
        ? { 
            _id: truck._id,
            unitId: truck.unitId, 
            bodyType: truck.bodyType,
          } 
        : null,
      assignedTrailer: trailer 
        ? { 
            _id: trailer._id,
            unitId: trailer.unitId, 
            trailerType: trailer.bodyType,
          } 
        : null,
    };
  },
});

// ✅ 2b. GET LOAD WITH TIME RANGE (For Dispatch Planner)
// Returns load details with computed time window from stops
// Enriched with assigned assets for post-assignment monitoring
export const getByIdWithRange = query({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) return null;

    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Fetch dispatch legs for this load
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Get assigned driver (from load's primaryDriverId cache)
    const primaryDriver = load.primaryDriverId 
      ? await ctx.db.get(load.primaryDriverId) 
      : null;

    // Get assigned carrier partnership
    let primaryCarrierPartnership = load.primaryCarrierPartnershipId 
      ? await ctx.db.get(load.primaryCarrierPartnershipId) 
      : null;

    // If no direct partnership, check the marketplace assignment system
    let carrierAssignment = null;
    if (!primaryCarrierPartnership) {
      carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .filter((q) => 
          q.or(
            q.eq(q.field('status'), 'AWARDED'),
            q.eq(q.field('status'), 'IN_PROGRESS')
          )
        )
        .first();
    }

    // Get truck and trailer from first leg (primary equipment)
    const firstLeg = legs.length > 0 
      ? legs.sort((a, b) => a.sequence - b.sequence)[0] 
      : null;
    
    const truck = firstLeg?.truckId 
      ? await ctx.db.get(firstLeg.truckId) 
      : null;
    
    const trailer = firstLeg?.trailerId 
      ? await ctx.db.get(firstLeg.trailerId) 
      : null;

    if (stops.length === 0) {
      return { 
        ...load, 
        startTime: null, 
        endTime: null, 
        stops: [],
        legs: [],
        assignedDriver: null,
        assignedCarrier: null,
        assignedTruck: null,
        assignedTrailer: null,
      };
    }

    // Sort to find the true start and end of the load
    const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const startTime = parseStopDateTime(
      sortedStops[0].windowBeginDate,
      sortedStops[0].windowBeginTime
    );
    // Use windowBeginTime (appointment time) not windowEndTime (end of delivery window)
    // This prevents false scheduling conflicts from wide delivery windows
    const endTime = parseStopDateTime(
      sortedStops[sortedStops.length - 1].windowBeginDate,
      sortedStops[sortedStops.length - 1].windowBeginTime
    );

    // Get origin/destination for display
    const firstPickup = sortedStops.find((s) => s.stopType === 'PICKUP');
    const lastDelivery = sortedStops.filter((s) => s.stopType === 'DELIVERY').pop();

    return {
      ...load,
      startTime,
      endTime,
      origin: firstPickup
        ? {
            city: firstPickup.city,
            state: firstPickup.state,
            address: firstPickup.address,
            lat: firstPickup.latitude,
            lng: firstPickup.longitude,
          }
        : null,
      destination: lastDelivery
        ? {
            city: lastDelivery.city,
            state: lastDelivery.state,
            address: lastDelivery.address,
            lat: lastDelivery.latitude,
            lng: lastDelivery.longitude,
          }
        : null,
      stops: sortedStops,
      // Enriched assignment data
      legs: legs.sort((a, b) => a.sequence - b.sequence),
      assignedDriver: primaryDriver 
        ? { 
            _id: primaryDriver._id,
            name: `${primaryDriver.firstName} ${primaryDriver.lastName}`,
            phone: primaryDriver.phone,
            city: primaryDriver.city,
            state: primaryDriver.state,
          } 
        : null,
      assignedCarrier: primaryCarrierPartnership 
        ? { 
            _id: primaryCarrierPartnership._id,
            companyName: primaryCarrierPartnership.carrierName,
            phone: primaryCarrierPartnership.contactPhone,
            mcNumber: primaryCarrierPartnership.mcNumber,
          } 
        : carrierAssignment
        ? {
            _id: carrierAssignment._id,
            companyName: carrierAssignment.carrierName,
            phone: carrierAssignment.assignedDriverPhone,
            // Extra fields from marketplace assignment
            mcNumber: carrierAssignment.carrierMcNumber,
            carrierRate: carrierAssignment.carrierTotalAmount,
            // Carrier's assigned driver for this load
            driverName: carrierAssignment.assignedDriverName,
            driverPhone: carrierAssignment.assignedDriverPhone,
          }
        : null,
      assignedTruck: truck 
        ? { 
            _id: truck._id,
            unitId: truck.unitId, 
            bodyType: truck.bodyType,
          } 
        : null,
      assignedTrailer: trailer 
        ? { 
            _id: trailer._id,
            unitId: trailer.unitId, 
            trailerType: trailer.bodyType,
          } 
        : null,
    };
  },
});

// ✅ 3. CREATE LOAD (Write) - Architecture Aligned
export const createLoad = mutation({
  args: {
    workosOrgId: v.string(),
    createdBy: v.string(),
    internalId: v.string(),
    orderNumber: v.string(),
    poNumber: v.optional(v.string()),
    customerId: v.id('customers'),
    fleet: v.string(),
    equipmentType: v.optional(v.string()),
    equipmentLength: v.optional(v.number()),
    commodityDescription: v.optional(v.string()),
    weight: v.optional(v.number()),
    units: v.union(v.literal('Pallets'), v.literal('Boxes'), v.literal('Pieces'), v.literal('Lbs'), v.literal('Kg')),
    temperature: v.optional(v.number()),
    maxTemperature: v.optional(v.number()),
    contactPersonName: v.optional(v.string()),
    contactPersonPhone: v.optional(v.string()),
    contactPersonEmail: v.optional(v.string()),
    generalInstructions: v.optional(v.string()),
    contractMiles: v.optional(v.number()),
    importedMiles: v.optional(v.number()),
    googleMiles: v.optional(v.number()),
    manualMiles: v.optional(v.number()),
    stops: v.array(
      v.object({
        sequenceNumber: v.number(),
        stopType: v.union(v.literal('PICKUP'), v.literal('DELIVERY')),
        loadingType: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),
        address: v.string(),
        city: v.optional(v.string()),
        state: v.optional(v.string()),
        postalCode: v.optional(v.string()),
        latitude: v.optional(v.number()),
        longitude: v.optional(v.number()),
        timeZone: v.optional(v.string()), // IANA timezone (e.g., "America/Los_Angeles")
        windowBeginDate: v.string(),
        windowBeginTime: v.string(), // Full ISO string with timezone OR just "HH:mm"
        windowEndDate: v.string(),
        windowEndTime: v.string(), // Full ISO string with timezone OR just "HH:mm"
        commodityDescription: v.string(),
        commodityUnits: v.union(
          v.literal('Pallets'),
          v.literal('Boxes'),
          v.literal('Pieces'),
          v.literal('Lbs'),
          v.literal('Kg'),
        ),
        pieces: v.number(),
        weight: v.optional(v.number()),
        instructions: v.optional(v.string()),
        photoRequired: v.optional(v.boolean()),
        signatureRequired: v.optional(v.boolean()),
        referenceName: v.optional(v.string()),
        referenceValue: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.stops.length === 0) throw new Error('At least one stop is required');

    const customer = await ctx.db.get(args.customerId);
    if (!customer) throw new Error('Customer not found');

    const effectiveMiles = calculateEffectiveMiles(
      args.manualMiles,
      args.contractMiles,
      args.importedMiles,
      args.googleMiles
    );

    const loadId = await ctx.db.insert('loadInformation', {
      workosOrgId: args.workosOrgId,
      createdBy: args.createdBy,
      internalId: args.internalId,
      orderNumber: args.orderNumber,
      poNumber: args.poNumber,

      // ⚡ ARCHITECTURE DEFAULTS (Title Case per schema)
      status: 'Open', // Workflow status
      trackingStatus: 'Pending', // Physical tracking status

      // Manual loads don't have external source
      externalSource: undefined,
      externalLoadId: undefined,
      lastExternalUpdatedAt: undefined,

      // Manual loads usually don't have HCR match
      parsedHcr: undefined,
      parsedTripNumber: undefined,

      customerId: args.customerId,
      customerName: customer.name,
      fleet: args.fleet,
      equipmentType: args.equipmentType,
      equipmentLength: args.equipmentLength,
      commodityDescription: args.commodityDescription,
      weight: args.weight,
      units: args.units,
      temperature: args.temperature,
      maxTemperature: args.maxTemperature,
      contactPersonName: args.contactPersonName,
      contactPersonPhone: args.contactPersonPhone,
      contactPersonEmail: args.contactPersonEmail,
      generalInstructions: args.generalInstructions,
      contractMiles: args.contractMiles,
      importedMiles: args.importedMiles,
      googleMiles: args.googleMiles,
      manualMiles: args.manualMiles,
      effectiveMiles,
      lastMilesUpdate: effectiveMiles ? new Date().toISOString() : undefined,
      createdAt: now,
      updatedAt: now,
    });

    for (const stop of args.stops) {
      await ctx.db.insert('loadStops', {
        workosOrgId: args.workosOrgId,
        createdBy: args.createdBy,
        loadId: loadId as Id<'loadInformation'>,
        internalId: args.internalId,

        // ✅ ARCHITECTURE FIX: No fake external IDs for manual stops
        externalStopId: undefined,

        sequenceNumber: stop.sequenceNumber,
        stopType: stop.stopType,
        loadingType: stop.loadingType,
        address: stop.address,
        city: stop.city,
        state: stop.state,
        postalCode: stop.postalCode,
        latitude: stop.latitude,
        longitude: stop.longitude,
        timeZone: stop.timeZone, // IANA timezone (e.g., "America/Los_Angeles")
        windowBeginDate: stop.windowBeginDate,
        windowBeginTime: stop.windowBeginTime, // Full ISO with timezone OR "HH:mm"
        windowEndDate: stop.windowEndDate,
        windowEndTime: stop.windowEndTime, // Full ISO with timezone OR "HH:mm"
        commodityDescription: stop.commodityDescription,
        commodityUnits: stop.commodityUnits,
        pieces: stop.pieces,
        weight: stop.weight,
        instructions: stop.instructions,
        photoRequired: stop.photoRequired,
        signatureRequired: stop.signatureRequired,
        referenceName: stop.referenceName,
        referenceValue: stop.referenceValue,

        // Default status for new stops
        status: 'Pending',

        createdAt: now,
        updatedAt: now,
      });
    }

    // Sync firstStopDate after all stops are created
    await syncFirstStopDate(ctx, loadId as Id<'loadInformation'>);

    return loadId;
  },
});

// ✅ 4. UPDATE STATUS (Write)
// When moving to "Open", clears assignment data and cancels pending legs
// When moving to "Canceled" for assigned loads, requires cancellation reason
export const updateLoadStatus = mutation({
  args: {
    loadId: v.id('loadInformation'),
    status: v.union(v.literal('Open'), v.literal('Assigned'), v.literal('Canceled'), v.literal('Completed')),
    // Cancellation tracking (required when status = 'Canceled' and was 'Assigned')
    cancellationReason: v.optional(v.union(
      v.literal('DRIVER_BREAKDOWN'),
      v.literal('CUSTOMER_CANCELLED'),
      v.literal('EQUIPMENT_ISSUE'),
      v.literal('RATE_DISPUTE'),
      v.literal('WEATHER_CONDITIONS'),
      v.literal('CAPACITY_ISSUE'),
      v.literal('SCHEDULING_CONFLICT'),
      v.literal('OTHER'),
    )),
    cancellationNotes: v.optional(v.string()),
    canceledBy: v.optional(v.string()), // WorkOS user ID
  },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

    const now = Date.now();
    const updates: Record<string, unknown> = {
      status: args.status,
      updatedAt: now,
    };

    // Auto-update tracking status based on workflow status
    if (args.status === 'Completed') {
      updates.trackingStatus = 'Completed';
    } else if (args.status === 'Assigned') {
      if (load.trackingStatus === 'Pending') {
        updates.trackingStatus = 'In Transit';
      }
    } else if (args.status === 'Canceled') {
      // CANCEL: Store cancellation metadata
      updates.trackingStatus = 'Canceled';
      
      // Store cancellation reason if provided (required for Assigned -> Canceled)
      if (args.cancellationReason) {
        updates.cancellationReason = args.cancellationReason;
        updates.cancellationNotes = args.cancellationNotes;
        updates.canceledAt = now;
        updates.canceledBy = args.canceledBy;
      }

      // Cancel all PENDING and ACTIVE dispatch legs for this load
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      for (const leg of legs) {
        if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
          await ctx.db.patch(leg._id, {
            status: 'CANCELED',
            updatedAt: now,
          });

          // Delete associated SYSTEM payables (non-locked)
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
    } else if (args.status === 'Open') {
      // UNASSIGN: Clear assignment data when reverting to Open
      updates.primaryDriverId = undefined;
      updates.primaryCarrierPartnershipId = undefined;
      updates.trackingStatus = 'Pending';

      // Cancel all PENDING dispatch legs for this load
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .collect();

      for (const leg of legs) {
        if (leg.status === 'PENDING') {
          // Clear assignment from leg
          await ctx.db.patch(leg._id, {
            driverId: undefined,
            truckId: undefined,
            trailerId: undefined,
            carrierPartnershipId: undefined,
            status: 'CANCELED',
            updatedAt: now,
          });

          // Delete associated SYSTEM payables (non-locked)
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
    }

    await ctx.db.patch(args.loadId, updates);

    // ✅ Update organization stats (aggregate table pattern)
    await updateLoadCount(ctx, load.workosOrgId, load.status, args.status);
  },
});

// ✅ BULK UPDATE STATUS (Optimized for bulk operations)
export const bulkUpdateLoadStatus = mutation({
  args: {
    loadIds: v.array(v.id('loadInformation')),
    status: v.union(v.literal('Open'), v.literal('Assigned'), v.literal('Canceled'), v.literal('Completed')),
    cancellationReason: v.optional(v.union(
      v.literal('DRIVER_BREAKDOWN'),
      v.literal('CUSTOMER_CANCELLED'),
      v.literal('EQUIPMENT_ISSUE'),
      v.literal('RATE_DISPUTE'),
      v.literal('WEATHER_CONDITIONS'),
      v.literal('CAPACITY_ISSUE'),
      v.literal('SCHEDULING_CONFLICT'),
      v.literal('OTHER'),
    )),
    cancellationNotes: v.optional(v.string()),
    canceledBy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.loadIds.length === 0) return { success: 0, failed: 0 };

    const now = Date.now();
    let success = 0;
    let failed = 0;

    // Group loads by organization and track status changes
    const orgStatusChanges = new Map<string, Map<string, number>>();

    // First pass: validate and collect all loads
    const loadsToUpdate: Array<{
      id: Id<'loadInformation'>;
      load: any;
      orgId: string;
    }> = [];

    for (const loadId of args.loadIds) {
      try {
        const load = await ctx.db.get(loadId);
        if (!load) {
          failed++;
          continue;
        }
        loadsToUpdate.push({ id: loadId, load, orgId: load.workosOrgId });
      } catch (error) {
        failed++;
      }
    }

    // Second pass: perform all updates and track status changes
    for (const { id, load, orgId } of loadsToUpdate) {
      try {
        const oldStatus = load.status;

        // Build updates object (same logic as updateLoadStatus)
        const updates: Record<string, unknown> = {
          status: args.status,
          updatedAt: now,
        };

        if (args.status === 'Completed') {
          updates.trackingStatus = 'Completed';
        } else if (args.status === 'Assigned') {
          if (load.trackingStatus === 'Pending') {
            updates.trackingStatus = 'In Transit';
          }
        } else if (args.status === 'Canceled') {
          updates.trackingStatus = 'Canceled';
          if (args.cancellationReason) {
            updates.cancellationReason = args.cancellationReason;
            updates.cancellationNotes = args.cancellationNotes;
            updates.canceledAt = now;
            updates.canceledBy = args.canceledBy;
          }

          // Cancel dispatch legs
          const legs = await ctx.db
            .query('dispatchLegs')
            .withIndex('by_load', (q) => q.eq('loadId', id))
            .collect();

          for (const leg of legs) {
            if (leg.status === 'PENDING' || leg.status === 'ACTIVE') {
              await ctx.db.patch(leg._id, {
                status: 'CANCELED',
                updatedAt: now,
              });

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
        } else if (args.status === 'Open') {
          updates.primaryDriverId = undefined;
          updates.primaryCarrierPartnershipId = undefined;
          updates.trackingStatus = 'Pending';

          const legs = await ctx.db
            .query('dispatchLegs')
            .withIndex('by_load', (q) => q.eq('loadId', id))
            .collect();

          for (const leg of legs) {
            if (leg.status === 'PENDING') {
              await ctx.db.patch(leg._id, {
                driverId: undefined,
                truckId: undefined,
                trailerId: undefined,
                carrierPartnershipId: undefined,
                status: 'CANCELED',
                updatedAt: now,
              });

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
        }

        await ctx.db.patch(id, updates);

        // Track status changes by organization
        if (!orgStatusChanges.has(orgId)) {
          orgStatusChanges.set(orgId, new Map());
        }
        const orgChanges = orgStatusChanges.get(orgId)!;
        
        // Decrement old status
        orgChanges.set(oldStatus, (orgChanges.get(oldStatus) || 0) - 1);
        // Increment new status
        orgChanges.set(args.status, (orgChanges.get(args.status) || 0) + 1);

        success++;
      } catch (error) {
        console.error(`Failed to update load ${id}:`, error);
        failed++;
      }
    }

    // Third pass: Apply all stat changes at once per organization
    for (const [orgId, statusChanges] of orgStatusChanges.entries()) {
      const stats = await ctx.db
        .query('organizationStats')
        .withIndex('by_org', (q) => q.eq('workosOrgId', orgId))
        .first();

      if (stats) {
        const newLoadCounts = { ...stats.loadCounts };

        for (const [status, delta] of statusChanges.entries()) {
          if (status in newLoadCounts) {
            newLoadCounts[status as keyof typeof newLoadCounts] = 
              Math.max(0, (newLoadCounts[status as keyof typeof newLoadCounts] || 0) + delta);
          }
        }

        await ctx.db.patch(stats._id, {
          loadCounts: newLoadCounts,
          updatedAt: now,
        });
      }
    }

    return { success, failed };
  },
});

// ✅ 5. UPDATE MILES (Write)
export const updateLoadMiles = mutation({
  args: {
    loadId: v.id('loadInformation'),
    contractMiles: v.optional(v.number()),
    importedMiles: v.optional(v.number()),
    googleMiles: v.optional(v.number()),
    manualMiles: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

    const updatedContractMiles = args.contractMiles ?? load.contractMiles;
    const updatedImportedMiles = args.importedMiles ?? load.importedMiles;
    const updatedGoogleMiles = args.googleMiles ?? load.googleMiles;
    const updatedManualMiles = args.manualMiles ?? load.manualMiles;

    const effectiveMiles = calculateEffectiveMiles(
      updatedManualMiles,
      updatedContractMiles,
      updatedImportedMiles,
      updatedGoogleMiles
    );

    await ctx.db.patch(args.loadId, {
      contractMiles: updatedContractMiles,
      importedMiles: updatedImportedMiles,
      googleMiles: updatedGoogleMiles,
      manualMiles: updatedManualMiles,
      effectiveMiles,
      lastMilesUpdate: new Date().toISOString(),
      updatedAt: Date.now(),
    });
  },
});

// ✅ 6. DELETE LOAD (Write)
export const deleteLoad = mutation({
  args: { loadId: v.id('loadInformation') },
  handler: async (ctx, args) => {
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    for (const stop of stops) {
      await ctx.db.delete(stop._id);
    }
    await ctx.db.delete(args.loadId);
  },
});

// ✅ 7. UPDATE STOP TIMES (Write) - Triggers pay recalculation
export const updateStopTimes = mutation({
  args: {
    stopId: v.id('loadStops'),
    windowBeginDate: v.optional(v.string()),
    windowBeginTime: v.optional(v.string()),
    windowEndDate: v.optional(v.string()),
    windowEndTime: v.optional(v.string()),
    checkedInAt: v.optional(v.string()),
    checkedOutAt: v.optional(v.string()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const stop = await ctx.db.get(args.stopId);
    if (!stop) throw new Error('Stop not found');

    const { stopId, userId, ...updates } = args;
    const now = Date.now();

    // Build update object
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (updates.windowBeginDate !== undefined) updateData.windowBeginDate = updates.windowBeginDate;
    if (updates.windowBeginTime !== undefined) updateData.windowBeginTime = updates.windowBeginTime;
    if (updates.windowEndDate !== undefined) updateData.windowEndDate = updates.windowEndDate;
    if (updates.windowEndTime !== undefined) updateData.windowEndTime = updates.windowEndTime;
    if (updates.checkedInAt !== undefined) updateData.checkedInAt = updates.checkedInAt;
    if (updates.checkedOutAt !== undefined) updateData.checkedOutAt = updates.checkedOutAt;

    await ctx.db.patch(stopId, updateData);

    // If updating the first stop's date, sync firstStopDate on the load
    if (stop.sequenceNumber === 1 && updates.windowBeginDate !== undefined) {
      await syncFirstStopDate(ctx, stop.loadId);
    }

    // Trigger pay recalculation for affected legs
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
      .collect();

    for (const leg of legs) {
      // Check if this stop is within the leg's range
      if (leg.driverId) {
        await ctx.runMutation(internal.driverPayCalculation.calculateDriverPay, {
          legId: leg._id,
          userId,
        });
      }
    }

    return stopId;
  },
});

// ✅ 8. VALIDATE BULK STATUS CHANGE (Query) - Dispatch Protection
// Full transition matrix:
// - Assigned → Open: Warn (dispatcher work lost), check imminent/active
// - Assigned → Delivered: Block (must complete legs first)
// - Assigned → Canceled: Require reason code for imminent/active
// - Open → Delivered: Block (impossible - must be assigned first)
// - Open → Canceled: Allow (dead-wood cleanup)
export const validateBulkStatusChange = query({
  args: {
    loadIds: v.array(v.id('loadInformation')),
    targetStatus: v.string(), // The status we're trying to set
    bufferHours: v.optional(v.number()), // Imminent threshold, defaults to 4
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const bufferMs = (args.bufferHours ?? 4) * 60 * 60 * 1000; // Default 4 hours

    const results: {
      safe: { id: string; orderNumber?: string; currentStatus?: string }[];
      imminent: { id: string; orderNumber?: string; pickupTime: string; hoursUntilPickup: number; currentStatus?: string }[];
      active: { id: string; orderNumber?: string }[];
      finalized: { id: string; orderNumber?: string; status: string }[];
      blocked: { id: string; orderNumber?: string; reason: string }[]; // New: hard blocks
      requiresReason: { id: string; orderNumber?: string; currentStatus?: string }[]; // New: needs cancellation reason
    } = {
      safe: [],
      imminent: [],
      active: [],
      finalized: [],
      blocked: [],
      requiresReason: [],
    };

    for (const loadId of args.loadIds) {
      const load = await ctx.db.get(loadId);
      if (!load) continue;

      // 1. Check if load is already finalized (Completed/Canceled)
      if (load.status === 'Completed' || load.status === 'Canceled') {
        results.finalized.push({
          id: loadId,
          orderNumber: load.orderNumber,
          status: load.status === 'Completed' ? 'Delivered' : load.status,
        });
        continue;
      }

      // 2. BLOCK: Open → Delivered (impossible transition)
      if (load.status === 'Open' && args.targetStatus === 'Completed') {
        results.blocked.push({
          id: loadId,
          orderNumber: load.orderNumber,
          reason: 'Cannot mark as Delivered - load must be assigned and transported first',
        });
        continue;
      }

      // 3. Get dispatch legs for further checks
      const legs = await ctx.db
        .query('dispatchLegs')
        .withIndex('by_load', (q) => q.eq('loadId', loadId))
        .collect();

      const hasActiveLeg = legs.some((leg) => leg.status === 'ACTIVE');
      const hasCompletedLeg = legs.some((leg) => leg.status === 'COMPLETED');
      const allLegsCompleted = legs.length > 0 && legs.every((leg) => leg.status === 'COMPLETED');

      // 4. BLOCK: Assigned → Delivered without completed legs
      if (load.status === 'Assigned' && args.targetStatus === 'Completed') {
        if (!allLegsCompleted) {
          results.blocked.push({
            id: loadId,
            orderNumber: load.orderNumber,
            reason: 'Cannot mark as Delivered - dispatch legs must be completed first',
          });
          continue;
        }
        // If all legs completed, it's safe
        results.safe.push({
          id: loadId,
          orderNumber: load.orderNumber,
          currentStatus: load.status,
        });
        continue;
      }

      // 5. Active leg check (blocks most transitions)
      if (hasActiveLeg) {
        results.active.push({
          id: loadId,
          orderNumber: load.orderNumber,
        });
        continue;
      }

      // 6. Assigned → Canceled: Check if requires reason (imminent loads)
      if (load.status === 'Assigned' && args.targetStatus === 'Canceled') {
        // Get first pickup stop for imminent check
        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', loadId))
          .collect();

        const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        const firstPickup = sortedStops.find((s) => s.stopType === 'PICKUP') || sortedStops[0];

        let isImminent = false;
        if (firstPickup?.windowBeginDate && firstPickup?.windowBeginTime) {
          try {
            const pickupTime = new Date(
              `${firstPickup.windowBeginDate}T${firstPickup.windowBeginTime}`
            ).getTime();
            const timeUntilPickup = pickupTime - now;
            isImminent = timeUntilPickup > 0 && timeUntilPickup < bufferMs;
          } catch {
            // If date parsing fails, not imminent
          }
        }

        // All Assigned → Canceled require reason code
        results.requiresReason.push({
          id: loadId,
          orderNumber: load.orderNumber,
          currentStatus: load.status,
        });
        continue;
      }

      // 7. Assigned → Open: Check imminent
      if (load.status === 'Assigned' && args.targetStatus === 'Open') {
        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', loadId))
          .collect();

        const sortedStops = [...stops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        const firstPickup = sortedStops.find((s) => s.stopType === 'PICKUP') || sortedStops[0];

        if (firstPickup?.windowBeginDate && firstPickup?.windowBeginTime) {
          try {
            const pickupTime = new Date(
              `${firstPickup.windowBeginDate}T${firstPickup.windowBeginTime}`
            ).getTime();
            const timeUntilPickup = pickupTime - now;
            const hoursUntilPickup = Math.round(timeUntilPickup / (60 * 60 * 1000) * 10) / 10;

            if (timeUntilPickup > 0 && timeUntilPickup < bufferMs) {
              results.imminent.push({
                id: loadId,
                orderNumber: load.orderNumber,
                pickupTime: firstPickup.windowBeginTime,
                hoursUntilPickup,
                currentStatus: load.status,
              });
              continue;
            }
          } catch {
            // If date parsing fails, treat as safe
          }
        }
      }

      // 8. Safe to proceed (Open → Canceled, Open → Assigned, etc.)
      results.safe.push({
        id: loadId,
        orderNumber: load.orderNumber,
        currentStatus: load.status,
      });
    }

    return {
      ...results,
      summary: {
        total: args.loadIds.length,
        safeCount: results.safe.length,
        imminentCount: results.imminent.length,
        activeCount: results.active.length,
        finalizedCount: results.finalized.length,
        blockedCount: results.blocked.length,
        requiresReasonCount: results.requiresReason.length,
        canProceedSafely: 
          results.imminent.length === 0 && 
          results.active.length === 0 && 
          results.blocked.length === 0 &&
          results.requiresReason.length === 0,
      },
    };
  },
});

// ✅ 9. UPDATE LOAD ATTRIBUTES (Write) - isHazmat, requiresTarp trigger recalculation
export const updateLoadAttributes = mutation({
  args: {
    loadId: v.id('loadInformation'),
    isHazmat: v.optional(v.boolean()),
    requiresTarp: v.optional(v.boolean()),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const load = await ctx.db.get(args.loadId);
    if (!load) throw new Error('Load not found');

    const { loadId, userId, ...updates } = args;
    const now = Date.now();

    // Build update object
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (updates.isHazmat !== undefined) updateData.isHazmat = updates.isHazmat;
    if (updates.requiresTarp !== undefined) updateData.requiresTarp = updates.requiresTarp;

    await ctx.db.patch(loadId, updateData);

    // Trigger pay recalculation for all legs (driver and carrier)
    await ctx.runMutation(internal.driverPayCalculation.recalculateForLoad, {
      loadId,
      userId,
    });
    await ctx.runMutation(internal.carrierPayCalculation.recalculateForLoad, {
      loadId,
      userId,
    });

    return loadId;
  },
});
