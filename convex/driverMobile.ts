import { v } from 'convex/values';
import { query, mutation, QueryCtx, MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';
import { getLoadFacets } from './lib/loadFacets';

// ============================================
// DRIVER MOBILE API
// Phone-authenticated driver queries and mutations
// ============================================

// ============================================
// CONSTANTS
// ============================================

// Maximum distance (in meters) driver can be from stop to check in
const MAX_CHECKIN_DISTANCE_METERS = 500; // ~0.3 miles

// Clerk issuer URL prefix for validating driver tokens
const CLERK_ISSUER_PREFIX = 'https://clerk.';

/**
 * Normalize a phone number to its 10-digit US form for comparison.
 * Handles +17607553340, 17607553340, 7607553340, +1760-755-3340, (760) 755-3340, etc.
 */
function normalizePhoneForMatch(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * Helper to extract phone number from Clerk JWT
 * Clerk stores phone in the token claims
 */
function extractPhoneFromIdentity(identity: {
  subject: string;
  tokenIdentifier: string;
  issuer?: string;
  phoneNumber?: string;
  phone_number?: string;
}): string | null {
  return identity.phoneNumber || identity.phone_number || null;
}

/**
 * Verify that the JWT is from Clerk (driver auth), not WorkOS (admin auth)
 * This prevents drivers from accessing admin functions
 */
function isDriverToken(identity: { issuer?: string }): boolean {
  if (!identity.issuer) return false;
  // Clerk issuers start with the Clerk domain
  return identity.issuer.includes('clerk');
}

/**
 * Calculate distance between two GPS coordinates using Haversine formula
 * Returns distance in meters
 */
function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Resolve the authenticated driver from the Clerk JWT phone claim.
 * If claimedDriverId is provided, verify it matches the phone-resolved driver.
 * Throws if unauthenticated, no phone on identity, or driver not found.
 */
async function resolveAuthenticatedDriver(
  ctx: QueryCtx | MutationCtx,
  claimedDriverId?: Id<'drivers'>,
): Promise<Doc<'drivers'>> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Unauthenticated');

  const phone = extractPhoneFromIdentity(identity as any);
  if (!phone) throw new Error('No phone number in identity');

  const normalizedPhone = normalizePhoneForMatch(phone);
  const phoneVariants = [normalizedPhone, `+1${normalizedPhone}`, `1${normalizedPhone}`];

  let driver: Doc<'drivers'> | null = null;
  for (const variant of phoneVariants) {
    const match = await ctx.db
      .query('drivers')
      .withIndex('by_phone', (q) => q.eq('phone', variant))
      .first();
    if (match && !match.isDeleted) {
      driver = match;
      break;
    }
  }

  if (!driver) throw new Error('Driver not found');

  // If a specific driverId was claimed, verify it matches
  if (claimedDriverId && claimedDriverId !== driver._id) {
    throw new Error('Driver not found');
  }

  return driver;
}

/**
 * Get the authenticated driver's profile by matching phone number
 * This is the main entry point for driver authentication
 */
export const getMyProfile = query({
  args: {
    driverId: v.optional(v.id('drivers')),
  },
  returns: v.union(
    v.object({
      _id: v.id('drivers'),
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      phone: v.string(),
      employmentStatus: v.string(),
      organizationId: v.string(),
      currentTruckId: v.optional(v.id('trucks')),
      // Truck info if assigned
      truck: v.optional(
        v.object({
          _id: v.id('trucks'),
          unitId: v.string(),
          make: v.optional(v.string()),
          model: v.optional(v.string()),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Resolve driver from JWT phone claim; if driverId provided, verify it matches
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return null;
    }

    // Get truck info if assigned
    let truck: { _id: Id<'trucks'>; unitId: string; make?: string; model?: string } | undefined = undefined;
    if (driver.currentTruckId) {
      const truckDoc = await ctx.db.get(driver.currentTruckId);
      if (truckDoc && !truckDoc.isDeleted) {
        truck = {
          _id: truckDoc._id,
          unitId: truckDoc.unitId,
          make: truckDoc.make,
          model: truckDoc.model,
        };
      }
    }

    return {
      _id: driver._id,
      firstName: driver.firstName,
      lastName: driver.lastName,
      email: driver.email,
      phone: driver.phone,
      employmentStatus: driver.employmentStatus,
      organizationId: driver.organizationId,
      currentTruckId: driver.currentTruckId,
      truck,
    };
  },
});

/**
 * Get all loads assigned to the authenticated driver
 * Only returns today's and tomorrow's loads (rolling window)
 */
export const getMyAssignedLoads = query({
  args: {
    driverId: v.id('drivers'),
    nowMs: v.optional(v.number()),
  },
  returns: v.array(
    v.object({
      _id: v.id('loadInformation'),
      internalId: v.string(),
      orderNumber: v.string(),
      parsedHcr: v.optional(v.string()),
      parsedTripNumber: v.optional(v.string()),
      status: v.string(),
      trackingStatus: v.string(),
      customerName: v.optional(v.string()),
      firstStopDate: v.optional(v.string()),
      effectiveMiles: v.optional(v.number()),
      stopCount: v.optional(v.number()),
      equipmentType: v.optional(v.string()),
      commodityDescription: v.optional(v.string()),
      // First pickup info
      firstPickup: v.optional(
        v.object({
          city: v.optional(v.string()),
          state: v.optional(v.string()),
          windowBeginDate: v.optional(v.string()),
          windowBeginTime: v.optional(v.string()),
        }),
      ),
      // Last delivery info
      lastDelivery: v.optional(
        v.object({
          city: v.optional(v.string()),
          state: v.optional(v.string()),
          windowBeginDate: v.optional(v.string()),
          windowEndTime: v.optional(v.string()),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    // Verify the driver is authenticated and that args.driverId matches their JWT phone claim
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return [];
    }

    // Date boundaries for filtering (nowMs provided by client to keep query deterministic)
    // Falls back to Date.now() for old clients that don't pass nowMs yet
    const now = args.nowMs ?? Date.now();
    const dayAfterTomorrow = new Date(now + 48 * 60 * 60 * 1000).toISOString().split('T')[0];
    const twoDaysAgoMs = now - 2 * 24 * 60 * 60 * 1000;
    const twoDaysAgoDate = new Date(twoDaysAgoMs).toISOString().split('T')[0];

    const loadIdsSet = new Set<string>();
    const driverLoads: Awaited<ReturnType<typeof ctx.db.get<'loadInformation'>>>[] = [];

    // Method 1: Get loads where this driver is the primary driver (broker-assigned)
    const [openLoads, assignedLoads, completedLoads] = await Promise.all([
      ctx.db
        .query('loadInformation')
        .withIndex('by_primary_driver_status', (q) => q.eq('primaryDriverId', args.driverId).eq('status', 'Open'))
        .collect(),
      ctx.db
        .query('loadInformation')
        .withIndex('by_primary_driver_status', (q) => q.eq('primaryDriverId', args.driverId).eq('status', 'Assigned'))
        .collect(),
      ctx.db
        .query('loadInformation')
        .withIndex('by_primary_driver_status', (q) => q.eq('primaryDriverId', args.driverId).eq('status', 'Completed'))
        .collect(),
    ]);

    for (const load of [...openLoads, ...assignedLoads]) {
      if (load.firstStopDate && load.firstStopDate > dayAfterTomorrow) continue;
      if (load.firstStopDate && load.firstStopDate < twoDaysAgoDate) continue;
      loadIdsSet.add(load._id);
      driverLoads.push(load);
    }

    // Completed broker loads: only include if firstStopDate is within the last 2 days
    for (const load of completedLoads) {
      const stopDate = load.firstStopDate;
      if (!stopDate || stopDate < twoDaysAgoDate) continue;
      loadIdsSet.add(load._id);
      driverLoads.push(load);
    }

    // Method 2: Get loads assigned via carrier assignments (carrier-assigned drivers)
    const [awardedAssignments, inProgressAssignments, completedAssignments] = await Promise.all([
      ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_assigned_driver', (q) => q.eq('assignedDriverId', args.driverId).eq('status', 'AWARDED'))
        .collect(),
      ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_assigned_driver', (q) => q.eq('assignedDriverId', args.driverId).eq('status', 'IN_PROGRESS'))
        .collect(),
      ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_assigned_driver', (q) => q.eq('assignedDriverId', args.driverId).eq('status', 'COMPLETED'))
        .collect(),
    ]);

    // Active carrier assignments
    for (const assignment of [...awardedAssignments, ...inProgressAssignments]) {
      if (loadIdsSet.has(assignment.loadId)) continue;
      const load = await ctx.db.get(assignment.loadId);
      if (!load) continue;
      if (load.status === 'Canceled') continue;
      if (load.firstStopDate && load.firstStopDate > dayAfterTomorrow) continue;
      if (load.firstStopDate && load.firstStopDate < twoDaysAgoDate) continue;
      loadIdsSet.add(load._id);
      driverLoads.push(load);
    }

    // Completed carrier assignments: only include if completed within the last 2 days
    for (const assignment of completedAssignments) {
      if (loadIdsSet.has(assignment.loadId)) continue;
      // Use completedAt timestamp; fall back to _creationTime for older records
      const completedTime = assignment.completedAt ?? assignment._creationTime;
      if (completedTime < twoDaysAgoMs) continue;
      const load = await ctx.db.get(assignment.loadId);
      if (!load) continue;
      loadIdsSet.add(load._id);
      driverLoads.push(load);
    }

    // Get stops for each load
    const resultWithNulls = await Promise.all(
      driverLoads.map(async (load) => {
        if (!load) return null;

        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();

        // Sort stops by sequence
        stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

        const pickups = stops.filter((s) => s.stopType === 'PICKUP');
        const deliveries = stops.filter((s) => s.stopType === 'DELIVERY');

        const firstPickup = pickups[0];
        const lastDelivery = deliveries[deliveries.length - 1];

        const facets = await getLoadFacets(ctx, load._id);

        return {
          _id: load._id,
          internalId: load.internalId,
          orderNumber: load.orderNumber,
          parsedHcr: facets.hcr,
          parsedTripNumber: facets.trip,
          status: load.status,
          trackingStatus: load.trackingStatus,
          customerName: load.customerName,
          firstStopDate: load.firstStopDate,
          effectiveMiles: load.effectiveMiles,
          stopCount: load.stopCount || stops.length,
          equipmentType: load.equipmentType,
          commodityDescription: load.commodityDescription,
          firstPickup: firstPickup
            ? {
                city: firstPickup.city,
                state: firstPickup.state,
                windowBeginDate: firstPickup.windowBeginDate,
                windowBeginTime: firstPickup.windowBeginTime,
              }
            : undefined,
          lastDelivery: lastDelivery
            ? {
                city: lastDelivery.city,
                state: lastDelivery.state,
                windowBeginDate: lastDelivery.windowBeginDate,
                windowEndTime: lastDelivery.windowEndTime,
              }
            : undefined,
        };
      }),
    );

    // Filter out nulls
    const result = resultWithNulls.filter((r): r is NonNullable<typeof r> => r !== null);

    // Sort by firstStopDate
    result.sort((a, b) => {
      if (!a.firstStopDate) return 1;
      if (!b.firstStopDate) return -1;
      return a.firstStopDate.localeCompare(b.firstStopDate);
    });

    return result;
  },
});

/**
 * Get detailed load information with all stops
 */
export const getLoadWithStops = query({
  args: {
    loadId: v.id('loadInformation'),
    driverId: v.id('drivers'),
  },
  returns: v.union(
    v.object({
      load: v.object({
        _id: v.id('loadInformation'),
        internalId: v.string(),
        orderNumber: v.string(),
        poNumber: v.optional(v.string()),
        status: v.string(),
        trackingStatus: v.string(),
        customerName: v.optional(v.string()),
        effectiveMiles: v.optional(v.number()),
        equipmentType: v.optional(v.string()),
        commodityDescription: v.optional(v.string()),
        weight: v.optional(v.number()),
        temperature: v.optional(v.number()),
        generalInstructions: v.optional(v.string()),
        contactPersonName: v.optional(v.string()),
        contactPersonPhone: v.optional(v.string()),
      }),
      stops: v.array(
        v.object({
          _id: v.id('loadStops'),
          sequenceNumber: v.number(),
          stopType: v.string(),
          loadingType: v.string(),
          status: v.optional(v.string()),
          address: v.string(),
          city: v.optional(v.string()),
          state: v.optional(v.string()),
          postalCode: v.optional(v.string()),
          latitude: v.optional(v.number()),
          longitude: v.optional(v.number()),
          referenceName: v.optional(v.string()),
          referenceValue: v.optional(v.string()),
          windowBeginDate: v.optional(v.string()),
          windowBeginTime: v.optional(v.string()),
          windowEndDate: v.optional(v.string()),
          windowEndTime: v.optional(v.string()),
          commodityDescription: v.optional(v.string()),
          pieces: v.optional(v.number()),
          weight: v.optional(v.number()),
          instructions: v.optional(v.string()),
          checkedInAt: v.optional(v.string()),
          checkedOutAt: v.optional(v.string()),
          // Detour fields
          isDetour: v.optional(v.boolean()),
          detourReason: v.optional(v.string()),
          detourNotes: v.optional(v.string()),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Resolve driver from JWT phone; verify args.driverId matches
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return null;
    }

    // Get load
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return null;
    }

    // Verify this driver is assigned to the load
    // Check 1: Direct assignment via primaryDriverId (broker's own drivers)
    let hasAccess = load.primaryDriverId === driver._id;

    // Check 2: Carrier assignment via loadCarrierAssignments
    if (!hasAccess) {
      const carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .first();

      if (carrierAssignment && carrierAssignment.assignedDriverId === driver._id) {
        hasAccess = true;
      }
    }

    if (!hasAccess) {
      return null;
    }

    // Get all stops for this load
    const stops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    // Sort by sequence number
    stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    return {
      load: {
        _id: load._id,
        internalId: load.internalId,
        orderNumber: load.orderNumber,
        poNumber: load.poNumber,
        status: load.status,
        trackingStatus: load.trackingStatus,
        customerName: load.customerName,
        effectiveMiles: load.effectiveMiles,
        equipmentType: load.equipmentType,
        commodityDescription: load.commodityDescription,
        weight: load.weight,
        temperature: load.temperature,
        generalInstructions: load.generalInstructions,
        contactPersonName: load.contactPersonName,
        contactPersonPhone: load.contactPersonPhone,
      },
      stops: stops.map((stop) => ({
        _id: stop._id,
        sequenceNumber: stop.sequenceNumber,
        stopType: stop.stopType,
        loadingType: stop.loadingType,
        status: stop.status,
        address: stop.address,
        city: stop.city,
        state: stop.state,
        postalCode: stop.postalCode,
        latitude: stop.latitude,
        longitude: stop.longitude,
        referenceName: stop.referenceName,
        referenceValue: stop.referenceValue,
        windowBeginDate: stop.windowBeginDate,
        windowBeginTime: stop.windowBeginTime,
        windowEndDate: stop.windowEndDate,
        windowEndTime: stop.windowEndTime,
        commodityDescription: stop.commodityDescription,
        pieces: stop.pieces,
        weight: stop.weight,
        instructions: stop.instructions,
        checkedInAt: stop.checkedInAt,
        checkedOutAt: stop.checkedOutAt,
        // Detour fields
        isDetour: stop.isDetour,
        detourReason: stop.detourReason,
        detourNotes: stop.detourNotes,
      })),
    };
  },
});

// ============================================
// DRIVER MUTATIONS
// ============================================

/**
 * Record driver check-in at a stop
 * Includes GPS validation and offline timestamp support
 */
export const checkInAtStop = mutation({
  args: {
    stopId: v.id('loadStops'),
    driverId: v.id('drivers'),
    latitude: v.number(),
    longitude: v.number(),
    // Timestamp from driver's device (when button was pressed, may be offline)
    driverTimestamp: v.string(), // ISO 8601 string
    notes: v.optional(v.string()),
    // Skip distance validation (for testing or special cases)
    skipDistanceCheck: v.optional(v.boolean()),
    // Driver flagged this stop as redirected to a different location
    isRedirected: v.optional(v.boolean()),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    distanceFromStop: v.optional(v.number()), // meters
  }),
  handler: async (ctx, args) => {
    // Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return { success: false, message: 'Not authenticated' };
    }

    // Get stop
    const stop = await ctx.db.get(args.stopId);
    if (!stop) {
      return { success: false, message: 'Stop not found' };
    }

    // Get load to verify driver assignment
    const load = await ctx.db.get(stop.loadId);
    if (!load) {
      return { success: false, message: 'Load not found' };
    }

    // Check driver access - either via primaryDriverId or carrier assignment
    let hasAccess = load.primaryDriverId === driver._id;
    if (!hasAccess) {
      const carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
        .first();
      if (carrierAssignment && carrierAssignment.assignedDriverId === driver._id) {
        hasAccess = true;
      }
    }
    if (!hasAccess) {
      return { success: false, message: 'Not authorized for this load' };
    }

    // GPS Distance Validation (if stop has coordinates)
    // Redirected stops always skip the geofence since the driver is at a different location
    const skipGeofence = args.skipDistanceCheck || args.isRedirected;
    let distanceFromStop: number | undefined;
    if (stop.latitude && stop.longitude && !skipGeofence) {
      distanceFromStop = calculateDistanceMeters(args.latitude, args.longitude, stop.latitude, stop.longitude);

      if (distanceFromStop > MAX_CHECKIN_DISTANCE_METERS) {
        return {
          success: false,
          message: `Too far from stop location (${Math.round(distanceFromStop)}m away, max ${MAX_CHECKIN_DISTANCE_METERS}m)`,
          distanceFromStop,
        };
      }
    }

    // Use driver's timestamp for check-in time (supports offline scenarios)
    // Server timestamp is recorded separately in updatedAt
    const checkinTime = args.driverTimestamp;

    await ctx.db.patch(args.stopId, {
      checkedInAt: checkinTime,
      checkinLatitude: args.latitude,
      checkinLongitude: args.longitude,
      status: 'In Transit',
      driverNotes: args.notes || stop.driverNotes,
      ...(args.isRedirected ? { isRedirected: true } : {}),
      updatedAt: Date.now(), // Server timestamp for audit
    });

    // Update load tracking status if this is the first stop
    if (stop.sequenceNumber === 1 && load.trackingStatus === 'Pending') {
      await ctx.db.patch(stop.loadId, {
        trackingStatus: 'In Transit',
        updatedAt: Date.now(),
      });
    }

    return { success: true, message: 'Checked in successfully', distanceFromStop };
  },
});

/**
 * Record driver check-out from a stop
 * Includes GPS validation and offline timestamp support
 */
export const checkOutFromStop = mutation({
  args: {
    stopId: v.id('loadStops'),
    driverId: v.id('drivers'),
    latitude: v.number(),
    longitude: v.number(),
    // Timestamp from driver's device (when button was pressed, may be offline)
    driverTimestamp: v.string(), // ISO 8601 string
    notes: v.optional(v.string()),
    podPhotoUrl: v.optional(v.string()), // S3 URL for proof of delivery photo
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    // Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return { success: false, message: 'Not authenticated' };
    }

    // Get stop
    const stop = await ctx.db.get(args.stopId);
    if (!stop) {
      return { success: false, message: 'Stop not found' };
    }

    // Get load to verify driver assignment
    const load = await ctx.db.get(stop.loadId);
    if (!load) {
      return { success: false, message: 'Load not found' };
    }

    // Check driver access - either via primaryDriverId or carrier assignment
    let hasAccess = load.primaryDriverId === driver._id;
    if (!hasAccess) {
      const carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
        .first();
      if (carrierAssignment && carrierAssignment.assignedDriverId === driver._id) {
        hasAccess = true;
      }
    }
    if (!hasAccess) {
      return { success: false, message: 'Not authorized for this load' };
    }

    // Calculate dwell time using driver timestamps (accurate for offline scenarios)
    let dwellTime: number | undefined;
    if (stop.checkedInAt) {
      const checkInTime = new Date(stop.checkedInAt).getTime();
      const checkOutTime = new Date(args.driverTimestamp).getTime();
      dwellTime = Math.round((checkOutTime - checkInTime) / (1000 * 60)); // minutes
    }

    // Use driver's timestamp for check-out time (supports offline scenarios)
    await ctx.db.patch(args.stopId, {
      checkedOutAt: args.driverTimestamp,
      checkoutLatitude: args.latitude,
      checkoutLongitude: args.longitude,
      status: 'Completed',
      dwellTime,
      driverNotes: args.notes || stop.driverNotes,
      updatedAt: Date.now(), // Server timestamp for audit
    });

    // #region agent log
    console.log(
      '[DEBUG-ec49a3] checkOutFromStop POD:',
      JSON.stringify({
        hasPodPhotoUrl: !!args.podPhotoUrl,
        podPhotoUrlPrefix: args.podPhotoUrl?.substring(0, 80),
        stopType: stop.stopType,
        willStore: !!(args.podPhotoUrl && stop.stopType === 'DELIVERY'),
        stopId: args.stopId,
        loadId: stop.loadId,
      }),
    );
    // #endregion

    // If POD photo provided, store it
    if (args.podPhotoUrl && stop.stopType === 'DELIVERY') {
      // Store POD URL in delivery photos array
      const existingPhotos = stop.deliveryPhotos || [];
      await ctx.db.patch(args.stopId, {
        deliveryPhotos: [...existingPhotos, args.podPhotoUrl],
      });
    }

    // Check if this is the last stop - update load status
    const allStops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
      .collect();

    // Exclude DETOUR stops and Canceled stops — they don't gate load completion.
    // Detour stops use fractional sequence numbers (e.g., 3.01) and would otherwise
    // be picked as "lastStop" by the reduce, blocking auto-completion of the load.
    const scheduledStops = allStops.filter(
      (s) => s.stopType !== 'DETOUR' && s.status !== 'Canceled',
    );
    const stopsForLastCheck = scheduledStops.length > 0 ? scheduledStops : allStops;
    const lastStop = stopsForLastCheck.reduce((prev, current) =>
      prev.sequenceNumber > current.sequenceNumber ? prev : current,
    );

    if (stop._id === lastStop._id) {
      // This is the last stop, mark load as completed through shared logic
      await ctx.runMutation(internal.loads.updateLoadStatusInternal, {
        loadId: stop.loadId,
        status: 'Completed',
      });
    }

    return { success: true, message: 'Checked out successfully' };
  },
});

/**
 * Update stop status (delayed, etc.)
 */
export const updateStopStatus = mutation({
  args: {
    stopId: v.id('loadStops'),
    driverId: v.id('drivers'),
    status: v.union(
      v.literal('Pending'),
      v.literal('In Transit'),
      v.literal('Completed'),
      v.literal('Delayed'),
      v.literal('Canceled'),
    ),
    driverTimestamp: v.string(), // ISO 8601 string
    notes: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    // Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return { success: false, message: 'Not authenticated' };
    }

    // Get stop
    const stop = await ctx.db.get(args.stopId);
    if (!stop) {
      return { success: false, message: 'Stop not found' };
    }

    // Get load to verify driver assignment
    const load = await ctx.db.get(stop.loadId);
    if (!load) {
      return { success: false, message: 'Load not found' };
    }

    // Check driver access - either via primaryDriverId or carrier assignment
    let hasAccess = load.primaryDriverId === driver._id;
    if (!hasAccess) {
      const carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
        .first();
      if (carrierAssignment && carrierAssignment.assignedDriverId === driver._id) {
        hasAccess = true;
      }
    }
    if (!hasAccess) {
      return { success: false, message: 'Not authorized for this load' };
    }

    // Update status using driver timestamp
    await ctx.db.patch(args.stopId, {
      status: args.status,
      statusUpdatedAt: args.driverTimestamp,
      driverNotes: args.notes || stop.driverNotes,
      updatedAt: Date.now(),
    });

    // Update load tracking status if delayed
    if (args.status === 'Delayed') {
      await ctx.db.patch(stop.loadId, {
        trackingStatus: 'Delayed',
        updatedAt: Date.now(),
      });
    }

    return { success: true, message: `Status updated to ${args.status}` };
  },
});

/**
 * Record proof of delivery (POD) photo URL
 */
export const recordPOD = mutation({
  args: {
    stopId: v.id('loadStops'),
    driverId: v.id('drivers'),
    photoUrl: v.string(), // S3 URL
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    // Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return { success: false, message: 'Not authenticated' };
    }

    // Get stop
    const stop = await ctx.db.get(args.stopId);
    if (!stop) {
      return { success: false, message: 'Stop not found' };
    }

    // Get load to verify driver assignment
    const load = await ctx.db.get(stop.loadId);
    if (!load) {
      return { success: false, message: 'Load not found' };
    }

    // Check driver access - either via primaryDriverId or carrier assignment
    let hasAccess = load.primaryDriverId === driver._id;
    if (!hasAccess) {
      const carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', stop.loadId))
        .first();
      if (carrierAssignment && carrierAssignment.assignedDriverId === driver._id) {
        hasAccess = true;
      }
    }
    if (!hasAccess) {
      return { success: false, message: 'Not authorized for this load' };
    }

    // Add photo to delivery photos
    const existingPhotos = stop.deliveryPhotos || [];
    await ctx.db.patch(args.stopId, {
      deliveryPhotos: [...existingPhotos, args.photoUrl],
      updatedAt: Date.now(),
    });

    return { success: true, message: 'POD photo recorded' };
  },
});

/**
 * Update driver's current GPS location (for live tracking)
 */
export const updateDriverLocation = mutation({
  args: {
    driverId: v.id('drivers'),
    latitude: v.number(),
    longitude: v.number(),
  },
  returns: v.object({
    success: v.boolean(),
  }),
  handler: async (ctx, args) => {
    // Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return { success: false };
    }

    // Require an assigned truck to update location
    if (!driver.currentTruckId) {
      return { success: false };
    }

    // Update truck's last known location
    await ctx.db.patch(driver.currentTruckId, {
      lastLocationLat: args.latitude,
      lastLocationLng: args.longitude,
      lastLocationUpdatedAt: Date.now(),
    });

    return { success: true };
  },
});

/**
 * Switch driver's assigned truck via QR code scan
 * Called from mobile app when driver scans truck QR code
 */
export const switchTruck = mutation({
  args: {
    driverId: v.id('drivers'),
    truckId: v.id('trucks'),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    truck: v.optional(
      v.object({
        _id: v.id('trucks'),
        unitId: v.string(),
        make: v.optional(v.string()),
        model: v.optional(v.string()),
        year: v.optional(v.number()),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    // Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return { success: false, message: 'Not authenticated' };
    }

    // Get truck
    const truck = await ctx.db.get(args.truckId);
    if (!truck) {
      return { success: false, message: 'Truck not found' };
    }
    if (truck.isDeleted) {
      return { success: false, message: 'This truck has been deactivated' };
    }

    // Verify truck belongs to same organization as driver
    if (truck.organizationId !== driver.organizationId) {
      return { success: false, message: 'This truck belongs to a different organization' };
    }

    // Check truck status - warn if not active
    if (truck.status !== 'Active') {
      return {
        success: false,
        message: `This truck is currently ${truck.status.toLowerCase()}. Please select an active truck.`,
      };
    }

    // Check if already assigned to this truck
    if (driver.currentTruckId === args.truckId) {
      return {
        success: true,
        message: 'You are already assigned to this truck',
        truck: {
          _id: truck._id,
          unitId: truck.unitId,
          make: truck.make,
          model: truck.model,
          year: truck.year,
        },
      };
    }

    // Update driver's current truck assignment
    await ctx.db.patch(args.driverId, {
      currentTruckId: args.truckId,
      updatedAt: Date.now(),
    });

    return {
      success: true,
      message: `Successfully switched to truck ${truck.unitId}`,
      truck: {
        _id: truck._id,
        unitId: truck.unitId,
        make: truck.make,
        model: truck.model,
        year: truck.year,
      },
    };
  },
});

/**
 * Get truck details by ID (for QR code validation)
 * Used to show truck info before confirming switch
 */
export const getTruckForSwitch = query({
  args: {
    truckId: v.id('trucks'),
    driverId: v.id('drivers'),
  },
  returns: v.union(
    v.object({
      _id: v.id('trucks'),
      unitId: v.string(),
      make: v.optional(v.string()),
      model: v.optional(v.string()),
      year: v.optional(v.number()),
      status: v.string(),
      canSwitch: v.boolean(),
      reason: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return null;
    }

    // Get truck
    const truck = await ctx.db.get(args.truckId);
    if (!truck) {
      return null;
    }

    // Check if can switch
    let canSwitch = true;
    let reason: string | undefined;

    if (truck.isDeleted) {
      canSwitch = false;
      reason = 'This truck has been deactivated';
    } else if (truck.organizationId !== driver.organizationId) {
      canSwitch = false;
      reason = 'This truck belongs to a different organization';
    } else if (truck.status !== 'Active') {
      canSwitch = false;
      reason = `This truck is currently ${truck.status.toLowerCase()}`;
    }

    return {
      _id: truck._id,
      unitId: truck.unitId,
      make: truck.make,
      model: truck.model,
      year: truck.year,
      status: truck.status,
      canSwitch,
      reason,
    };
  },
});

// ============================================
// DETOUR STOPS
// ============================================

/**
 * Add detour stops to a load.
 * Driver-initiated — creates DETOUR stop(s) in the loadStops table
 * at the current GPS location. Stops are inserted after the current
 * active stop (or appended at the end).
 */
export const addDetourStops = mutation({
  args: {
    loadId: v.id('loadInformation'),
    driverId: v.id('drivers'),
    numberOfStops: v.number(),
    reason: v.union(
      v.literal('FUEL'),
      v.literal('REST'),
      v.literal('FOOD'),
      v.literal('SCALE'),
      v.literal('REPAIR'),
      v.literal('REDIRECT'),
      v.literal('CUSTOMER'),
      v.literal('OTHER'),
    ),
    notes: v.optional(v.string()),
    // Driver's current GPS position (used as the detour location)
    latitude: v.number(),
    longitude: v.number(),
    // Driver's device timestamp
    driverTimestamp: v.string(), // ISO 8601
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    stopIds: v.optional(v.array(v.id('loadStops'))),
  }),
  handler: async (ctx, args) => {
    // 1. Verify the JWT phone claim matches args.driverId
    let driver: Doc<'drivers'>;
    try {
      driver = await resolveAuthenticatedDriver(ctx, args.driverId);
    } catch {
      return { success: false, message: 'Not authenticated' };
    }

    // 2. Verify load and driver access
    const load = await ctx.db.get(args.loadId);
    if (!load) {
      return { success: false, message: 'Load not found' };
    }

    let hasAccess = load.primaryDriverId === driver._id;
    if (!hasAccess) {
      const carrierAssignment = await ctx.db
        .query('loadCarrierAssignments')
        .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
        .first();
      if (carrierAssignment && carrierAssignment.assignedDriverId === driver._id) {
        hasAccess = true;
      }
    }
    if (!hasAccess) {
      return { success: false, message: 'Not authorized for this load' };
    }

    // 4. Get existing stops to determine insertion point
    const existingStops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();
    existingStops.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    // Find the current active stop (checked in but not checked out),
    // or the last completed stop, to insert detours after
    const activeStop = existingStops.find((s) => s.checkedInAt && !s.checkedOutAt && s.stopType !== 'DETOUR');
    const lastCompletedStop = [...existingStops].reverse().find((s) => s.status === 'Completed');

    const afterStop = activeStop || lastCompletedStop || existingStops[existingStops.length - 1];
    const afterStopId = afterStop?._id;

    // Calculate the sequence number for new detour stops.
    // Use fractional sequences (e.g., 1.1, 1.2) to avoid renumbering existing stops.
    const baseSequence = afterStop ? afterStop.sequenceNumber : existingStops.length;

    const now = Date.now();
    const driverUserId = driver._id; // Use driver's Convex ID
    const stopIds: Id<'loadStops'>[] = [];

    const reasonLabels: Record<string, string> = {
      FUEL: 'Fuel Stop',
      REST: 'Rest Stop',
      FOOD: 'Food Stop',
      SCALE: 'Weigh Station',
      REPAIR: 'Repair Stop',
      REDIRECT: 'Redirect',
      CUSTOMER: 'Customer Stop',
      OTHER: 'Detour Stop',
    };

    // 5. Create the detour stop(s)
    for (let i = 0; i < args.numberOfStops; i++) {
      const stopId = await ctx.db.insert('loadStops', {
        loadId: args.loadId,
        internalId: load.internalId,

        // Fractional sequence: 2.01, 2.02, etc.
        sequenceNumber: baseSequence + (i + 1) * 0.01,

        stopType: 'DETOUR',
        loadingType: 'N/A',
        status: 'Pending',

        // Location = driver's current GPS
        address: `${reasonLabels[args.reason]} (GPS: ${args.latitude.toFixed(4)}, ${args.longitude.toFixed(4)})`,
        latitude: args.latitude,
        longitude: args.longitude,

        // Detour-specific fields
        isDetour: true,
        detourReason: args.reason,
        detourNotes: args.notes,
        detourRequestedAt: args.driverTimestamp,
        detourRequestedBy: driverUserId,
        afterStopId,

        // WorkOS org from the load
        workosOrgId: load.workosOrgId,

        createdAt: now,
        updatedAt: now,
      });

      stopIds.push(stopId);
    }

    // 6. Update load stop count
    await ctx.db.patch(args.loadId, {
      stopCount: (load.stopCount ?? existingStops.length) + args.numberOfStops,
      updatedAt: now,
    });

    const label = args.numberOfStops === 1 ? 'Detour stop' : `${args.numberOfStops} detour stops`;
    return {
      success: true,
      message: `${label} added to route`,
      stopIds,
    };
  },
});
