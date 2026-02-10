import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';

// ============================================
// SANDBOX DATA GENERATION
// Generates synthetic GPS/load data for the sandbox environment.
// Daily refresh via cron.
// ============================================

// Predefined routes for realistic test data
const DEMO_ROUTES = [
  {
    name: 'Los Angeles to Phoenix',
    stops: [
      { city: 'Los Angeles', state: 'CA', lat: 34.0522, lng: -118.2437, type: 'PICKUP' as const },
      { city: 'Phoenix', state: 'AZ', lat: 33.4484, lng: -112.0740, type: 'DELIVERY' as const },
    ],
    waypoints: [
      // Intermediate GPS points along I-10
      { lat: 34.0522, lng: -118.2437 },
      { lat: 34.0089, lng: -117.6818 },
      { lat: 33.9533, lng: -117.3961 },
      { lat: 33.9255, lng: -116.8862 },
      { lat: 33.7175, lng: -116.2146 },
      { lat: 33.7175, lng: -115.5133 },
      { lat: 33.5387, lng: -114.7825 },
      { lat: 33.3959, lng: -114.2561 },
      { lat: 33.4484, lng: -112.0740 },
    ],
  },
  {
    name: 'Dallas to Houston',
    stops: [
      { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.7970, type: 'PICKUP' as const },
      { city: 'Houston', state: 'TX', lat: 29.7604, lng: -95.3698, type: 'DELIVERY' as const },
    ],
    waypoints: [
      { lat: 32.7767, lng: -96.7970 },
      { lat: 32.2226, lng: -96.6363 },
      { lat: 31.7619, lng: -96.3700 },
      { lat: 31.0982, lng: -96.1113 },
      { lat: 30.6280, lng: -96.0834 },
      { lat: 30.2672, lng: -95.8587 },
      { lat: 29.7604, lng: -95.3698 },
    ],
  },
  {
    name: 'Chicago to Indianapolis',
    stops: [
      { city: 'Chicago', state: 'IL', lat: 41.8781, lng: -87.6298, type: 'PICKUP' as const },
      { city: 'Indianapolis', state: 'IN', lat: 39.7684, lng: -86.1581, type: 'DELIVERY' as const },
    ],
    waypoints: [
      { lat: 41.8781, lng: -87.6298 },
      { lat: 41.5250, lng: -87.3285 },
      { lat: 41.0534, lng: -87.1356 },
      { lat: 40.5519, lng: -86.8944 },
      { lat: 40.1934, lng: -86.5816 },
      { lat: 39.7684, lng: -86.1581 },
    ],
  },
];

/**
 * Generate sandbox data for a specific org.
 * Called from the UI or daily cron.
 */
export const generateSandboxData = internalAction({
  args: { workosOrgId: v.string() },
  returns: v.object({ loadsCreated: v.number(), positionsCreated: v.number() }),
  handler: async (ctx, args) => {
    // First, clean existing sandbox data for this org
    await ctx.runMutation(internal.sandboxData.clearSandboxData, {
      workosOrgId: args.workosOrgId,
    });

    let totalPositions = 0;

    for (let i = 0; i < DEMO_ROUTES.length; i++) {
      const route = DEMO_ROUTES[i];
      const now = Date.now();
      const baseTime = now - (i * 8 * 60 * 60 * 1000); // Stagger start times

      // Determine tracking status
      const trackingStatuses: Array<'In Transit' | 'Completed' | 'Pending'> = [
        'In Transit',
        'Completed',
        'Pending',
      ];
      const trackingStatus = trackingStatuses[i % 3];

      // Create the load
      const loadId = await ctx.runMutation(internal.sandboxData.createSandboxLoad, {
        workosOrgId: args.workosOrgId,
        internalId: `SBX-${String(i + 1).padStart(4, '0')}`,
        orderNumber: `DEMO-${String(i + 1).padStart(4, '0')}`,
        trackingStatus,
        route: {
          name: route.name,
          stops: route.stops.map((s, idx) => ({
            sequenceNumber: idx + 1,
            stopType: s.type,
            city: s.city,
            state: s.state,
            latitude: s.lat,
            longitude: s.lng,
            status: trackingStatus === 'Completed' ? 'Completed' as const :
                   (idx === 0 && trackingStatus === 'In Transit') ? 'Completed' as const :
                   'Pending' as const,
            scheduledWindowBegin: new Date(baseTime + idx * 6 * 60 * 60 * 1000).toISOString(),
            scheduledWindowEnd: new Date(baseTime + idx * 6 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000).toISOString(),
            checkedInAt: trackingStatus !== 'Pending'
              ? new Date(baseTime + idx * 6 * 60 * 60 * 1000).toISOString()
              : undefined,
            checkedOutAt: trackingStatus === 'Completed' || (idx === 0 && trackingStatus === 'In Transit')
              ? new Date(baseTime + idx * 6 * 60 * 60 * 1000 + 30 * 60 * 1000).toISOString()
              : undefined,
          })),
        },
      });

      // Generate GPS positions along the route
      if (trackingStatus !== 'Pending') {
        const posCount = await ctx.runMutation(internal.sandboxData.generateSandboxPositions, {
          sandboxLoadId: loadId,
          workosOrgId: args.workosOrgId,
          waypoints: route.waypoints,
          startTime: baseTime,
          trackingStatus,
        });
        totalPositions += posCount;
      }
    }

    return { loadsCreated: DEMO_ROUTES.length, positionsCreated: totalPositions };
  },
});

export const clearSandboxData = internalMutation({
  args: { workosOrgId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    // Delete positions
    const positions = await ctx.db
      .query('sandboxPositions')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    for (const p of positions) {
      await ctx.db.delete(p._id);
    }

    // Delete loads
    const loads = await ctx.db
      .query('sandboxLoads')
      .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
    for (const l of loads) {
      await ctx.db.delete(l._id);
    }

    return null;
  },
});

export const createSandboxLoad = internalMutation({
  args: {
    workosOrgId: v.string(),
    internalId: v.string(),
    orderNumber: v.string(),
    trackingStatus: v.union(v.literal('Pending'), v.literal('In Transit'), v.literal('Completed')),
    route: v.object({
      name: v.string(),
      stops: v.array(v.object({
        sequenceNumber: v.number(),
        stopType: v.union(v.literal('PICKUP'), v.literal('DELIVERY')),
        city: v.string(),
        state: v.string(),
        latitude: v.number(),
        longitude: v.number(),
        status: v.union(v.literal('Pending'), v.literal('Completed')),
        scheduledWindowBegin: v.string(),
        scheduledWindowEnd: v.string(),
        checkedInAt: v.optional(v.string()),
        checkedOutAt: v.optional(v.string()),
      })),
    }),
  },
  returns: v.id('sandboxLoads'),
  handler: async (ctx, args) => {
    return await ctx.db.insert('sandboxLoads', {
      workosOrgId: args.workosOrgId,
      internalId: args.internalId,
      orderNumber: args.orderNumber,
      trackingStatus: args.trackingStatus,
      stopCount: args.route.stops.length,
      firstStopDate: args.route.stops[0]?.scheduledWindowBegin,
      stops: args.route.stops,
      createdAt: Date.now(),
    });
  },
});

export const generateSandboxPositions = internalMutation({
  args: {
    sandboxLoadId: v.id('sandboxLoads'),
    workosOrgId: v.string(),
    waypoints: v.array(v.object({ lat: v.number(), lng: v.number() })),
    startTime: v.number(),
    trackingStatus: v.union(v.literal('In Transit'), v.literal('Completed')),
  },
  returns: v.number(), // count of positions created
  handler: async (ctx, args) => {
    const { waypoints, startTime, trackingStatus } = args;
    let count = 0;

    // Interpolate points between waypoints at 1-minute intervals
    const totalDurationMs = trackingStatus === 'Completed'
      ? waypoints.length * 60 * 60 * 1000 // Hours based on waypoints
      : Date.now() - startTime; // Up to now for in-transit

    const intervalMs = 60_000; // 1 minute (matches mobile capture)
    const totalPoints = Math.min(
      Math.floor(totalDurationMs / intervalMs),
      720 // Cap at 12 hours of data
    );

    for (let i = 0; i < totalPoints; i++) {
      // Determine which segment we're on
      const progress = i / totalPoints;
      const segmentIndex = Math.min(
        Math.floor(progress * (waypoints.length - 1)),
        waypoints.length - 2
      );
      const segmentProgress =
        (progress * (waypoints.length - 1)) - segmentIndex;

      const from = waypoints[segmentIndex];
      const to = waypoints[segmentIndex + 1];

      // Linear interpolation with small random offset for realism
      const jitter = () => (Math.random() - 0.5) * 0.001; // ~100m jitter
      const lat = from.lat + (to.lat - from.lat) * segmentProgress + jitter();
      const lng = from.lng + (to.lng - from.lng) * segmentProgress + jitter();

      await ctx.db.insert('sandboxPositions', {
        sandboxLoadId: args.sandboxLoadId,
        workosOrgId: args.workosOrgId,
        latitude: lat,
        longitude: lng,
        speed: 45 + Math.random() * 25, // 45-70 mph
        heading: Math.atan2(to.lng - from.lng, to.lat - from.lat) * (180 / Math.PI),
        accuracy: 5 + Math.random() * 10,
        recordedAt: startTime + i * intervalMs,
      });
      count++;
    }

    return count;
  },
});

/**
 * Daily sandbox refresh cron entry point.
 * Refreshes sandbox data for all orgs that have sandbox API keys.
 */
export const refreshAllSandboxData = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    // Get all orgs with active sandbox keys
    const orgs: string[] = await ctx.runQuery(internal.sandboxData.getOrgsWithSandboxKeys, {});

    for (const orgId of orgs) {
      await ctx.runAction(internal.sandboxData.generateSandboxData, {
        workosOrgId: orgId,
      });
    }

    return null;
  },
});

export const getOrgsWithSandboxKeys = internalQuery({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx) => {
    const keys = await ctx.db
      .query('partnerApiKeys')
      .collect();

    const orgIds = new Set<string>();
    for (const key of keys) {
      if (key.environment === 'sandbox' && key.status === 'ACTIVE') {
        orgIds.add(key.workosOrgId);
      }
    }
    return Array.from(orgIds);
  },
});
