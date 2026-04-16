import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { scheduleRuleValidator } from './lib/validators';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';
import {
  calculateScheduleForYear,
  hosAnalyzeRoute,
  buildStopDwell,
  parseSchedulePattern,
  buildDriverShifts,
  buildShiftsForDay,
  buildAdjacencyGraph,
  haversineDistance,
} from './laneAnalyzerCalculations';

// ==========================================
// LANE ANALYZER — CRUD & Queries
// Sessions, Entries, and Bases management
// ==========================================

// ---- SESSION QUERIES ----

export const listSessions = query({
  args: {
    workosOrgId: v.string(),
    status: v.optional(
      v.union(v.literal('DRAFT'), v.literal('ACTIVE'), v.literal('ARCHIVED')),
    ),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    if (args.status) {
      return ctx.db
        .query('laneAnalysisSessions')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', args.status!),
        )
        .filter((q) => q.eq(q.field('isDeleted'), false))
        .collect();
    }
    return ctx.db
      .query('laneAnalysisSessions')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .filter((q) => q.eq(q.field('isDeleted'), false))
      .collect();
  },
});

export const getSession = query({
  args: { id: v.id('laneAnalysisSessions') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const session = await ctx.db.get(args.id);
    if (!session || session.isDeleted) return null;
    return session;
  },
});

// ---- SESSION MUTATIONS ----

export const createSession = mutation({
  args: {
    workosOrgId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    analysisType: v.union(v.literal('BID'), v.literal('OPTIMIZATION')),
    defaultMpgHighway: v.optional(v.number()),
    defaultMpgCity: v.optional(v.number()),
    defaultFuelPricePerGallon: v.optional(v.number()),
    defaultDriverPayType: v.union(
      v.literal('PER_MILE'),
      v.literal('PER_HOUR'),
      v.literal('FLAT_PER_RUN'),
    ),
    defaultDriverPayRate: v.number(),
    driverSchedulePattern: v.union(
      v.literal('5on2off'),
      v.literal('6on1off'),
      v.literal('7on'),
      v.literal('custom'),
    ),
    customScheduleOnDays: v.optional(v.number()),
    customScheduleOffDays: v.optional(v.number()),
    analysisYear: v.number(),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    return ctx.db.insert('laneAnalysisSessions', {
      workosOrgId: args.workosOrgId,
      name: args.name,
      description: args.description,
      status: 'DRAFT',
      analysisType: args.analysisType,
      defaultMpgHighway: args.defaultMpgHighway ?? 6.0,
      defaultMpgCity: args.defaultMpgCity ?? 10.0,
      defaultFuelPricePerGallon: args.defaultFuelPricePerGallon,
      defaultDriverPayType: args.defaultDriverPayType,
      defaultDriverPayRate: args.defaultDriverPayRate,
      driverSchedulePattern: args.driverSchedulePattern,
      customScheduleOnDays: args.customScheduleOnDays,
      customScheduleOffDays: args.customScheduleOffDays,
      analysisYear: args.analysisYear,
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
    });
  },
});

export const updateSession = mutation({
  args: {
    id: v.id('laneAnalysisSessions'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal('DRAFT'), v.literal('ACTIVE'), v.literal('ARCHIVED')),
    ),
    defaultMpgHighway: v.optional(v.number()),
    defaultMpgCity: v.optional(v.number()),
    defaultFuelPricePerGallon: v.optional(v.number()),
    defaultDriverPayType: v.optional(
      v.union(v.literal('PER_MILE'), v.literal('PER_HOUR'), v.literal('FLAT_PER_RUN')),
    ),
    defaultDriverPayRate: v.optional(v.number()),
    driverSchedulePattern: v.optional(
      v.union(
        v.literal('5on2off'),
        v.literal('6on1off'),
        v.literal('7on'),
        v.literal('custom'),
      ),
    ),
    customScheduleOnDays: v.optional(v.number()),
    customScheduleOffDays: v.optional(v.number()),
    analysisYear: v.optional(v.number()),
    // Operational settings
    prePostTripMinutes: v.optional(v.number()),
    dwellTimeApptMinutes: v.optional(v.number()),
    dwellTimeLiveMinutes: v.optional(v.number()),
    dwellTimeFcfsMinutes: v.optional(v.number()),
    useApptWindowsForDwell: v.optional(v.boolean()),
    maxChainingLegs: v.optional(v.number()),
    maxDeadheadMiles: v.optional(v.number()),
    maxWaitHours: v.optional(v.number()),
    targetDriverCount: v.optional(v.number()),
    weeklyHosMode: v.optional(v.union(v.literal('uniform'), v.literal('flexible'))),
    allowSameLaneRepeat: v.optional(v.boolean()),
    solverVersion: v.optional(v.union(v.literal('v4'), v.literal('v5_hybrid'))),
  },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const { id, ...updates } = args;
    const session = await ctx.db.get(id);
    if (!session || session.isDeleted) throw new Error('Session not found');

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(id, patch);
  },
});

export const archiveSession = mutation({
  args: {
    id: v.id('laneAnalysisSessions'),
    deletedBy: v.string(),
  },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const session = await ctx.db.get(args.id);
    if (!session || session.isDeleted) throw new Error('Session not found');
    await ctx.db.patch(args.id, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: args.deletedBy,
      updatedAt: Date.now(),
    });
  },
});

// ---- ENTRY QUERIES ----

export const listEntries = query({
  args: { sessionId: v.id('laneAnalysisSessions') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    return ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
  },
});

export const getEntry = query({
  args: { id: v.id('laneAnalysisEntries') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    return ctx.db.get(args.id);
  },
});

// ---- ENTRY MUTATIONS ----

const entryStopValidator = v.object({
  address: v.string(),
  city: v.string(),
  state: v.string(),
  zip: v.string(),
  lat: v.optional(v.number()),
  lng: v.optional(v.number()),
  stopOrder: v.number(),
  stopType: v.union(v.literal('Pickup'), v.literal('Delivery')),
  type: v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live')),
  arrivalTime: v.optional(v.string()), // HH:MM format (window start)
  arrivalEndTime: v.optional(v.string()), // HH:MM format (window end)
});

export const createEntry = mutation({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    workosOrgId: v.string(),
    contractLaneId: v.optional(v.id('contractLanes')),
    name: v.string(),

    originAddress: v.string(),
    originCity: v.string(),
    originState: v.string(),
    originZip: v.string(),
    originLat: v.optional(v.number()),
    originLng: v.optional(v.number()),
    originStopType: v.optional(v.union(v.literal('Pickup'), v.literal('Delivery'))),
    originAppointmentType: v.optional(v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live'))),
    originScheduledTime: v.optional(v.string()),
    originScheduledEndTime: v.optional(v.string()),

    destinationAddress: v.string(),
    destinationCity: v.string(),
    destinationState: v.string(),
    destinationZip: v.string(),
    destinationLat: v.optional(v.number()),
    destinationLng: v.optional(v.number()),
    destinationStopType: v.optional(v.union(v.literal('Pickup'), v.literal('Delivery'))),
    destinationAppointmentType: v.optional(v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live'))),
    destinationScheduledTime: v.optional(v.string()),
    destinationScheduledEndTime: v.optional(v.string()),

    intermediateStops: v.optional(v.array(entryStopValidator)),

    routeMiles: v.optional(v.number()),
    routeDurationHours: v.optional(v.number()),
    isRoundTrip: v.boolean(),
    isCityRoute: v.boolean(),

    scheduleRule: scheduleRuleValidator,

    contractPeriodStart: v.optional(v.string()),
    contractPeriodEnd: v.optional(v.string()),

    ratePerRun: v.optional(v.number()),
    rateType: v.optional(
      v.union(v.literal('Per Mile'), v.literal('Flat Rate'), v.literal('Per Stop')),
    ),
    ratePerMile: v.optional(v.number()),
    minimumRate: v.optional(v.number()),

    fuelSurchargeType: v.optional(
      v.union(v.literal('PERCENTAGE'), v.literal('FLAT'), v.literal('DOE_INDEX')),
    ),
    fuelSurchargeValue: v.optional(v.number()),

    stopOffRate: v.optional(v.number()),
    includedStops: v.optional(v.number()),

    equipmentClass: v.optional(
      v.union(
        v.literal('Bobtail'),
        v.literal('Dry Van'),
        v.literal('Refrigerated'),
        v.literal('Flatbed'),
        v.literal('Tanker'),
      ),
    ),
    equipmentSize: v.optional(v.union(v.literal('53ft'), v.literal('48ft'), v.literal('45ft'))),

    requiresTeamDrivers: v.optional(v.boolean()),
    mpgOverride: v.optional(v.number()),
    driverPayTypeOverride: v.optional(
      v.union(v.literal('PER_MILE'), v.literal('PER_HOUR'), v.literal('FLAT_PER_RUN')),
    ),
    driverPayRateOverride: v.optional(v.number()),
    baseId: v.optional(v.id('laneAnalysisBases')),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    return ctx.db.insert('laneAnalysisEntries', {
      ...args,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateEntry = mutation({
  args: {
    id: v.id('laneAnalysisEntries'),
    name: v.optional(v.string()),
    originAddress: v.optional(v.string()),
    originCity: v.optional(v.string()),
    originState: v.optional(v.string()),
    originZip: v.optional(v.string()),
    originLat: v.optional(v.number()),
    originLng: v.optional(v.number()),
    originStopType: v.optional(v.union(v.literal('Pickup'), v.literal('Delivery'))),
    originAppointmentType: v.optional(v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live'))),
    originScheduledTime: v.optional(v.string()),
    originScheduledEndTime: v.optional(v.string()),
    destinationAddress: v.optional(v.string()),
    destinationCity: v.optional(v.string()),
    destinationState: v.optional(v.string()),
    destinationZip: v.optional(v.string()),
    destinationLat: v.optional(v.number()),
    destinationLng: v.optional(v.number()),
    destinationStopType: v.optional(v.union(v.literal('Pickup'), v.literal('Delivery'))),
    destinationAppointmentType: v.optional(v.union(v.literal('APPT'), v.literal('FCFS'), v.literal('Live'))),
    destinationScheduledTime: v.optional(v.string()),
    destinationScheduledEndTime: v.optional(v.string()),
    intermediateStops: v.optional(v.array(entryStopValidator)),
    routeMiles: v.optional(v.number()),
    routeDurationHours: v.optional(v.number()),
    isRoundTrip: v.optional(v.boolean()),
    isCityRoute: v.optional(v.boolean()),
    scheduleRule: v.optional(scheduleRuleValidator),
    contractPeriodStart: v.optional(v.string()),
    contractPeriodEnd: v.optional(v.string()),
    ratePerRun: v.optional(v.number()),
    rateType: v.optional(
      v.union(v.literal('Per Mile'), v.literal('Flat Rate'), v.literal('Per Stop')),
    ),
    ratePerMile: v.optional(v.number()),
    minimumRate: v.optional(v.number()),
    fuelSurchargeType: v.optional(
      v.union(v.literal('PERCENTAGE'), v.literal('FLAT'), v.literal('DOE_INDEX')),
    ),
    fuelSurchargeValue: v.optional(v.number()),
    stopOffRate: v.optional(v.number()),
    includedStops: v.optional(v.number()),
    equipmentClass: v.optional(
      v.union(
        v.literal('Bobtail'),
        v.literal('Dry Van'),
        v.literal('Refrigerated'),
        v.literal('Flatbed'),
        v.literal('Tanker'),
      ),
    ),
    equipmentSize: v.optional(v.union(v.literal('53ft'), v.literal('48ft'), v.literal('45ft'))),
    requiresTeamDrivers: v.optional(v.boolean()),
    mpgOverride: v.optional(v.number()),
    driverPayTypeOverride: v.optional(
      v.union(v.literal('PER_MILE'), v.literal('PER_HOUR'), v.literal('FLAT_PER_RUN')),
    ),
    driverPayRateOverride: v.optional(v.number()),
    baseId: v.optional(v.id('laneAnalysisBases')),
  },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const { id, ...updates } = args;
    const entry = await ctx.db.get(id);
    if (!entry) throw new Error('Entry not found');

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(id, patch);
  },
});

export const deleteEntry = mutation({
  args: { id: v.id('laneAnalysisEntries') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    await ctx.db.delete(args.id);
  },
});

// ---- BASE QUERIES ----

export const listBases = query({
  args: {
    workosOrgId: v.string(),
    sessionId: v.optional(v.id('laneAnalysisSessions')),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    if (args.sessionId) {
      // Get session-specific bases + org-wide bases
      const sessionBases = await ctx.db
        .query('laneAnalysisBases')
        .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId!))
        .collect();
      const orgBases = await ctx.db
        .query('laneAnalysisBases')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
        .filter((q) => q.eq(q.field('sessionId'), undefined))
        .collect();
      return [...orgBases, ...sessionBases];
    }
    return ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', args.workosOrgId))
      .collect();
  },
});

export const getBase = query({
  args: { id: v.id('laneAnalysisBases') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    return ctx.db.get(args.id);
  },
});

// ---- BASE MUTATIONS ----

export const createBase = mutation({
  args: {
    workosOrgId: v.string(),
    sessionId: v.optional(v.id('laneAnalysisSessions')),
    name: v.string(),
    address: v.string(),
    city: v.string(),
    state: v.string(),
    zip: v.string(),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    baseType: v.union(v.literal('YARD'), v.literal('RELAY_POINT'), v.literal('PARKING')),
    capacity: v.optional(v.number()),
    monthlyParkingCost: v.optional(v.number()),
    createdBy: v.string(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const now = Date.now();
    return ctx.db.insert('laneAnalysisBases', {
      ...args,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateBase = mutation({
  args: {
    id: v.id('laneAnalysisBases'),
    name: v.optional(v.string()),
    address: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    zip: v.optional(v.string()),
    latitude: v.optional(v.number()),
    longitude: v.optional(v.number()),
    baseType: v.optional(
      v.union(v.literal('YARD'), v.literal('RELAY_POINT'), v.literal('PARKING')),
    ),
    capacity: v.optional(v.number()),
    monthlyParkingCost: v.optional(v.number()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const { id, ...updates } = args;
    const base = await ctx.db.get(id);
    if (!base) throw new Error('Base not found');

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) patch[key] = value;
    }
    await ctx.db.patch(id, patch);
  },
});

export const deleteBase = mutation({
  args: { id: v.id('laneAnalysisBases') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    await ctx.db.delete(args.id);
  },
});

// ---- RESULTS QUERIES ----

export const getResults = query({
  args: { sessionId: v.id('laneAnalysisSessions') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    return ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
  },
});

/**
 * Compute shift chains for a specific date on-demand.
 * This runs the shift builder for just one day so we can display
 * any date's shift assignments, not just the peak day.
 */
export const getShiftsForDate = query({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    date: v.string(), // YYYY-MM-DD
  },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.isDeleted) return { shifts: [], lanesRunning: 0 };

    const entries = await ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    // Find which lanes run on this date
    const lanesOnDate: typeof entries = [];
    for (const entry of entries) {
      const dates = calculateScheduleForYear(
        entry.scheduleRule,
        session.analysisYear,
        entry.contractPeriodStart,
        entry.contractPeriodEnd,
      );
      if (dates.includes(args.date)) {
        lanesOnDate.push(entry);
      }
    }

    if (lanesOnDate.length === 0) return { shifts: [], lanesRunning: 0 };

    // Build shift input
    const stopDwellOverrides = buildStopDwell({
      dwellTimeApptMinutes: session.dwellTimeApptMinutes,
      dwellTimeLiveMinutes: session.dwellTimeLiveMinutes,
      dwellTimeFcfsMinutes: session.dwellTimeFcfsMinutes,
    });
    const prePostHours = session.prePostTripMinutes != null ? session.prePostTripMinutes / 60 : 1.0;

    const shiftEntries = lanesOnDate.map((entry) => {
      const numStops = 2 + (entry.intermediateStops?.length ?? 0);
      const originAppt = entry.originAppointmentType ?? 'APPT';
      const destAppt = entry.destinationAppointmentType ?? 'APPT';
      const allStopTypes = [originAppt, ...(entry.intermediateStops?.map((s) => s.type) ?? []), destAppt];
      const apptWindows = [
        { start: entry.originScheduledTime, end: entry.originScheduledEndTime },
        ...(entry.intermediateStops?.map((s) => ({ start: s.arrivalTime, end: s.arrivalEndTime })) ?? []),
        { start: entry.destinationScheduledTime, end: entry.destinationScheduledEndTime },
      ];
      const hos = hosAnalyzeRoute(
        entry.routeDurationHours ?? 0,
        numStops,
        allStopTypes,
        { stopDwellOverrides, prePostTripHours: prePostHours, apptWindows, useApptWindowsForDwell: session.useApptWindowsForDwell ?? false },
      );

      return {
        id: entry._id as string,
        originCity: entry.originCity,
        originState: entry.originState,
        originLat: entry.originLat,
        originLng: entry.originLng,
        destCity: entry.destinationCity,
        destState: entry.destinationState,
        destLat: entry.destinationLat,
        destLng: entry.destinationLng,
        routeDurationHours: entry.routeDurationHours ?? 0,
        routeMiles: entry.routeMiles ?? 0,
        scheduleDates: [args.date],
        hosAnalysis: hos,
        originApptType: entry.originAppointmentType,
        destApptType: entry.destinationAppointmentType,
        originScheduledTime: entry.originScheduledTime,
        destScheduledTime: entry.destinationScheduledTime,
        originScheduledEndTime: entry.originScheduledEndTime,
        destScheduledEndTime: entry.destinationScheduledEndTime,
      };
    });

    // Fetch bases for return-to-base checks
    const baseDocs = await ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
    const bases = baseDocs.map((b) => ({
      id: b._id as string,
      name: b.name,
      lat: b.latitude ?? 0,
      lng: b.longitude ?? 0,
      city: b.city ?? '',
      state: b.state ?? '',
    }));

    // Build shifts using the same engine
    const schedParsed = parseSchedulePattern(session.driverSchedulePattern, session.customScheduleOnDays, session.customScheduleOffDays);
    const result = buildDriverShifts(shiftEntries, session.maxDeadheadMiles ?? 75, session.maxChainingLegs ?? 8, prePostHours, session.maxWaitHours ?? 3.0, schedParsed.onDays, bases, session.weeklyHosMode ?? 'flexible');
    const dayShifts = result.dailyShifts.get(args.date) ?? [];

    // Map entry IDs to names for display
    const nameMap = new Map(lanesOnDate.map((e) => [e._id as string, e.name]));

    return {
      shifts: dayShifts.map((s) => ({
        legs: s.legs.map((id) => nameMap.get(id) ?? id),
        legIds: s.legs,
        legCount: s.legs.length,
        driveHours: Math.round(s.totalDriveHours * 10) / 10,
        dutyHours: Math.round(s.totalDutyHours * 10) / 10,
        miles: Math.round(s.totalMiles),
        deadheadMiles: Math.round(s.totalDeadheadMiles),
      })),
      lanesRunning: lanesOnDate.length,
    };
  },
});

/**
 * Compute shift chains for an entire week (7 days starting from weekStartDate).
 * Returns per-day shift assignments so the UI can show a weekly view.
 */
export const getShiftsForWeek = query({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    weekStartDate: v.string(), // YYYY-MM-DD (Monday)
  },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.isDeleted) return { days: [] };

    const entries = await ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    if (entries.length === 0) return { days: [] };

    // ---- Check for solver results ----
    const aggregateResult = await ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .filter((q) => q.eq(q.field('resultType'), 'AGGREGATE'))
      .first();

    let solverData: {
      weeklySchedule?: Array<{
        driverId: number;
        days: Record<string, {
          legs: string[];
          driveHours: number; dutyHours: number;
          miles: number; deadheadMiles: number;
          startTime: number | null; endTime: number | null;
        }>;
      }>;
      // Legacy peak-day shifts (for old sessions before weekly schedule storage)
      shifts?: Array<{
        legs: string[]; legNames: string[]; legCount: number;
        driveHours: number; dutyHours: number; miles: number; deadheadMiles: number;
        fuelCost: number; driverPay: number; totalCost: number;
      }>;
      status?: string;
    } | null = null;

    if (aggregateResult?.hosAnalysis) {
      try {
        const parsed = JSON.parse(aggregateResult.hosAnalysis);
        if (parsed?.solver) {
          solverData = parsed.solver;
        }
      } catch {}
    }

    // Build entry name map, entry lookup, and schedule dates
    const nameMap = new Map(entries.map((e) => [e._id as string, e.name]));
    const entryMap = new Map(entries.map((e) => [e._id as string, e]));
    const entrySchedules = new Map<string, Set<string>>();
    for (const entry of entries) {
      const dates = calculateScheduleForYear(
        entry.scheduleRule, session.analysisYear,
        entry.contractPeriodStart, entry.contractPeriodEnd,
      );
      entrySchedules.set(entry._id as string, new Set(dates));
    }

    // ---- Tier 1: Full weekly schedule from Python solver ----
    if (solverData?.weeklySchedule && solverData.weeklySchedule.length > 0) {
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const days: Array<{
        date: string;
        dayName: string;
        lanesRunning: number;
        shifts: Array<{
          legs: string[];
          legIds: string[];
          legCount: number;
          driveHours: number;
          dutyHours: number;
          miles: number;
          deadheadMiles: number;
          isExact?: boolean;
          legGaps?: Array<{ miles: number; driveHours: number; waitHours: number | null; prevEndTime: number | null; nextStartTime: number | null; earliestArrival: number | null }>;
        }>;
      }> = [];

      const startDate = new Date(args.weekStartDate + 'T00:00:00');

      for (let d = 0; d < 7; d++) {
        const current = new Date(startDate);
        current.setDate(startDate.getDate() + d);
        const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
        const dayName = dayNames[d];

        // Which entries are scheduled to run on this date?
        const todayEntryIds = new Set<string>();
        for (const [entryId, dates] of entrySchedules) {
          if (dates.has(dateStr)) todayEntryIds.add(entryId);
        }

        if (todayEntryIds.size === 0) {
          days.push({ date: dateStr, dayName, lanesRunning: 0, shifts: [] });
          continue;
        }

        // Read exact solver assignments for this day name
        const dayShifts: typeof days[0]['shifts'] = [];

        for (const driver of solverData.weeklySchedule) {
          const solverDay = driver.days[dayName];
          if (!solverDay || !solverDay.legs || solverDay.legs.length === 0) continue;

          // Filter to legs that are actually scheduled today (respects holiday/exclusion rules)
          const retainedLegs = solverDay.legs.filter((lid) => todayEntryIds.has(lid));
          if (retainedLegs.length === 0) continue;

          // If all legs retained, use solver's exact metrics
          if (retainedLegs.length === solverDay.legs.length) {
            dayShifts.push({
              legs: retainedLegs.map((lid) => nameMap.get(lid) ?? lid),
              legIds: retainedLegs,
              legCount: retainedLegs.length,
              driveHours: solverDay.driveHours,
              dutyHours: solverDay.dutyHours,
              miles: solverDay.miles,
              deadheadMiles: solverDay.deadheadMiles,
              isExact: (solverDay as any).isExact ?? false,
              legGaps: (solverDay as any).legGaps ?? [],
            });
          } else {
            // Some legs excluded — rebuild metrics from retained leg sequence
            // Deadhead/wait are edge-dependent, so we must re-walk the sequence
            const prePostHours = session.prePostTripMinutes != null ? session.prePostTripMinutes / 60 : 1.0;
            let driveHours = 0;
            let dutyHours = prePostHours;
            let miles = 0;
            let deadheadMiles = 0;

            for (let i = 0; i < retainedLegs.length; i++) {
              const entry = entryMap.get(retainedLegs[i]);
              if (!entry) continue;

              const routeDuration = entry.routeDurationHours ?? 0;
              const routeMiles = entry.routeMiles ?? 0;
              const dwellHours = (entry.originAppointmentType === 'FCFS' ? 1.5 : entry.originAppointmentType === 'Live' ? 1.0 : 0.5) / 2
                + (entry.destinationAppointmentType === 'FCFS' ? 1.5 : entry.destinationAppointmentType === 'Live' ? 1.0 : 0.5) / 2;

              driveHours += routeDuration;
              dutyHours += routeDuration + dwellHours;
              miles += routeMiles;

              // Deadhead between consecutive retained legs
              if (i > 0) {
                const prevEntry = entryMap.get(retainedLegs[i - 1]);
                if (prevEntry && prevEntry.destinationLat && prevEntry.destinationLng && entry.originLat && entry.originLng) {
                  const dhMiles = haversineDistance(prevEntry.destinationLat, prevEntry.destinationLng, entry.originLat, entry.originLng);
                  const dhHours = dhMiles / 55;
                  deadheadMiles += dhMiles;
                  driveHours += dhHours;
                  dutyHours += dhHours;
                  miles += dhMiles;
                }
              }
            }

            dayShifts.push({
              legs: retainedLegs.map((lid) => nameMap.get(lid) ?? lid),
              legIds: retainedLegs,
              legCount: retainedLegs.length,
              driveHours: Math.round(driveHours * 10) / 10,
              dutyHours: Math.round(dutyHours * 10) / 10,
              miles: Math.round(miles),
              deadheadMiles: Math.round(deadheadMiles),
              isExact: false, // rebuilt from partial legs — not exact
              legGaps: [],
            });
          }
        }

        days.push({
          date: dateStr,
          dayName,
          lanesRunning: todayEntryIds.size,
          shifts: dayShifts,
        });
      }

      return { days };
    }

    // ---- Tier 2: Legacy peak-day shifts (old sessions before weekly schedule storage) ----
    if (solverData?.shifts && solverData.shifts.length > 0) {
      const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const days: Array<{
        date: string; dayName: string; lanesRunning: number;
        shifts: Array<{ legs: string[]; legIds: string[]; legCount: number; driveHours: number; dutyHours: number; miles: number; deadheadMiles: number }>;
      }> = [];

      const startDate = new Date(args.weekStartDate + 'T00:00:00');

      for (let d = 0; d < 7; d++) {
        const current = new Date(startDate);
        current.setDate(startDate.getDate() + d);
        const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;

        const todayEntryIds = new Set<string>();
        for (const [entryId, dates] of entrySchedules) {
          if (dates.has(dateStr)) todayEntryIds.add(entryId);
        }

        if (todayEntryIds.size === 0) {
          days.push({ date: dateStr, dayName: dayNames[d], lanesRunning: 0, shifts: [] });
          continue;
        }

        // Filter legacy peak-day shifts to legs running today (proportional scaling — legacy behavior)
        const dayShifts = solverData.shifts
          .map((shift) => {
            const todayLegs = shift.legs.filter((lid) => todayEntryIds.has(lid));
            if (todayLegs.length === 0) return null;
            const ratio = todayLegs.length / shift.legCount;
            return {
              legs: todayLegs.map((lid) => nameMap.get(lid) ?? lid),
              legIds: todayLegs,
              legCount: todayLegs.length,
              driveHours: Math.round(shift.driveHours * ratio * 10) / 10,
              dutyHours: Math.round(shift.dutyHours * ratio * 10) / 10,
              miles: Math.round(shift.miles * ratio),
              deadheadMiles: Math.round(shift.deadheadMiles * ratio),
            };
          })
          .filter((s): s is NonNullable<typeof s> => s !== null);

        days.push({ date: dateStr, dayName: dayNames[d], lanesRunning: todayEntryIds.size, shifts: dayShifts });
      }

      return { days };
    }

    // ---- Tier 3: JS engine fallback (no solver results) ----
    const stopDwellOverrides = buildStopDwell({
      dwellTimeApptMinutes: session.dwellTimeApptMinutes,
      dwellTimeLiveMinutes: session.dwellTimeLiveMinutes,
      dwellTimeFcfsMinutes: session.dwellTimeFcfsMinutes,
    });
    const prePostHours = session.prePostTripMinutes != null ? session.prePostTripMinutes / 60 : 1.0;
    const schedParsed = parseSchedulePattern(session.driverSchedulePattern, session.customScheduleOnDays, session.customScheduleOffDays);
    // nameMap already computed above

    // Fetch bases for return-to-base checks
    const baseDocs = await ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
    const bases = baseDocs.map((b) => ({
      id: b._id as string,
      name: b.name,
      lat: b.latitude ?? 0,
      lng: b.longitude ?? 0,
      city: b.city ?? '',
      state: b.state ?? '',
    }));

    // entrySchedules already computed above (before solver check)

    // Build shift entries once (with all dates, the engine filters per day)
    const allShiftEntries = entries.map((entry) => {
      const numStops = 2 + (entry.intermediateStops?.length ?? 0);
      const originAppt = entry.originAppointmentType ?? 'APPT';
      const destAppt = entry.destinationAppointmentType ?? 'APPT';
      const allStopTypes = [originAppt, ...(entry.intermediateStops?.map((s) => s.type) ?? []), destAppt];
      const apptWindows = [
        { start: entry.originScheduledTime, end: entry.originScheduledEndTime },
        ...(entry.intermediateStops?.map((s) => ({ start: s.arrivalTime, end: s.arrivalEndTime })) ?? []),
        { start: entry.destinationScheduledTime, end: entry.destinationScheduledEndTime },
      ];
      const hos = hosAnalyzeRoute(entry.routeDurationHours ?? 0, numStops, allStopTypes, {
        stopDwellOverrides, prePostTripHours: prePostHours, apptWindows,
        useApptWindowsForDwell: session.useApptWindowsForDwell ?? false,
      });

      return {
        id: entry._id as string,
        originCity: entry.originCity, originState: entry.originState,
        originLat: entry.originLat, originLng: entry.originLng,
        destCity: entry.destinationCity, destState: entry.destinationState,
        destLat: entry.destinationLat, destLng: entry.destinationLng,
        routeDurationHours: entry.routeDurationHours ?? 0,
        routeMiles: entry.routeMiles ?? 0,
        scheduleDates: [] as string[], // filled per-day below
        hosAnalysis: hos,
        originApptType: entry.originAppointmentType,
        destApptType: entry.destinationAppointmentType,
        originScheduledTime: entry.originScheduledTime,
        destScheduledTime: entry.destinationScheduledTime,
        originScheduledEndTime: entry.originScheduledEndTime,
        destScheduledEndTime: entry.destinationScheduledEndTime,
      };
    });

    // Build adjacency graph ONCE for all entries (expensive part)
    const graph = buildAdjacencyGraph(allShiftEntries, session.maxDeadheadMiles ?? 75);
    const maxLegs = session.maxChainingLegs ?? 8;
    const maxWait = session.maxWaitHours ?? 3.0;

    // Generate 7 days
    const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const days: Array<{
      date: string;
      dayName: string;
      lanesRunning: number;
      shifts: Array<{
        legs: string[];
        legIds: string[];
        legCount: number;
        driveHours: number;
        dutyHours: number;
        miles: number;
        deadheadMiles: number;
      }>;
    }> = [];

    const startDate = new Date(args.weekStartDate + 'T00:00:00');

    for (let d = 0; d < 7; d++) {
      const current = new Date(startDate);
      current.setDate(startDate.getDate() + d);
      const dateStr = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;

      // Filter entries running on this date
      const entriesForDay = allShiftEntries.filter((e) => entrySchedules.get(e.id)?.has(dateStr));

      if (entriesForDay.length === 0) {
        days.push({ date: dateStr, dayName: dayNames[d], lanesRunning: 0, shifts: [] });
        continue;
      }

      // Run shift builder directly (fast — no solver, shared graph)
      const dayShifts = buildShiftsForDay(entriesForDay, graph, maxLegs, prePostHours, maxWait, 14, bases, false);

      days.push({
        date: dateStr,
        dayName: dayNames[d],
        lanesRunning: entriesForDay.length,
        shifts: dayShifts.map((s) => ({
          legs: s.legs.map((id) => nameMap.get(id) ?? id),
          legIds: s.legs,
          legCount: s.legs.length,
          driveHours: Math.round(s.totalDriveHours * 10) / 10,
          dutyHours: Math.round(s.totalDutyHours * 10) / 10,
          miles: Math.round(s.totalMiles),
          deadheadMiles: Math.round(s.totalDeadheadMiles),
          // Per-gap deadhead info between legs
          legGaps: s.legs.slice(1).map((id, i) => {
            const prevEntry = entries.find((e) => (e._id as string) === s.legs[i]);
            const nextEntry = entries.find((e) => (e._id as string) === id);
            if (!prevEntry || !nextEntry) return { miles: 0, driveHours: 0, waitHours: 0, prevDest: '', nextOrig: '', prevEndTime: null, nextStartTime: null };

            // Geographic deadhead
            let gapMiles = 0;
            if (prevEntry.destinationLat && prevEntry.destinationLng && nextEntry.originLat && nextEntry.originLng) {
              gapMiles = haversineDistance(prevEntry.destinationLat, prevEntry.destinationLng, nextEntry.originLat, nextEntry.originLng);
            }
            const driveHours = gapMiles / 55;

            // Time deadhead: when does prev leg finish vs when does next leg start?
            // Estimate prev leg finish: pickup time + dwell + drive + delivery dwell
            const prevPickup = prevEntry.originScheduledTime;
            const prevDuration = prevEntry.routeDurationHours ?? 0;
            const prevDwell = (prevEntry.intermediateStops?.length ?? 0) * 0.5 + 1.0; // rough
            const prevDeliveryEnd = prevEntry.destinationScheduledEndTime ?? prevEntry.destinationScheduledTime;

            const nextPickupStart = nextEntry.originScheduledTime;

            let waitHours = 0;
            let prevEndTime: string | null = null;
            let nextStartTime: string | null = null;
            let earliestArrival: string | null = null;

            if (prevDeliveryEnd && nextPickupStart) {
              prevEndTime = prevDeliveryEnd;
              nextStartTime = nextPickupStart;

              // Parse times
              const pEnd = prevDeliveryEnd.split(':').map(Number);
              const nStart = nextPickupStart.split(':').map(Number);
              if (pEnd.length >= 2 && nStart.length >= 2) {
                const prevEndHours = pEnd[0] + pEnd[1] / 60;
                const nextStartHours = nStart[0] + nStart[1] / 60;
                const arrivalHours = prevEndHours + driveHours;

                // Format earliest arrival
                const arrH = Math.floor(arrivalHours);
                const arrM = Math.round((arrivalHours - arrH) * 60);
                earliestArrival = `${String(arrH).padStart(2, '0')}:${String(arrM).padStart(2, '0')}`;

                if (arrivalHours < nextStartHours) {
                  waitHours = nextStartHours - arrivalHours;
                }
              }
            }

            return {
              miles: Math.round(gapMiles),
              driveHours: Math.round(driveHours * 10) / 10,
              waitHours: Math.round(waitHours * 10) / 10,
              prevDest: `${prevEntry.destinationCity}, ${prevEntry.destinationState}`,
              nextOrig: `${nextEntry.originCity}, ${nextEntry.originState}`,
              prevEndTime,
              nextStartTime,
              earliestArrival,
            };
          }),
        })),
      });
    }

    return { days };
  },
});

export const getEntryResults = query({
  args: { entryId: v.id('laneAnalysisEntries') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    return ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_entry', (q) => q.eq('entryId', args.entryId))
      .collect();
  },
});

// ---- IMPORT FROM CONTRACT LANES ----

export const importLanesFromContract = mutation({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    workosOrgId: v.string(),
    contractLaneIds: v.array(v.id('contractLanes')),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const imported: string[] = [];

    for (const laneId of args.contractLaneIds) {
      const lane = await ctx.db.get(laneId);
      if (!lane || lane.isDeleted) continue;

      const firstStop = lane.stops[0];
      const lastStop = lane.stops[lane.stops.length - 1];
      if (!firstStop || !lastStop) continue;

      const now = Date.now();
      const entryId = await ctx.db.insert('laneAnalysisEntries', {
        sessionId: args.sessionId,
        workosOrgId: args.workosOrgId,
        contractLaneId: laneId,
        name: `${lane.contractName} - ${firstStop.city}, ${firstStop.state} → ${lastStop.city}, ${lastStop.state}`,

        originAddress: firstStop.address,
        originCity: firstStop.city,
        originState: firstStop.state,
        originZip: firstStop.zip,

        destinationAddress: lastStop.address,
        destinationCity: lastStop.city,
        destinationState: lastStop.state,
        destinationZip: lastStop.zip,

        intermediateStops:
          lane.stops.length > 2
            ? lane.stops.slice(1, -1).map((s) => ({
                address: s.address,
                city: s.city,
                state: s.state,
                zip: s.zip,
                stopOrder: s.stopOrder,
                stopType: s.stopType,
                type: s.type,
                arrivalTime: s.arrivalTime,
              }))
            : undefined,

        routeMiles: lane.miles ?? lane.calculatedMiles,
        isRoundTrip: false,
        isCityRoute: false,

        // Schedule from contract lane, or default Mon-Fri
        scheduleRule: lane.scheduleRule ?? {
          activeDays: [1, 2, 3, 4, 5], // Mon-Fri default for lanes without schedule
          excludeFederalHolidays: true,
          customExclusions: [],
        },

        contractPeriodStart: lane.contractPeriodStart,
        contractPeriodEnd: lane.contractPeriodEnd,

        ratePerRun:
          lane.rateType === 'Flat Rate'
            ? lane.rate
            : lane.rateType === 'Per Mile' && lane.miles
              ? lane.rate * lane.miles
              : undefined,
        rateType: lane.rateType,
        ratePerMile: lane.rateType === 'Per Mile' ? lane.rate : undefined,
        minimumRate: lane.minimumRate,

        fuelSurchargeType: lane.fuelSurchargeType,
        fuelSurchargeValue: lane.fuelSurchargeValue,

        stopOffRate: lane.stopOffRate,
        includedStops: lane.includedStops,

        equipmentClass: lane.equipmentClass,
        equipmentSize: lane.equipmentSize,

        createdAt: now,
        updatedAt: now,
      });

      imported.push(entryId);
    }

    return imported;
  },
});

// ---- Export for Python solver ----

export const exportEntriesForSolver = query({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
  },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    const entries = await ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    // Also fetch bases for this session
    const bases = await ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    return {
      entries: entries.map((e) => ({
        id: e._id,
        name: e.name,
        originCity: e.originCity,
        originState: e.originState,
        originLat: e.originLat,
        originLng: e.originLng,
        destinationCity: e.destinationCity,
        destinationState: e.destinationState,
        destinationLat: e.destinationLat,
        destinationLng: e.destinationLng,
        routeMiles: e.routeMiles,
        routeDurationHours: e.routeDurationHours,
        originScheduledTime: e.originScheduledTime,
        originScheduledEndTime: e.originScheduledEndTime,
        destinationScheduledTime: e.destinationScheduledTime,
        destinationScheduledEndTime: e.destinationScheduledEndTime,
        originAppointmentType: e.originAppointmentType,
        destinationAppointmentType: e.destinationAppointmentType,
        scheduleRule: e.scheduleRule,
      })),
      bases: bases.map((b) => ({
        name: b.name,
        city: b.city,
        state: b.state,
        lat: b.latitude,
        lng: b.longitude,
      })),
    };
  },
});
