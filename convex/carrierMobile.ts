import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { internal } from './_generated/api';
import { Id } from './_generated/dataModel';

/**
 * Carrier Mobile API
 * Specialized queries/mutations for carrier owner mobile app
 * Focused on owner dashboard, load management, and driver oversight
 */

/**
 * Helper to authenticate carrier mobile requests.
 * Verifies the caller is authenticated and belongs to the claimed organization.
 * Returns the identity or null if unauthorized.
 */
async function requireCarrierAuth(
  ctx: { auth: { getUserIdentity: () => Promise<any> }; db: any },
  carrierOrgId: string,
  carrierConvexId?: string | null
): Promise<{ identity: any } | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;

  // Look up user's identity link by Clerk user ID
  const identityLink = await ctx.db
    .query('userIdentityLinks')
    .withIndex('by_clerk', (q: any) => q.eq('clerkUserId', identity.subject))
    .first();

  if (!identityLink) return null;

  // Verify the identity link's organization matches the requested org
  const org = await ctx.db.get(identityLink.organizationId);
  if (!org) return null;

  const orgMatchesExternalId =
    org.clerkOrgId === carrierOrgId ||
    org.workosOrgId === carrierOrgId ||
    org._id === carrierOrgId;

  const orgMatchesConvexId =
    !carrierConvexId || org._id === carrierConvexId;

  if (!orgMatchesExternalId || !orgMatchesConvexId) return null;

  return { identity };
}

// ==========================================
// DASHBOARD QUERIES
// ==========================================

/**
 * Helper function to validate organization is not deleted
 * Used by queries to prevent returning data for deleted orgs
 */
async function validateOrgNotDeleted(
  ctx: { db: { get: (id: Id<'organizations'>) => Promise<{ isDeleted?: boolean; name: string } | null> } },
  orgId: string | null
): Promise<{ valid: boolean; error?: string }> {
  if (!orgId) {
    return { valid: false, error: 'Organization ID is required' };
  }
  
  try {
    const org = await ctx.db.get(orgId as Id<'organizations'>);
    if (!org) {
      return { valid: false, error: 'Organization not found' };
    }
    if (org.isDeleted) {
      return { valid: false, error: `Organization "${org.name}" has been deactivated` };
    }
    return { valid: true };
  } catch {
    // If orgId is not a valid Convex ID format (e.g., it's a clerkOrgId), skip validation
    // The queries will still work with clerkOrgId for load assignments
    return { valid: true };
  }
}

/**
 * Get carrier owner dashboard data
 * Aggregates key metrics for the home screen
 */
export const getDashboard = query({
  args: {
    carrierOrgId: v.string(), // External ID (clerkOrgId/workosOrgId) for loadCarrierAssignments
    carrierConvexId: v.optional(v.string()), // Convex document ID for drivers table
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId, args.carrierConvexId);
    if (!auth) {
      return {
        activeLoads: 0, pendingStart: 0, newOffers: 0,
        completedThisWeek: 0, totalDrivers: 0, driversOnDuty: 0,
        weekRevenue: 0, pendingPaymentAmount: 0, pendingPaymentCount: 0,
      };
    }

    // Validate organization is not deleted
    if (args.carrierConvexId) {
      const validation = await validateOrgNotDeleted(ctx, args.carrierConvexId);
      if (!validation.valid) {
        return {
          activeLoads: 0, pendingStart: 0, newOffers: 0,
          completedThisWeek: 0, totalDrivers: 0, driversOnDuty: 0,
          weekRevenue: 0, pendingPaymentAmount: 0, pendingPaymentCount: 0,
          error: validation.error,
        };
      }
    }

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
    
    // Use Convex ID for drivers, fallback to carrierOrgId for backward compatibility
    const driversOrgId = args.carrierConvexId || args.carrierOrgId;

    // Get active load assignments (uses external ID)
    const activeAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'IN_PROGRESS')
      )
      .collect();

    // Get awarded (pending start)
    const awardedAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'AWARDED')
      )
      .collect();

    // Get offered loads (new offers)
    const offeredAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'OFFERED')
      )
      .collect();

    // Get completed this week
    const completedAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'COMPLETED')
      )
      .collect();

    const completedThisWeek = completedAssignments.filter(
      (a) => a.completedAt && a.completedAt >= oneWeekAgo
    );

    // Get carrier's drivers (uses Convex document ID)
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', driversOrgId))
      .collect();

    const activeDrivers = drivers.filter((d) => d.employmentStatus === 'Active');

    // Get recent driver locations (drivers on duty)
    const driversOnDuty = [];
    for (const driver of activeDrivers) {
      const recentLocation = await ctx.db
        .query('driverLocations')
        .withIndex('by_driver_time', (q) => q.eq('driverId', driver._id))
        .order('desc')
        .first();

      if (recentLocation && recentLocation.recordedAt >= oneDayAgo) {
        driversOnDuty.push({
          driver,
          lastLocation: recentLocation,
        });
      }
    }

    // Calculate week's revenue
    const weekRevenue = completedThisWeek.reduce(
      (sum, a) => sum + (a.carrierTotalAmount || 0),
      0
    );

    // Get pending payments
    const pendingPayments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier_payment', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('paymentStatus', 'PENDING')
      )
      .collect();

    const pendingAmount = pendingPayments.reduce(
      (sum, a) => sum + (a.carrierTotalAmount || 0),
      0
    );

    return {
      activeLoads: activeAssignments.length,
      pendingStart: awardedAssignments.length,
      newOffers: offeredAssignments.length,
      completedThisWeek: completedThisWeek.length,
      totalDrivers: activeDrivers.length,
      driversOnDuty: driversOnDuty.length,
      weekRevenue,
      pendingPaymentAmount: pendingAmount,
      pendingPaymentCount: pendingPayments.length,
    };
  },
});

/**
 * Get list of offered loads (for carrier to accept/decline)
 */
export const getOfferedLoads = query({
  args: {
    carrierOrgId: v.string(),
    carrierConvexId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId, args.carrierConvexId);
    if (!auth) return [];

    // Check if organization is deleted - return empty if so
    if (args.carrierConvexId) {
      const validation = await validateOrgNotDeleted(ctx, args.carrierConvexId);
      if (!validation.valid) {
        return [];
      }
    }

    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'OFFERED')
      )
      .order('desc')
      .take(args.limit || 50);

    // Enrich with load details
    return Promise.all(
      assignments.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        const stops = load
          ? await ctx.db
              .query('loadStops')
              .withIndex('by_load', (q) => q.eq('loadId', load._id))
              .collect()
          : [];

        // Safe load data (no broker pricing)
        const safeLoad = load
          ? {
              _id: load._id,
              internalId: load.internalId,
              customerName: load.customerName,
              equipmentType: load.equipmentType,
              commodityDescription: load.commodityDescription,
              weight: load.weight,
              effectiveMiles: load.effectiveMiles,
              isHazmat: load.isHazmat,
              requiresTarp: load.requiresTarp,
              tripNumber: load.parsedTripNumber,
              hcr: load.parsedHcr,
            }
          : null;

        return {
          ...assignment,
          load: safeLoad,
          stops: stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber),
        };
      })
    );
  },
});

/**
 * Get active/in-progress loads
 */
export const getActiveLoads = query({
  args: {
    carrierOrgId: v.string(),
    carrierConvexId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId, args.carrierConvexId);
    if (!auth) return [];

    // Check if organization is deleted - return empty if so
    if (args.carrierConvexId) {
      const validation = await validateOrgNotDeleted(ctx, args.carrierConvexId);
      if (!validation.valid) {
        return [];
      }
    }

    // Get both AWARDED and IN_PROGRESS
    const awarded = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'AWARDED')
      )
      .collect();

    const inProgress = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'IN_PROGRESS')
      )
      .collect();

    const assignments = [...awarded, ...inProgress];

    // Enrich with load and driver details
    return Promise.all(
      assignments.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        const stops = load
          ? await ctx.db
              .query('loadStops')
              .withIndex('by_load', (q) => q.eq('loadId', load._id))
              .collect()
          : [];

        let driver = null;
        let driverLocation = null;
        if (assignment.assignedDriverId) {
          driver = await ctx.db.get(assignment.assignedDriverId);
          // Get latest location for this driver
          driverLocation = await ctx.db
            .query('driverLocations')
            .withIndex('by_driver_time', (q) =>
              q.eq('driverId', assignment.assignedDriverId!)
            )
            .order('desc')
            .first();
        }

        return {
          ...assignment,
          load: load
            ? {
                _id: load._id,
                internalId: load.internalId,
                customerName: load.customerName,
                trackingStatus: load.trackingStatus,
                effectiveMiles: load.effectiveMiles,
                equipmentType: load.equipmentType,
                tripNumber: load.parsedTripNumber,
                hcr: load.parsedHcr,
              }
            : null,
          stops: stops.sort((a, b) => a.sequenceNumber - b.sequenceNumber),
          driver: driver
            ? {
                _id: driver._id,
                firstName: driver.firstName,
                lastName: driver.lastName,
                phone: driver.phone,
              }
            : null,
          driverLocation,
        };
      })
    );
  },
});

/**
 * Get completed loads (history)
 */
export const getCompletedLoads = query({
  args: {
    carrierOrgId: v.string(),
    limit: v.optional(v.number()),
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) return [];

    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'COMPLETED')
      )
      .order('desc')
      .collect();

    // Filter by date range
    let filtered = assignments;
    if (args.startDate || args.endDate) {
      filtered = assignments.filter((a) => {
        if (!a.completedAt) return false;
        if (args.startDate && a.completedAt < args.startDate) return false;
        if (args.endDate && a.completedAt > args.endDate) return false;
        return true;
      });
    }

    const limited = args.limit ? filtered.slice(0, args.limit) : filtered;

    // Enrich with load info
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
                equipmentType: load.equipmentType,
                tripNumber: load.parsedTripNumber,
                hcr: load.parsedHcr,
              }
            : null,
        };
      })
    );
  },
});

// ==========================================
// DRIVER MANAGEMENT
// ==========================================

/**
 * Get carrier's drivers
 */
export const getDrivers = query({
  args: {
    carrierOrgId: v.string(),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) return [];

    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.carrierOrgId))
      .collect();

    // Filter by status if provided
    const filtered = args.status
      ? drivers.filter((d) => d.employmentStatus === args.status)
      : drivers.filter((d) => d.employmentStatus === 'Active');

    // Get latest location for each driver
    return Promise.all(
      filtered.map(async (driver) => {
        const lastLocation = await ctx.db
          .query('driverLocations')
          .withIndex('by_driver_time', (q) => q.eq('driverId', driver._id))
          .order('desc')
          .first();

        // Get current load assignment if any
        const currentAssignment = await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_carrier', (q) =>
            q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'IN_PROGRESS')
          )
          .collect()
          .then((assignments) =>
            assignments.find((a) => a.assignedDriverId === driver._id)
          );

        // Get load details if there's an assignment
        let currentLoad = null;
        if (currentAssignment) {
          const load = await ctx.db.get(currentAssignment.loadId);
          if (load) {
            currentLoad = {
              _id: load._id,
              internalId: load.internalId,
            };
          }
        }

        return {
          ...driver,
          lastLocation,
          currentAssignment,
          currentLoad,
        };
      })
    );
  },
});

/**
 * Get available drivers (not on active load)
 */
export const getAvailableDrivers = query({
  args: {
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) return [];

    // Get all active drivers
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.carrierOrgId))
      .collect();

    const activeDrivers = drivers.filter(
      (d) => d.employmentStatus === 'Active' && !d.isDeleted
    );

    // Get current in-progress assignments
    const inProgressAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'IN_PROGRESS')
      )
      .collect();

    const busyDriverIds = new Set(
      inProgressAssignments
        .filter((a) => a.assignedDriverId)
        .map((a) => a.assignedDriverId!.toString())
    );

    // Filter to available drivers
    const availableDrivers = activeDrivers.filter(
      (d) => !busyDriverIds.has(d._id.toString())
    );

    return availableDrivers.map((d) => ({
      _id: d._id,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      currentTruckId: d.currentTruckId,
    }));
  },
});

// ==========================================
// LIVE TRACKING
// ==========================================

/**
 * Get all driver locations for tracking map
 */
export const getDriverLocations = query({
  args: {
    carrierOrgId: v.string(), // Convex document ID for drivers table
    carrierExternalOrgId: v.optional(v.string()), // External ID for loadCarrierAssignments (clerkOrgId/workosOrgId)
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const authOrgId = args.carrierExternalOrgId || args.carrierOrgId;
    const auth = await requireCarrierAuth(ctx, authOrgId, args.carrierOrgId);
    if (!auth) return [];

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    
    // Use external ID for load assignments, fallback to carrierOrgId for backward compatibility
    const loadCarrierOrgId = args.carrierExternalOrgId || args.carrierOrgId;

    // Get active drivers (uses Convex document ID)
    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.carrierOrgId))
      .collect();

    const activeDrivers = drivers.filter(
      (d) => d.employmentStatus === 'Active' && !d.isDeleted
    );

    // Get latest location for each driver
    const locations = [];
    for (const driver of activeDrivers) {
      const lastLocation = await ctx.db
        .query('driverLocations')
        .withIndex('by_driver_time', (q) => q.eq('driverId', driver._id))
        .order('desc')
        .first();

      if (lastLocation && lastLocation.recordedAt >= oneDayAgo) {
        // Get current load if any (uses external ID)
        const currentAssignment = await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_carrier', (q) =>
            q.eq('carrierOrgId', loadCarrierOrgId).eq('status', 'IN_PROGRESS')
          )
          .collect()
          .then((assignments) =>
            assignments.find((a) => a.assignedDriverId === driver._id)
          );

        let load = null;
        if (currentAssignment) {
          load = await ctx.db.get(currentAssignment.loadId);
        }

        locations.push({
          driver: {
            _id: driver._id,
            firstName: driver.firstName,
            lastName: driver.lastName,
            phone: driver.phone,
          },
          location: lastLocation,
          currentLoad: load
            ? {
                _id: load._id,
                internalId: load.internalId,
                customerName: load.customerName,
              }
            : null,
        });
      }
    }

    return locations;
  },
});

/**
 * Get route history for a specific load
 */
export const getLoadRouteHistory = query({
  args: {
    loadId: v.id('loadInformation'),
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) throw new Error('Not authenticated');

    // Verify this load belongs to this carrier
    const assignment = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .first();

    if (!assignment || assignment.carrierOrgId !== args.carrierOrgId) {
      throw new Error('Load not found or does not belong to carrier');
    }

    // Get all location points for this load
    const locations = await ctx.db
      .query('driverLocations')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .order('asc')
      .collect();

    return locations;
  },
});

// ==========================================
// SETTLEMENTS / EARNINGS
// ==========================================

/**
 * Get earnings summary
 */
export const getEarningsSummary = query({
  args: {
    carrierOrgId: v.string(),
    periodDays: v.optional(v.number()), // 7, 30, 90, etc.
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) {
      return {
        periodDays: args.periodDays || 30, totalLoads: 0, totalEarnings: 0,
        paidAmount: 0, pendingAmount: 0, disputedAmount: 0, averagePerLoad: 0,
      };
    }

    const now = Date.now();
    const periodMs = (args.periodDays || 30) * 24 * 60 * 60 * 1000;
    const periodStart = now - periodMs;

    // Get completed assignments in period
    const completedAssignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'COMPLETED')
      )
      .collect();

    const inPeriod = completedAssignments.filter(
      (a) => a.completedAt && a.completedAt >= periodStart
    );

    // Calculate totals by payment status
    const byPaymentStatus = {
      PENDING: 0,
      INVOICED: 0,
      SCHEDULED: 0,
      PAID: 0,
      DISPUTED: 0,
    };

    for (const a of inPeriod) {
      const status = a.paymentStatus || 'PENDING';
      byPaymentStatus[status as keyof typeof byPaymentStatus] += a.carrierTotalAmount || 0;
    }

    return {
      periodDays: args.periodDays || 30,
      totalLoads: inPeriod.length,
      totalEarnings: inPeriod.reduce((sum, a) => sum + (a.carrierTotalAmount || 0), 0),
      paidAmount: byPaymentStatus.PAID,
      pendingAmount:
        byPaymentStatus.PENDING +
        byPaymentStatus.INVOICED +
        byPaymentStatus.SCHEDULED,
      disputedAmount: byPaymentStatus.DISPUTED,
      averagePerLoad:
        inPeriod.length > 0
          ? inPeriod.reduce((sum, a) => sum + (a.carrierTotalAmount || 0), 0) /
            inPeriod.length
          : 0,
    };
  },
});

/**
 * Get recent payment activity
 */
export const getRecentPayments = query({
  args: {
    carrierOrgId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) return [];

    // Get completed assignments with payments
    const assignments = await ctx.db
      .query('loadCarrierAssignments')
      .withIndex('by_carrier', (q) =>
        q.eq('carrierOrgId', args.carrierOrgId).eq('status', 'COMPLETED')
      )
      .collect();

    // Sort by payment date (most recent first), then by completed date
    const sorted = assignments.sort((a, b) => {
      const dateA = a.paymentDate || a.completedAt || 0;
      const dateB = b.paymentDate || b.completedAt || 0;
      return dateB - dateA;
    });

    const limited = sorted.slice(0, args.limit || 20);

    return Promise.all(
      limited.map(async (assignment) => {
        const load = await ctx.db.get(assignment.loadId);
        return {
          _id: assignment._id,
          loadInternalId: load?.internalId,
          customerName: load?.customerName,
          carrierTotalAmount: assignment.carrierTotalAmount,
          paymentStatus: assignment.paymentStatus,
          paymentMethod: assignment.paymentMethod,
          paymentDate: assignment.paymentDate,
          paymentAmount: assignment.paymentAmount,
          completedAt: assignment.completedAt,
        };
      })
    );
  },
});

// ==========================================
// BROKER PARTNERSHIPS
// ==========================================

/**
 * Get pending partnership invites
 */
export const getPendingPartnerships = query({
  args: {
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) return [];

    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_carrier', (q) => q.eq('carrierOrgId', args.carrierOrgId))
      .collect();

    const pending = partnerships.filter((p) => p.status === 'PENDING');

    // Enrich with broker info
    return Promise.all(
      pending.map(async (partnership) => {
        const brokerOrg = await ctx.db
          .query('organizations')
          .withIndex('by_organization', (q) =>
            q.eq('workosOrgId', partnership.brokerOrgId)
          )
          .first();

        return {
          ...partnership,
          brokerOrg: brokerOrg
            ? {
                name: brokerOrg.name,
                domain: brokerOrg.domain,
              }
            : null,
        };
      })
    );
  },
});

/**
 * Get active broker partnerships
 */
export const getActiveBrokers = query({
  args: {
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller belongs to this organization
    const auth = await requireCarrierAuth(ctx, args.carrierOrgId);
    if (!auth) return [];

    const partnerships = await ctx.db
      .query('carrierPartnerships')
      .withIndex('by_carrier', (q) => q.eq('carrierOrgId', args.carrierOrgId))
      .collect();

    const active = partnerships.filter((p) => p.status === 'ACTIVE');

    // Enrich and calculate stats
    return Promise.all(
      active.map(async (partnership) => {
        const brokerOrg = await ctx.db
          .query('organizations')
          .withIndex('by_organization', (q) =>
            q.eq('workosOrgId', partnership.brokerOrgId)
          )
          .first();

        // Get load count and revenue from this broker
        const assignments = await ctx.db
          .query('loadCarrierAssignments')
          .withIndex('by_broker', (q) => q.eq('brokerOrgId', partnership.brokerOrgId))
          .collect();

        const fromThisBroker = assignments.filter(
          (a) => a.carrierOrgId === args.carrierOrgId
        );

        const completed = fromThisBroker.filter((a) => a.status === 'COMPLETED');
        const totalRevenue = completed.reduce(
          (sum, a) => sum + (a.carrierTotalAmount || 0),
          0
        );

        return {
          ...partnership,
          brokerOrg: brokerOrg
            ? {
                name: brokerOrg.name,
                domain: brokerOrg.domain,
              }
            : null,
          stats: {
            totalLoads: completed.length,
            totalRevenue,
            activeLoads: fromThisBroker.filter(
              (a) => a.status === 'IN_PROGRESS' || a.status === 'AWARDED'
            ).length,
          },
        };
      })
    );
  },
});

// ==========================================
// USER ROLES
// ==========================================

/**
 * Get user roles for the current user
 * Used to determine if user is driver, carrier owner, or both
 */
export const getUserRoles = query({
  args: {
    clerkUserId: v.string(),
    clerkOrgId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Get user identity to extract phone number
    const identity = await ctx.auth.getUserIdentity();
    const userPhone = (identity as any)?.phoneNumber || (identity as any)?.phone_number;
    const normalizedUserPhone = userPhone ? userPhone.replace(/\D/g, '') : null;
    
    let isCarrierOwner = false;
    let carrierOrgId: string | null = null;
    let carrierOrgConvexId: string | null = null; // Convex document ID
    let orgType: string | null = null;
    let carrierOrgName: string | null = null;
    let carrierOrg: Awaited<ReturnType<typeof ctx.db.get<'organizations'>>> | null = null;
    
    // Org status tracking (for better error handling)
    let orgStatus: 'active' | 'deleted' | 'not_found' = 'not_found';
    let orgDeletionReason: string | null = null;
    let orgDeletedAt: number | null = null;

    // Method 1: Check identity link by clerkUserId
    const identityLink = await ctx.db
      .query('userIdentityLinks')
      .withIndex('by_clerk', (q) => q.eq('clerkUserId', args.clerkUserId))
      .first();

    if (identityLink) {
      const org = await ctx.db.get(identityLink.organizationId);
      if (org && (org.orgType === 'CARRIER' || org.orgType === 'BROKER_CARRIER')) {
        // Check if organization is soft-deleted
        if (org.isDeleted) {
          orgStatus = 'deleted';
          orgDeletionReason = org.deletionReason || 'Organization has been deactivated';
          orgDeletedAt = org.deletedAt || null;
          carrierOrgName = org.name; // Still store name for error message
          // Don't set isCarrierOwner = true for deleted orgs
        } else {
          orgStatus = 'active';
          isCarrierOwner = identityLink.role === 'OWNER' || identityLink.role === 'ADMIN';
          carrierOrgId = org.clerkOrgId || org.workosOrgId || null;
          carrierOrgConvexId = org._id;
          carrierOrgName = org.name;
          orgType = org.orgType;
          carrierOrg = org;
        }
      }
    }

    // Method 2: If not found by clerkUserId, try matching by phone number
    // SECURITY: Use exact match only (after normalizing both sides to digits)
    if (!isCarrierOwner && orgStatus !== 'deleted' && normalizedUserPhone) {
      const allIdentityLinks = await ctx.db
        .query('userIdentityLinks')
        .collect();

      const matchingLink = allIdentityLinks.find((link) => {
        if (!link.phone) return false;
        if (link.role !== 'OWNER' && link.role !== 'ADMIN') return false;
        const linkPhone = link.phone.replace(/\D/g, '');
        // Exact match only — no endsWith to prevent cross-org identity confusion
        return linkPhone === normalizedUserPhone;
      });

      if (matchingLink) {
        const org = await ctx.db.get(matchingLink.organizationId);
        if (org && (org.orgType === 'CARRIER' || org.orgType === 'BROKER_CARRIER')) {
          // Check if organization is soft-deleted
          if (org.isDeleted) {
            orgStatus = 'deleted';
            orgDeletionReason = org.deletionReason || 'Organization has been deactivated';
            orgDeletedAt = org.deletedAt || null;
            carrierOrgName = org.name;
          } else {
            orgStatus = 'active';
            isCarrierOwner = true;
            carrierOrgId = org.clerkOrgId || org.workosOrgId || null;
            carrierOrgConvexId = org._id;
            carrierOrgName = org.name;
            orgType = org.orgType;
            carrierOrg = org;
          }
        }
      }
    }

    // Check if user is also a driver
    let isDriver = false;
    let driverOrgId: string | null = null;
    let driverId: string | null = null;
    let isOwnerOperator = false;

    // Method 1: Check explicit ownerDriverId link on organization (for owner-operators)
    if (isCarrierOwner && carrierOrg?.isOwnerOperator) {
      // Organization is marked as owner-operator
      isOwnerOperator = true;
      
      // Check if driver record exists and is valid
      if (carrierOrg?.ownerDriverId) {
        const ownerDriver = await ctx.db.get(carrierOrg.ownerDriverId);
        if (ownerDriver && ownerDriver.employmentStatus === 'Active' && !ownerDriver.isDeleted) {
          isDriver = true;
          driverOrgId = ownerDriver.organizationId;
          driverId = ownerDriver._id;
        }
      }
    }

    // Method 2: Check carrierPartnerships for owner-operator status (broker-created carriers)
    // This handles cases where the broker flagged them as owner-operator but no driver record exists yet
    if (!isDriver && isCarrierOwner && carrierOrgConvexId) {
      // Try finding partnership by carrierOrgId (Convex ID)
      let partnerships = await ctx.db
        .query('carrierPartnerships')
        .withIndex('by_carrier', (q) => q.eq('carrierOrgId', carrierOrgConvexId!))
        .collect();
      
      // Fallback: If no partnerships found by carrierOrgId, try finding by MC#
      // This handles cases where carrierOrgId wasn't saved to the partnership
      if (partnerships.length === 0 && carrierOrg?.mcNumber) {
        const partnershipsByMc = await ctx.db
          .query('carrierPartnerships')
          .withIndex('by_mc', (q) => q.eq('mcNumber', carrierOrg.mcNumber!))
          .collect();
        partnerships = partnershipsByMc;
      }
      
      const ownerOpPartnership = partnerships.find(p => p.isOwnerOperator && p.status === 'ACTIVE');
      
      if (ownerOpPartnership) {
        // The broker has flagged this carrier as an owner-operator
        // Check if there's driver info in the partnership that we can use
        isOwnerOperator = true;
        
        // For owner-operators without a driver record, we need to create one or allow driver mode
        // For now, mark them as a driver so they can access driver features
        // The driver profile will be created/linked when they enter driver mode
        if (ownerOpPartnership.ownerDriverPhone || normalizedUserPhone) {
          isDriver = true;
          driverOrgId = carrierOrgConvexId;
          // driverId will be null - the app should handle creating/finding the driver record
        }
      }
    }

    // Method 3: Fallback to phone number matching (for backward compatibility)
    // SECURITY: Use exact match only (after normalizing both sides to digits)
    if (!isDriver && normalizedUserPhone) {
      // Search all drivers and match by phone number
      const allDrivers = await ctx.db
        .query('drivers')
        .collect();

      const matchingDriver = allDrivers.find((d) => {
        if (d.isDeleted || d.employmentStatus !== 'Active') return false;
        const driverPhone = d.phone.replace(/\D/g, '');
        // Exact match only — no endsWith to prevent cross-org identity confusion
        return driverPhone === normalizedUserPhone;
      });

      if (matchingDriver) {
        isDriver = true;
        driverOrgId = matchingDriver.organizationId;
        driverId = matchingDriver._id;
      }
    }

    return {
      isDriver,
      driverId,
      driverOrgId,
      isCarrierOwner,
      carrierOrgId,
      carrierOrgConvexId, // Convex document ID for direct queries
      carrierOrgName,
      orgType,
      isOwnerOperator, // True if explicitly linked as owner-operator
      isBroker: orgType === 'BROKER_CARRIER', // Has web TMS access
      // Organization status for better error handling
      orgStatus, // 'active' | 'deleted' | 'not_found'
      orgDeletionReason, // Reason if deleted
      orgDeletedAt, // Timestamp if deleted
    };
  },
});

// ==========================================
// DRIVER MANAGEMENT MUTATIONS
// ==========================================

/**
 * Create a new driver for the carrier organization
 * Called from the mobile app's driver management screen
 */
export const createDriver = mutation({
  args: {
    carrierOrgId: v.string(), // The carrier's organization ID (Convex document ID)
    firstName: v.string(),
    middleName: v.optional(v.string()),
    lastName: v.string(),
    email: v.string(),
    phone: v.string(),
    dateOfBirth: v.optional(v.string()),
    // License info
    licenseNumber: v.optional(v.string()),
    licenseState: v.optional(v.string()),
    licenseClass: v.optional(v.string()),
    licenseExpiration: v.optional(v.string()),
    // Employment
    employmentStatus: v.optional(v.string()),
    employmentType: v.optional(v.string()),
    // Notes
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated and belongs to this organization
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const now = Date.now();

    // Verify the organization exists and is a carrier
    const org = await ctx.db.get(args.carrierOrgId as Id<'organizations'>);
    if (!org) {
      throw new Error('Organization not found');
    }
    
    if (org.orgType !== 'CARRIER' && org.orgType !== 'BROKER_CARRIER') {
      throw new Error('Organization is not a carrier');
    }

    // Check if organization is deleted
    if (org.isDeleted) {
      throw new Error(`Cannot add drivers to deactivated organization "${org.name}"`);
    }

    // Check if driver with same phone already exists in this org
    const existingDrivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.carrierOrgId))
      .collect();
    
    const normalizedPhone = args.phone.replace(/\D/g, '');
    const existingDriver = existingDrivers.find(d => {
      if (d.isDeleted) return false;
      const driverPhone = d.phone.replace(/\D/g, '');
      return driverPhone === normalizedPhone;
    });

    if (existingDriver) {
      throw new Error('A driver with this phone number already exists');
    }

    // Create the driver
    const driverId = await ctx.db.insert('drivers', {
      organizationId: args.carrierOrgId,
      firstName: args.firstName,
      middleName: args.middleName || undefined,
      lastName: args.lastName,
      email: args.email,
      phone: args.phone,
      dateOfBirth: args.dateOfBirth || undefined,
      // License info - provide defaults if not specified
      licenseNumber: args.licenseNumber || undefined,
      licenseState: args.licenseState || 'N/A',
      licenseClass: args.licenseClass || 'Class A',
      licenseExpiration: args.licenseExpiration || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      // Employment
      employmentStatus: args.employmentStatus || 'Active',
      employmentType: args.employmentType || 'Full-time',
      hireDate: new Date().toISOString().split('T')[0],
      // System fields
      createdBy: 'mobile_app',
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
    });

    // Create Clerk user for mobile app authentication (async, non-blocking)
    // This allows the driver to log in via phone number
    ctx.scheduler.runAfter(0, internal.clerkSync.createClerkUserForDriver, {
      phone: args.phone,
      firstName: args.firstName,
      lastName: args.lastName,
    });

    return {
      success: true,
      driverId,
    };
  },
});

/**
 * Update an existing driver
 */
export const updateDriver = mutation({
  args: {
    driverId: v.id('drivers'),
    carrierOrgId: v.string(),
    firstName: v.optional(v.string()),
    middleName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    dateOfBirth: v.optional(v.string()),
    licenseNumber: v.optional(v.string()),
    licenseState: v.optional(v.string()),
    licenseClass: v.optional(v.string()),
    licenseExpiration: v.optional(v.string()),
    employmentStatus: v.optional(v.string()),
    employmentType: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const { driverId, carrierOrgId, ...updates } = args;

    // Verify organization is not deleted
    try {
      const org = await ctx.db.get(carrierOrgId as Id<'organizations'>);
      if (org?.isDeleted) {
        throw new Error(`Cannot update drivers in deactivated organization "${org.name}"`);
      }
    } catch (e) {
      // If carrierOrgId is not a valid Convex ID, skip org validation
      if ((e as Error).message.includes('deactivated')) throw e;
    }
    
    // Verify driver exists and belongs to this org
    const driver = await ctx.db.get(driverId);
    if (!driver) {
      throw new Error('Driver not found');
    }
    
    if (driver.organizationId !== carrierOrgId) {
      throw new Error('Driver does not belong to this organization');
    }

    // Remove undefined values
    const cleanUpdates: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        cleanUpdates[key] = value;
      }
    }

    await ctx.db.patch(driverId, cleanUpdates);

    // If phone number changed, update Clerk user
    if (updates.phone && updates.phone !== driver.phone) {
      ctx.scheduler.runAfter(0, internal.clerkSync.updateClerkUserPhone, {
        oldPhone: driver.phone,
        newPhone: updates.phone,
        firstName: updates.firstName || driver.firstName,
        lastName: updates.lastName || driver.lastName,
      });
    } else {
      // Phone didn't change - ensure Clerk user exists (for drivers created before sync was added)
      ctx.scheduler.runAfter(0, internal.clerkSync.createClerkUserForDriver, {
        phone: updates.phone || driver.phone,
        firstName: updates.firstName || driver.firstName,
        lastName: updates.lastName || driver.lastName,
      });
    }

    // === DRIVER → PARTNERSHIP SYNC: Update partnerships when owner-driver changes ===
    // Check if this driver is the owner-driver of their organization
    const org = await ctx.db.get(carrierOrgId as Id<'organizations'>);
    if (org?.isOwnerOperator && org.ownerDriverId === driverId) {
      // Find all partnerships linked to this carrier org
      const partnerships = await ctx.db
        .query('carrierPartnerships')
        .withIndex('by_carrier', (q) => q.eq('carrierOrgId', org.clerkOrgId || org.workosOrgId || org._id))
        .collect();
      
      // Also check by Convex ID directly
      const partnershipsByConvexId = await ctx.db
        .query('carrierPartnerships')
        .filter((q) => q.eq(q.field('carrierOrgId'), org._id))
        .collect();
      
      const allPartnerships = [...partnerships, ...partnershipsByConvexId];
      const seenIds = new Set<string>();
      
      for (const partnership of allPartnerships) {
        if (seenIds.has(partnership._id)) continue;
        seenIds.add(partnership._id);
        
        // Build partnership updates from driver changes
        const partnershipUpdates: Record<string, unknown> = { updatedAt: Date.now() };
        
        if (updates.firstName !== undefined) partnershipUpdates.ownerDriverFirstName = updates.firstName;
        if (updates.lastName !== undefined) partnershipUpdates.ownerDriverLastName = updates.lastName;
        if (updates.phone !== undefined) partnershipUpdates.ownerDriverPhone = updates.phone;
        if (updates.email !== undefined) partnershipUpdates.ownerDriverEmail = updates.email;
        if (updates.dateOfBirth !== undefined) partnershipUpdates.ownerDriverDOB = updates.dateOfBirth;
        if (updates.licenseNumber !== undefined) partnershipUpdates.ownerDriverLicenseNumber = updates.licenseNumber;
        if (updates.licenseState !== undefined) partnershipUpdates.ownerDriverLicenseState = updates.licenseState;
        if (updates.licenseClass !== undefined) partnershipUpdates.ownerDriverLicenseClass = updates.licenseClass;
        if (updates.licenseExpiration !== undefined) partnershipUpdates.ownerDriverLicenseExpiration = updates.licenseExpiration;
        
        // Only patch if there are actual partnership field updates
        if (Object.keys(partnershipUpdates).length > 1) {
          await ctx.db.patch(partnership._id, partnershipUpdates);
        }
      }
    }

    return { success: true };
  },
});

/**
 * Delete (soft delete) a driver
 */
export const deleteDriver = mutation({
  args: {
    driverId: v.id('drivers'),
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const driver = await ctx.db.get(args.driverId);
    if (!driver) {
      throw new Error('Driver not found');
    }
    
    if (driver.organizationId !== args.carrierOrgId) {
      throw new Error('Driver does not belong to this organization');
    }

    await ctx.db.patch(args.driverId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: 'mobile_app',
      updatedAt: Date.now(),
    });

    // Delete Clerk user to prevent login
    ctx.scheduler.runAfter(0, internal.clerkSync.deleteClerkUser, {
      phone: driver.phone,
    });

    return { success: true };
  },
});

/**
 * Get a single driver by ID
 * Used for the driver detail page
 */
export const getDriverById = query({
  args: {
    driverId: v.id('drivers'),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const driver = await ctx.db.get(args.driverId);
    
    if (!driver || driver.isDeleted) {
      return null;
    }

    return {
      _id: driver._id,
      firstName: driver.firstName,
      middleName: driver.middleName,
      lastName: driver.lastName,
      email: driver.email,
      phone: driver.phone,
      dateOfBirth: driver.dateOfBirth,
      licenseNumber: driver.licenseNumber,
      licenseState: driver.licenseState,
      licenseClass: driver.licenseClass,
      licenseExpiration: driver.licenseExpiration,
      employmentStatus: driver.employmentStatus,
      employmentType: driver.employmentType,
      hireDate: driver.hireDate,
      organizationId: driver.organizationId,
      currentTruckId: driver.currentTruckId,
      address: driver.address,
      city: driver.city,
      state: driver.state,
      zipCode: driver.zipCode,
      emergencyContactName: driver.emergencyContactName,
      emergencyContactPhone: driver.emergencyContactPhone,
      emergencyContactRelationship: driver.emergencyContactRelationship,
    };
  },
});

/**
 * Create owner-driver profile
 * Used during onboarding for owner-operators who don't have an existing driver profile
 * Creates driver record and links it to the carrier organization as ownerDriverId
 */
export const createOwnerDriver = mutation({
  args: {
    carrierOrgId: v.string(), // Convex document ID
    firstName: v.string(),
    middleName: v.optional(v.string()),
    lastName: v.string(),
    phone: v.string(),
    email: v.optional(v.string()),
    dateOfBirth: v.optional(v.string()),
    licenseNumber: v.string(),
    licenseState: v.string(),
    licenseClass: v.string(),
    licenseExpiration: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error('Not authenticated');

    const now = Date.now();

    // Verify the organization exists and is a carrier
    const org = await ctx.db.get(args.carrierOrgId as Id<'organizations'>);
    if (!org) {
      throw new Error('Organization not found');
    }

    if (org.orgType !== 'CARRIER' && org.orgType !== 'BROKER_CARRIER') {
      throw new Error('Organization is not a carrier');
    }

    // Check if organization is deleted
    if (org.isDeleted) {
      throw new Error(`Cannot create owner-driver for deactivated organization "${org.name}"`);
    }

    // Check if org already has an owner driver
    if (org.ownerDriverId) {
      const existingDriver = await ctx.db.get(org.ownerDriverId);
      if (existingDriver && !existingDriver.isDeleted) {
        throw new Error('Organization already has an owner-driver linked');
      }
    }

    // Check if driver with same phone already exists in this org
    const existingDrivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.carrierOrgId))
      .collect();

    const normalizedPhone = args.phone.replace(/\D/g, '');
    const existingDriver = existingDrivers.find((d) => {
      if (d.isDeleted) return false;
      const driverPhone = d.phone.replace(/\D/g, '');
      return driverPhone === normalizedPhone;
    });

    if (existingDriver) {
      // Link existing driver as owner-driver instead of creating new
      await ctx.db.patch(args.carrierOrgId as Id<'organizations'>, {
        ownerDriverId: existingDriver._id,
        isOwnerOperator: true,
        updatedAt: now,
      });

      return {
        success: true,
        driverId: existingDriver._id,
        message: 'Existing driver profile linked as owner-driver',
      };
    }

    // Create the driver
    const driverId = await ctx.db.insert('drivers', {
      organizationId: args.carrierOrgId,
      firstName: args.firstName,
      middleName: args.middleName || undefined,
      lastName: args.lastName,
      email: args.email || '',
      phone: args.phone,
      dateOfBirth: args.dateOfBirth || undefined,
      licenseNumber: args.licenseNumber,
      licenseState: args.licenseState,
      licenseClass: args.licenseClass,
      licenseExpiration: args.licenseExpiration || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      employmentStatus: 'Active',
      employmentType: 'Owner-Operator',
      hireDate: new Date().toISOString().split('T')[0],
      createdBy: 'mobile_onboarding',
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
    });

    // Link driver to organization as owner-driver
    await ctx.db.patch(args.carrierOrgId as Id<'organizations'>, {
      ownerDriverId: driverId,
      isOwnerOperator: true,
      updatedAt: now,
    });

    // Create Clerk user for mobile app authentication
    ctx.scheduler.runAfter(0, internal.clerkSync.createClerkUserForDriver, {
      phone: args.phone,
      firstName: args.firstName,
      lastName: args.lastName,
    });

    return {
      success: true,
      driverId,
      message: 'Owner-driver profile created successfully',
    };
  },
});

/**
 * Check if owner-operator needs to complete driver profile
 * Returns true if isOwnerOperator but no ownerDriverId is set
 */
export const needsDriverProfile = query({
  args: {
    carrierOrgId: v.string(),
  },
  handler: async (ctx, args) => {
    // Auth: verify caller is authenticated
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { needsProfile: false, reason: 'Not authenticated' };

    const org = await ctx.db.get(args.carrierOrgId as Id<'organizations'>);
    if (!org) {
      return { needsProfile: false, reason: 'Organization not found' };
    }

    // Check if this is an owner-operator without a driver profile
    if (org.isOwnerOperator && !org.ownerDriverId) {
      return { needsProfile: true, reason: 'Owner-operator without driver profile' };
    }

    // Check if ownerDriverId exists but driver is deleted
    if (org.ownerDriverId) {
      const driver = await ctx.db.get(org.ownerDriverId);
      if (!driver || driver.isDeleted) {
        return { needsProfile: true, reason: 'Owner-driver record missing or deleted' };
      }
    }

    return { needsProfile: false };
  },
});
