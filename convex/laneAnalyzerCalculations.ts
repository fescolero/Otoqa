import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { Doc } from './_generated/dataModel';
import {
  buildStopDwell,
  calculateScheduleForYear,
  hosAnalyzeRoute,
  calculateDriverPay,
  calculateFuelCost,
  calculateRevenuePerRun,
  getPaddRegion,
  calculateDriverCounts,
  parseSchedulePattern,
  buildDriverShifts,
  calculateDriverCountsWithChaining,
  MAX_WAIT_BETWEEN_LEGS,
  type ShiftBuilderEntry,
} from './laneAnalyzerMath';

// Re-export pure math so existing `from './laneAnalyzerCalculations'` import sites
// (and any future ones) continue to resolve. New code should import directly
// from './laneAnalyzerMath'.
export {
  buildStopDwell,
  calculateScheduleForYear,
  hosAnalyzeRoute,
  calculateDriverPay,
  calculateFuelCost,
  calculateRevenuePerRun,
  haversineDistance,
  getPaddRegion,
  calculateDriverCounts,
  parseSchedulePattern,
  buildAdjacencyGraph,
  buildShiftsForDay,
  buildDriverShifts,
  calculateDriverCountsWithChaining,
  MAX_WAIT_BETWEEN_LEGS,
} from './laneAnalyzerMath';
export type { DriverShift, ShiftBuilderEntry } from './laneAnalyzerMath';

// ==========================================
// LANE ANALYZER — Convex Handlers
// Internal mutations/queries that orchestrate DB I/O around the pure math
// functions in laneAnalyzerMath.ts.
// ==========================================

/**
 * Run full analysis for a session — computes all lane costs, driver counts, and aggregates.
 */
export const runFullAnalysis = internalMutation({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.isDeleted) throw new Error('Session not found');

    const entries = await ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    if (entries.length === 0) return;

    // Get fuel prices from cache
    const fuelPrices = await ctx.db.query('fuelPriceCache').collect();
    const fuelPriceMap = new Map(fuelPrices.map((fp) => [fp.region, fp.pricePerGallon]));

    // Get toll estimates from cache
    const tollEstimates = await ctx.db.query('tollEstimateCache').collect();
    const tollMap = new Map(
      tollEstimates.map((t) => [`${t.originHash}:${t.destinationHash}`, t.tollCost]),
    );

    // Get bases for return-to-base checks
    const baseDocs = await ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
    const basesForShifts = baseDocs.map((b) => ({
      id: b._id as string,
      name: b.name,
      lat: b.latitude ?? 0,
      lng: b.longitude ?? 0,
      city: b.city ?? '',
      state: b.state ?? '',
    }));

    // Find the existing AGGREGATE record (will be patched in-place, not deleted).
    // Keeping AGGREGATE in place means the solver.weeklySchedule stored there
    // survives re-analysis — fuel price refreshes, geocoding updates, etc. never
    // discard an optimized schedule.
    const existingAggregate = await ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .filter((q) => q.eq(q.field('resultType'), 'AGGREGATE'))
      .first();

    // Clear only PER_LANE and OPTIMIZATION_SUGGESTION results — leave AGGREGATE intact.
    const oldResults = await ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
    for (const r of oldResults) {
      if (r.resultType !== 'AGGREGATE') {
        await ctx.db.delete(r._id);
      }
    }

    const now = Date.now();
    const schedulePatternParsed = parseSchedulePattern(
      session.driverSchedulePattern,
      session.customScheduleOnDays,
      session.customScheduleOffDays,
    );

    // Per-lane calculations
    const entryAnalyses: Array<{
      entry: Doc<'laneAnalysisEntries'>;
      hosAnalysis: ReturnType<typeof hosAnalyzeRoute>;
      scheduleDates: string[];
      annualRunCount: number;
    }> = [];

    let totalCostPerYear = 0;
    let totalRevenuePerYear = 0;

    for (const entry of entries) {
      // Schedule
      const scheduleDates = calculateScheduleForYear(
        entry.scheduleRule,
        session.analysisYear,
        entry.contractPeriodStart,
        entry.contractPeriodEnd,
      );
      const annualRunCount = entry.isRoundTrip ? scheduleDates.length * 2 : scheduleDates.length;

      // HOS — use actual appointment types from origin, stops, and destination
      const numStops = 2 + (entry.intermediateStops?.length ?? 0);
      const stopTypes = entry.intermediateStops?.map((s) => s.type);
      const originAppt = entry.originAppointmentType ?? 'APPT';
      const destAppt = entry.destinationAppointmentType ?? 'APPT';
      const allStopTypes = [originAppt, ...(stopTypes ?? []), destAppt];

      // Build appointment windows for dwell calculation
      const apptWindows = [
        { start: entry.originScheduledTime, end: entry.originScheduledEndTime },
        ...(entry.intermediateStops?.map((s) => ({ start: s.arrivalTime, end: s.arrivalEndTime })) ?? []),
        { start: entry.destinationScheduledTime, end: entry.destinationScheduledEndTime },
      ];

      // Session-configurable dwell times
      const stopDwellOverrides = buildStopDwell({
        dwellTimeApptMinutes: session.dwellTimeApptMinutes,
        dwellTimeLiveMinutes: session.dwellTimeLiveMinutes,
        dwellTimeFcfsMinutes: session.dwellTimeFcfsMinutes,
      });

      const hosResult = hosAnalyzeRoute(
        entry.routeDurationHours ?? 0,
        numStops,
        allStopTypes,
        {
          stopDwellOverrides,
          prePostTripHours: session.prePostTripMinutes != null ? session.prePostTripMinutes / 60 : undefined,
          apptWindows,
          useApptWindowsForDwell: session.useApptWindowsForDwell ?? false,
        },
      );

      // MPG
      const mpg = entry.mpgOverride ?? (entry.isCityRoute ? session.defaultMpgCity : session.defaultMpgHighway);

      // Fuel price — use PADD region based on origin state
      const paddRegion = getPaddRegion(entry.originState);
      const fuelPrice =
        session.defaultFuelPricePerGallon ??
        fuelPriceMap.get(paddRegion) ??
        fuelPriceMap.get('US_AVERAGE') ??
        4.0; // ultimate fallback

      // Fuel cost
      const routeMiles = entry.routeMiles ?? 0;
      const fuelCostPerRun = calculateFuelCost(
        entry.isRoundTrip ? routeMiles * 2 : routeMiles,
        mpg,
        fuelPrice,
      );

      // Tolls
      const originHash = `${entry.originLat?.toFixed(2)},${entry.originLng?.toFixed(2)}`;
      const destHash = `${entry.destinationLat?.toFixed(2)},${entry.destinationLng?.toFixed(2)}`;
      const tollCostPerRun = tollMap.get(`${originHash}:${destHash}`) ?? 0;

      // Driver pay
      const payType = entry.driverPayTypeOverride ?? session.defaultDriverPayType;
      const payRate = entry.driverPayRateOverride ?? session.defaultDriverPayRate;
      const effectiveMiles = entry.isRoundTrip ? routeMiles * 2 : routeMiles;
      const driverPayPerRun = calculateDriverPay(
        payType,
        payRate,
        effectiveMiles,
        hosResult.dutyTimePerRun,
      );

      // Total cost per run
      const totalCostPerRun = fuelCostPerRun + tollCostPerRun + driverPayPerRun;

      // Revenue per run
      const revenuePerRun = calculateRevenuePerRun({
        ratePerRun: entry.ratePerRun,
        rateType: entry.rateType,
        ratePerMile: entry.ratePerMile,
        routeMiles: entry.routeMiles,
        minimumRate: entry.minimumRate,
        fuelSurchargeType: entry.fuelSurchargeType,
        fuelSurchargeValue: entry.fuelSurchargeValue,
        stopOffRate: entry.stopOffRate,
        includedStops: entry.includedStops,
        numStops,
      });

      // Margin
      const marginPerRun = revenuePerRun - totalCostPerRun;
      const marginPercent = revenuePerRun > 0 ? (marginPerRun / revenuePerRun) * 100 : 0;

      // Periods
      const runsPerWeek = scheduleDates.length / 52;
      const costPerWeek = totalCostPerRun * runsPerWeek;
      const costPerMonth = totalCostPerRun * (scheduleDates.length / 12);
      const costPerYear = totalCostPerRun * scheduleDates.length;
      const revenuePerYear = revenuePerRun * scheduleDates.length;

      totalCostPerYear += costPerYear;
      totalRevenuePerYear += revenuePerYear;

      // Write per-lane result
      await ctx.db.insert('laneAnalysisResults', {
        sessionId: args.sessionId,
        workosOrgId: session.workosOrgId,
        entryId: entry._id,
        resultType: 'PER_LANE',
        computedAt: now,
        annualRunCount: scheduleDates.length,
        fuelCostPerRun: Math.round(fuelCostPerRun * 100) / 100,
        tollCostPerRun: Math.round(tollCostPerRun * 100) / 100,
        driverPayPerRun: Math.round(driverPayPerRun * 100) / 100,
        totalCostPerRun: Math.round(totalCostPerRun * 100) / 100,
        revenuePerRun: Math.round(revenuePerRun * 100) / 100,
        marginPerRun: Math.round(marginPerRun * 100) / 100,
        marginPercent: Math.round(marginPercent * 10) / 10,
        costPerWeek: Math.round(costPerWeek * 100) / 100,
        costPerMonth: Math.round(costPerMonth * 100) / 100,
        costPerYear: Math.round(costPerYear * 100) / 100,
        revenuePerYear: Math.round(revenuePerYear * 100) / 100,
        requiresTeamDrivers: hosResult.requiresTeam,
        hosAnalysis: JSON.stringify(hosResult),
      });

      entryAnalyses.push({
        entry,
        hosAnalysis: hosResult,
        scheduleDates,
        annualRunCount: scheduleDates.length,
      });
    }

    // --- Multi-Leg Shift Building ---
    const shiftInput: ShiftBuilderEntry[] = entryAnalyses.map((ea) => ({
      id: ea.entry._id as string,
      originCity: ea.entry.originCity,
      originState: ea.entry.originState,
      originLat: ea.entry.originLat,
      originLng: ea.entry.originLng,
      destCity: ea.entry.destinationCity,
      destState: ea.entry.destinationState,
      destLat: ea.entry.destinationLat,
      destLng: ea.entry.destinationLng,
      routeDurationHours: ea.entry.routeDurationHours ?? 0,
      routeMiles: ea.entry.routeMiles ?? 0,
      scheduleDates: ea.scheduleDates,
      hosAnalysis: ea.hosAnalysis,
      originApptType: ea.entry.originAppointmentType,
      destApptType: ea.entry.destinationAppointmentType,
      originScheduledTime: ea.entry.originScheduledTime,
      destScheduledTime: ea.entry.destinationScheduledTime,
      originScheduledEndTime: ea.entry.originScheduledEndTime,
      destScheduledEndTime: ea.entry.destinationScheduledEndTime,
    }));

    const prePostHours = session.prePostTripMinutes != null ? session.prePostTripMinutes / 60 : 1.0;
    const maxWait = session.maxWaitHours ?? MAX_WAIT_BETWEEN_LEGS;
    const weeklyMode = session.weeklyHosMode ?? 'flexible';
    const shiftResult = buildDriverShifts(
      shiftInput,
      session.maxDeadheadMiles ?? 75,
      session.maxChainingLegs ?? 8,
      prePostHours,
      maxWait,
      schedulePatternParsed.onDays,
      basesForShifts,
      weeklyMode,
    );

    // Driver/truck counts from shift building
    const driverCounts = calculateDriverCountsWithChaining(
      entryAnalyses.map((ea) => ({
        id: ea.entry._id as string,
        hosAnalysis: ea.hosAnalysis,
        annualRunCount: ea.annualRunCount,
        equipmentClass: ea.entry.equipmentClass,
        scheduleDates: ea.scheduleDates,
      })),
      shiftResult,
      { pattern: session.driverSchedulePattern, ...schedulePatternParsed },
    );

    // Unpaired baseline for comparison
    const unpairedDriverCounts = calculateDriverCounts(
      entryAnalyses.map((ea) => ({
        hosAnalysis: ea.hosAnalysis,
        annualRunCount: ea.annualRunCount,
        equipmentClass: ea.entry.equipmentClass,
        scheduleDates: ea.scheduleDates,
      })),
      { pattern: session.driverSchedulePattern, ...schedulePatternParsed },
    );

    // Build a sample of shift patterns for the peak day — with cost breakdown
    const peakDayShifts = shiftResult.dailyShifts.get(shiftResult.peakDay.date) ?? [];
    const entryNameMap = new Map(entryAnalyses.map((ea) => [ea.entry._id as string, ea.entry.name]));

    // Build a map of entry ID → per-lane cost data for cost rollup
    const perLaneCostMap = new Map<string, { fuelCost: number; driverPay: number; tollCost: number }>();
    for (const ea of entryAnalyses) {
      const entry = ea.entry;
      const mpg = entry.mpgOverride ?? (entry.isCityRoute ? session.defaultMpgCity : session.defaultMpgHighway);
      const paddRegion = getPaddRegion(entry.originState);
      const fp =
        session.defaultFuelPricePerGallon ??
        fuelPriceMap.get(paddRegion) ??
        fuelPriceMap.get('US_AVERAGE') ?? 4.0;
      const routeMiles = entry.routeMiles ?? 0;
      const effectiveMiles = entry.isRoundTrip ? routeMiles * 2 : routeMiles;
      const fuelCost = calculateFuelCost(effectiveMiles, mpg, fp);
      const payType = entry.driverPayTypeOverride ?? session.defaultDriverPayType;
      const payRate = entry.driverPayRateOverride ?? session.defaultDriverPayRate;
      const driverPay = calculateDriverPay(payType, payRate, effectiveMiles, ea.hosAnalysis.dutyTimePerRun);

      const originHash = `${entry.originLat?.toFixed(2)},${entry.originLng?.toFixed(2)}`;
      const destHash = `${entry.destinationLat?.toFixed(2)},${entry.destinationLng?.toFixed(2)}`;
      const tollCost = tollMap.get(`${originHash}:${destHash}`) ?? 0;

      perLaneCostMap.set(entry._id as string, { fuelCost, driverPay, tollCost });
    }

    // Also compute deadhead cost per mile for the shift's deadhead
    const defaultFuelPriceForDH =
      session.defaultFuelPricePerGallon ??
      fuelPriceMap.get('US_AVERAGE') ?? 4.0;
    const defaultMpgForDH = session.defaultMpgHighway;
    const dhPayType = session.defaultDriverPayType;
    const dhPayRate = session.defaultDriverPayRate;

    const peakDayShiftSummary = peakDayShifts.slice(0, 20).map((s) => {
      // Sum costs across all legs in this shift
      let shiftFuelCost = 0;
      let shiftDriverPay = 0;
      let shiftTollCost = 0;
      let shiftRevenue = 0;

      for (const legId of s.legs) {
        const costs = perLaneCostMap.get(legId);
        if (costs) {
          shiftFuelCost += costs.fuelCost;
          shiftDriverPay += costs.driverPay;
          shiftTollCost += costs.tollCost;
        }
        // Revenue from the per-lane analysis
        const ea = entryAnalyses.find((x) => (x.entry._id as string) === legId);
        if (ea) {
          shiftRevenue += calculateRevenuePerRun({
            ratePerRun: ea.entry.ratePerRun,
            rateType: ea.entry.rateType,
            ratePerMile: ea.entry.ratePerMile,
            routeMiles: ea.entry.routeMiles,
            minimumRate: ea.entry.minimumRate,
            fuelSurchargeType: ea.entry.fuelSurchargeType,
            fuelSurchargeValue: ea.entry.fuelSurchargeValue,
            stopOffRate: ea.entry.stopOffRate,
            includedStops: ea.entry.includedStops,
            numStops: 2 + (ea.entry.intermediateStops?.length ?? 0),
          });
        }
      }

      // Deadhead cost (empty miles between legs)
      const dhFuelCost = calculateFuelCost(s.totalDeadheadMiles, defaultMpgForDH, defaultFuelPriceForDH);
      const dhTimeHours = s.totalDeadheadMiles / 55;
      const dhDriverPay = calculateDriverPay(dhPayType, dhPayRate, s.totalDeadheadMiles, dhTimeHours);
      const deadheadCost = dhFuelCost + dhDriverPay;

      const totalCost = shiftFuelCost + shiftDriverPay + shiftTollCost + deadheadCost;

      return {
        legs: s.legs.map((id) => entryNameMap.get(id) ?? id),
        legCount: s.legs.length,
        driveHours: Math.round(s.totalDriveHours * 10) / 10,
        dutyHours: Math.round(s.totalDutyHours * 10) / 10,
        miles: Math.round(s.totalMiles),
        deadheadMiles: Math.round(s.totalDeadheadMiles),
        // Cost breakdown
        fuelCost: Math.round(shiftFuelCost * 100) / 100,
        driverPay: Math.round(shiftDriverPay * 100) / 100,
        tollCost: Math.round(shiftTollCost * 100) / 100,
        deadheadCost: Math.round(deadheadCost * 100) / 100,
        totalCost: Math.round(totalCost * 100) / 100,
        revenue: Math.round(shiftRevenue * 100) / 100,
        profit: Math.round((shiftRevenue - totalCost) * 100) / 100,
      };
    });

    // Build the fresh hosAnalysis payload (cost/driver metrics only).
    // The solver.weeklySchedule key is NOT included here — it lives separately
    // in the AGGREGATE record and is never touched by re-analysis.
    const freshHosAnalysisMetrics = {
      driverCounts,
      unpairedDriverCounts,
      schedulePattern: schedulePatternParsed,
      shiftBuilding: {
        chainedLanes: driverCounts.chainedLaneCount,
        soloLanes: driverCounts.soloLaneCount,
        driverSavings: driverCounts.driverSavings,
        avgLegsPerShift: driverCounts.avgLegsPerShift,
        maxLegsInAnyShift: driverCounts.maxLegsInAnyShift,
        totalShiftPatterns: driverCounts.totalShiftPatterns,
        weeklyHosExtraDrivers: driverCounts.weeklyHosExtraDrivers,
        avgDutyPerShift: driverCounts.avgDutyPerShift,
        dutyBands: driverCounts.dutyBands,
        peakDayShifts: peakDayShiftSummary,
      },
    };

    const freshFields = {
      computedAt: now,
      annualRunCount: entryAnalyses.reduce((sum, ea) => sum + ea.annualRunCount, 0),
      costPerYear: Math.round(totalCostPerYear * 100) / 100,
      revenuePerYear: Math.round(totalRevenuePerYear * 100) / 100,
      marginPerRun:
        Math.round(((totalRevenuePerYear - totalCostPerYear) / Math.max(entries.length, 1)) * 100) / 100,
      marginPercent:
        totalRevenuePerYear > 0
          ? Math.round(((totalRevenuePerYear - totalCostPerYear) / totalRevenuePerYear) * 1000) / 10
          : 0,
      minDriverCount: driverCounts.minDriverCount,
      realisticDriverCount: driverCounts.realisticDriverCount,
      minTruckCount: driverCounts.truckCount,
      realisticTruckCount: driverCounts.truckCount,
    };

    if (existingAggregate) {
      // Patch in-place: merge fresh metrics into hosAnalysis while preserving
      // any solver.weeklySchedule that was stored there.
      const existingParsed = existingAggregate.hosAnalysis
        ? (() => { try { return JSON.parse(existingAggregate.hosAnalysis as string); } catch { return {}; } })()
        : {};
      await ctx.db.patch(existingAggregate._id, {
        ...freshFields,
        hosAnalysis: JSON.stringify({
          ...freshHosAnalysisMetrics,
          // Carry solver key forward untouched if present
          ...(existingParsed?.solver ? { solver: existingParsed.solver } : {}),
        }),
      });
    } else {
      // First analysis run for this session — no existing AGGREGATE to patch
      await ctx.db.insert('laneAnalysisResults', {
        sessionId: args.sessionId,
        workosOrgId: session.workosOrgId,
        resultType: 'AGGREGATE',
        ...freshFields,
        hosAnalysis: JSON.stringify(freshHosAnalysisMetrics),
      });
    }
  },
});

/**
 * Get expanded schedule calendar for all entries in a session.
 */
export const getScheduleCalendar = internalQuery({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    year: v.number(),
  },
  handler: async (ctx, args) => {
    const entries = await ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    return entries.map((entry) => ({
      entryId: entry._id,
      name: entry.name,
      dates: calculateScheduleForYear(
        entry.scheduleRule,
        args.year,
        entry.contractPeriodStart,
        entry.contractPeriodEnd,
      ),
    }));
  },
});
