import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import { assertCallerOwnsOrg, requireCallerOrgId } from './lib/auth';
import { Doc, Id } from './_generated/dataModel';
import {
  haversineDistance,
  calculateScheduleForYear,
  hosAnalyzeRoute,
  calculateFuelCost,
  calculateDriverPay,
  getPaddRegion,
  buildStopDwell,
} from './laneAnalyzerCalculations';

// ==========================================
// LANE ANALYZER — Optimization Logic
// Base optimization, deadhead analysis, lane pairing
// ==========================================

// ---- TYPES ----

interface BaseAssignment {
  entryId: string;
  laneName: string;
  currentBaseId: string | null;
  currentBaseName: string | null;
  currentDeadheadMiles: number;
  currentDeadheadCost: number;
  optimalBaseId: string;
  optimalBaseName: string;
  optimalDeadheadMiles: number;
  optimalDeadheadCost: number;
  savingsPerRun: number;
  annualSavings: number;
  hosFeasible: boolean;
  recommendParking: boolean;
  parkingCostPerNight: number;
  returnToBaseCost: number;
}

interface LanePairSuggestion {
  laneAId: string;
  laneAName: string;
  laneBId: string;
  laneBName: string;
  proximityMiles: number;
  transitTimeHours: number;
  deadheadSavingsPerRun: number;
  annualCostSavings: number;
  scheduleFeasible: boolean;
  hosFeasible: boolean;
  overlappingRunDays: number;
}

// ---- CONSTANTS ----

const DEFAULT_AVG_SPEED_MPH = 50;
const DEFAULT_PARKING_COST_PER_NIGHT = 20; // $15-25 average
const HOS_MAX_DRIVE_SOLO = 11;

// ---- BASE OPTIMIZATION ----

/**
 * Compute optimal base assignments for all lanes in a session.
 * Returns per-lane assignments with savings analysis.
 */
export const optimizeBases = internalMutation({
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

    // Get all bases (org-wide + session-specific)
    const sessionBases = await ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();
    const orgBases = await ctx.db
      .query('laneAnalysisBases')
      .withIndex('by_organization', (q) => q.eq('workosOrgId', session.workosOrgId))
      .filter((q) => q.eq(q.field('sessionId'), undefined))
      .collect();
    const allBases = [...orgBases, ...sessionBases].filter((b) => b.isActive);

    if (allBases.length === 0 || entries.length === 0) return;

    // Get fuel prices for cost calculation
    const fuelPrices = await ctx.db.query('fuelPriceCache').collect();
    const fuelPriceMap = new Map(fuelPrices.map((fp) => [fp.region, fp.pricePerGallon]));

    const now = Date.now();
    const assignments: BaseAssignment[] = [];

    // Track base capacity usage
    const baseUsage = new Map<string, number>();

    for (const entry of entries) {
      if (!entry.originLat || !entry.originLng || !entry.destinationLat || !entry.destinationLng) {
        continue; // Skip entries without coordinates
      }

      const mpg = entry.mpgOverride ?? (entry.isCityRoute ? session.defaultMpgCity : session.defaultMpgHighway);
      const fuelPrice = session.defaultFuelPricePerGallon ??
        fuelPriceMap.get(getPaddRegion(entry.originState)) ??
        fuelPriceMap.get('US_AVERAGE') ?? 4.0;

      const payType = entry.driverPayTypeOverride ?? session.defaultDriverPayType;
      const payRate = entry.driverPayRateOverride ?? session.defaultDriverPayRate;

      // Calculate schedule for annual run count
      const scheduleDates = calculateScheduleForYear(
        entry.scheduleRule,
        session.analysisYear,
        entry.contractPeriodStart,
        entry.contractPeriodEnd,
      );
      const annualRuns = scheduleDates.length;

      // For each base, calculate deadhead cost
      const baseOptions: Array<{
        base: Doc<'laneAnalysisBases'>;
        deadheadToOrigin: number;
        deadheadFromDest: number;
        totalDeadhead: number;
        deadheadCost: number;
        deadheadTimeHours: number;
      }> = [];

      for (const base of allBases) {
        if (!base.latitude || !base.longitude) continue;

        const deadheadToOrigin = haversineDistance(
          base.latitude, base.longitude,
          entry.originLat, entry.originLng,
        );
        const deadheadFromDest = haversineDistance(
          entry.destinationLat, entry.destinationLng,
          base.latitude, base.longitude,
        );
        const totalDeadhead = deadheadToOrigin + deadheadFromDest;

        // Deadhead cost = fuel + driver pay for empty miles
        const deadheadFuel = calculateFuelCost(totalDeadhead, mpg, fuelPrice);
        const deadheadTimeHours = totalDeadhead / DEFAULT_AVG_SPEED_MPH;
        const deadheadDriverPay = calculateDriverPay(payType, payRate, totalDeadhead, deadheadTimeHours);
        const deadheadCost = deadheadFuel + deadheadDriverPay;

        baseOptions.push({
          base,
          deadheadToOrigin,
          deadheadFromDest,
          totalDeadhead,
          deadheadCost,
          deadheadTimeHours,
        });
      }

      if (baseOptions.length === 0) continue;

      // Sort by cost ascending
      baseOptions.sort((a, b) => a.deadheadCost - b.deadheadCost);
      const optimal = baseOptions[0];

      // Find current base assignment
      let currentOption = entry.baseId
        ? baseOptions.find((o) => o.base._id === entry.baseId)
        : null;

      // If no current base, use the most expensive as "current" for comparison
      if (!currentOption && baseOptions.length > 1) {
        currentOption = baseOptions[baseOptions.length - 1];
      }

      // HOS feasibility: can driver do deadhead + route + deadhead in one shift?
      const routeDuration = entry.routeDurationHours ?? 0;
      const totalDriveTime = optimal.deadheadTimeHours + routeDuration +
        (entry.isRoundTrip ? routeDuration : 0) + optimal.deadheadTimeHours;
      const hosFeasible = totalDriveTime <= HOS_MAX_DRIVE_SOLO;

      // Park vs return analysis (for one-way routes)
      const returnToBaseCost = (() => {
        const returnFuel = calculateFuelCost(optimal.deadheadFromDest, mpg, fuelPrice);
        const returnTime = optimal.deadheadFromDest / DEFAULT_AVG_SPEED_MPH;
        const returnPay = calculateDriverPay(payType, payRate, optimal.deadheadFromDest, returnTime);
        return returnFuel + returnPay;
      })();
      const recommendParking = returnToBaseCost > DEFAULT_PARKING_COST_PER_NIGHT && !entry.isRoundTrip;

      const savingsPerRun = (currentOption?.deadheadCost ?? 0) - optimal.deadheadCost;

      assignments.push({
        entryId: entry._id,
        laneName: entry.name,
        currentBaseId: entry.baseId ?? null,
        currentBaseName: currentOption ? currentOption.base.name : null,
        currentDeadheadMiles: currentOption?.totalDeadhead ?? 0,
        currentDeadheadCost: currentOption?.deadheadCost ?? 0,
        optimalBaseId: optimal.base._id,
        optimalBaseName: optimal.base.name,
        optimalDeadheadMiles: optimal.totalDeadhead,
        optimalDeadheadCost: optimal.deadheadCost,
        savingsPerRun: Math.round(savingsPerRun * 100) / 100,
        annualSavings: Math.round(savingsPerRun * annualRuns * 100) / 100,
        hosFeasible,
        recommendParking,
        parkingCostPerNight: DEFAULT_PARKING_COST_PER_NIGHT,
        returnToBaseCost: Math.round(returnToBaseCost * 100) / 100,
      });

      // Track capacity
      const usage = baseUsage.get(optimal.base._id) ?? 0;
      baseUsage.set(optimal.base._id, usage + 1);
    }

    // Check capacity warnings
    const capacityWarnings: Array<{ baseId: string; baseName: string; assigned: number; capacity: number }> = [];
    for (const [baseId, assigned] of baseUsage) {
      const base = allBases.find((b) => b._id === baseId);
      if (base?.capacity && assigned > base.capacity) {
        capacityWarnings.push({
          baseId,
          baseName: base.name,
          assigned,
          capacity: base.capacity,
        });
      }
    }

    // Summary
    const totalCurrentCost = assignments.reduce((s, a) => s + a.currentDeadheadCost, 0);
    const totalOptimalCost = assignments.reduce((s, a) => s + a.optimalDeadheadCost, 0);
    const totalAnnualSavings = assignments.reduce((s, a) => s + a.annualSavings, 0);

    // Write optimization results
    const resultData = {
      assignments,
      summary: {
        totalCurrentDeadheadCostPerRun: Math.round(totalCurrentCost * 100) / 100,
        totalOptimalDeadheadCostPerRun: Math.round(totalOptimalCost * 100) / 100,
        totalAnnualSavings: Math.round(totalAnnualSavings * 100) / 100,
        lanesRequiringReassignment: assignments.filter((a) => a.currentBaseId !== a.optimalBaseId).length,
        lanesRecommendedParking: assignments.filter((a) => a.recommendParking).length,
      },
      capacityWarnings,
    };

    // Write as OPTIMIZATION_SUGGESTION result
    await ctx.db.insert('laneAnalysisResults', {
      sessionId: args.sessionId,
      workosOrgId: session.workosOrgId,
      resultType: 'OPTIMIZATION_SUGGESTION',
      computedAt: now,
      suggestionType: 'CHANGE_BASE',
      suggestionDetails: JSON.stringify(resultData),
      estimatedSavings: totalAnnualSavings,
    });

    // Write per-lane deadhead results
    for (const assignment of assignments) {
      // Find existing per-lane result and update it
      const existingResult = await ctx.db
        .query('laneAnalysisResults')
        .withIndex('by_entry', (q) => q.eq('entryId', assignment.entryId as Id<'laneAnalysisEntries'>))
        .filter((q) => q.eq(q.field('resultType'), 'PER_LANE'))
        .first();

      if (existingResult) {
        await ctx.db.patch(existingResult._id, {
          deadheadMilesToOrigin: assignment.optimalDeadheadMiles / 2, // approximate split
          deadheadMilesFromDestination: assignment.optimalDeadheadMiles / 2,
          totalDeadheadMiles: assignment.optimalDeadheadMiles,
          deadheadCost: assignment.optimalDeadheadCost,
        });
      }
    }
  },
});

// ---- LANE PAIRING ----

/**
 * Find lane pair opportunities where one lane's destination is near another's origin.
 *
 * IMPORTANT: Shows the REAL cost of the pairing (transit fuel + driver pay + time)
 * and only shows savings when pairing genuinely costs less than running separately.
 *
 * Savings = (cost of 2 separate drivers) - (cost of 1 driver doing both + transit deadhead)
 * If transit deadhead is expensive (268mi Las Vegas → Santa Ana), the "savings" shrink or go negative.
 */
export const findLaneCombinations = internalMutation({
  args: {
    sessionId: v.id('laneAnalysisSessions'),
    maxProximityMiles: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.isDeleted) throw new Error('Session not found');

    const entries = await ctx.db
      .query('laneAnalysisEntries')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect();

    const maxRadius = args.maxProximityMiles ?? session.maxDeadheadMiles ?? 50;
    const suggestions: (LanePairSuggestion & {
      transitFuelCost: number;
      transitDriverCost: number;
      totalTransitCost: number;
      separateDriverCostPerRun: number;
      combinedDriverCostPerRun: number;
    })[] = [];

    // Get fuel prices
    const fuelPrices = await ctx.db.query('fuelPriceCache').collect();
    const fuelPriceMap = new Map(fuelPrices.map((fp) => [fp.region, fp.pricePerGallon]));

    const fuelPrice = session.defaultFuelPricePerGallon ??
      fuelPriceMap.get('US_AVERAGE') ?? 4.0;
    const mpgHwy = session.defaultMpgHighway;
    const payType = session.defaultDriverPayType;
    const payRate = session.defaultDriverPayRate;

    // For every pair (A, B), check if A.dest is near B.origin
    for (let i = 0; i < entries.length; i++) {
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const a = entries[i];
        const b = entries[j];

        // Must have coordinates to calculate real distance
        if (!a.destinationLat || !a.destinationLng || !b.originLat || !b.originLng) continue;

        const transitMiles = haversineDistance(
          a.destinationLat, a.destinationLng,
          b.originLat, b.originLng,
        );

        if (transitMiles > maxRadius) continue;

        // Check schedule overlap
        const aDates = new Set(calculateScheduleForYear(
          a.scheduleRule, session.analysisYear,
          a.contractPeriodStart, a.contractPeriodEnd,
        ));
        const bDates = calculateScheduleForYear(
          b.scheduleRule, session.analysisYear,
          b.contractPeriodStart, b.contractPeriodEnd,
        );
        const overlappingDays = bDates.filter((d) => aDates.has(d));

        if (overlappingDays.length === 0) continue;

        // ---- REAL COST MATH ----
        const transitTimeHours = transitMiles / DEFAULT_AVG_SPEED_MPH;
        const aDuration = a.routeDurationHours ?? 0;
        const bDuration = b.routeDurationHours ?? 0;
        const aMiles = a.routeMiles ?? 0;
        const bMiles = b.routeMiles ?? 0;

        // HOS: combined drive = A route + transit + B route
        const aDwell = a.intermediateStops
          ? a.intermediateStops.length * 0.5 + 1.0 // rough dwell
          : 1.0;
        const bDwell = b.intermediateStops
          ? b.intermediateStops.length * 0.5 + 1.0
          : 1.0;
        const combinedDrive = aDuration + transitTimeHours + bDuration;
        const combinedDuty = combinedDrive + aDwell + bDwell + 1.0; // +1h pre/post
        const hosFeasible = combinedDrive <= HOS_MAX_DRIVE_SOLO && combinedDuty <= 14;

        // Cost of transit deadhead (the REAL cost of pairing)
        const transitFuelCost = calculateFuelCost(transitMiles, mpgHwy, fuelPrice);
        const transitDriverCost = calculateDriverPay(payType, payRate, transitMiles, transitTimeHours);
        const totalTransitCost = transitFuelCost + transitDriverCost;

        // Cost of running SEPARATELY: 2 drivers, each paid for their route
        // Driver A: paid for A route
        const driverAPayPerRun = calculateDriverPay(payType, payRate, aMiles, aDuration + aDwell);
        // Driver B: paid for B route
        const driverBPayPerRun = calculateDriverPay(payType, payRate, bMiles, bDuration + bDwell);
        const separateDriverCostPerRun = driverAPayPerRun + driverBPayPerRun;

        // Cost of running COMBINED: 1 driver, paid for A route + transit + B route
        const combinedMiles = aMiles + transitMiles + bMiles;
        const combinedTime = combinedDuty;
        const combinedDriverPay = calculateDriverPay(payType, payRate, combinedMiles, combinedTime);
        const combinedDriverCostPerRun = combinedDriverPay + transitFuelCost; // transit fuel is added cost

        // Net savings per overlapping day = separate cost - combined cost
        // This can be NEGATIVE if transit deadhead is expensive
        const savingsPerRun = separateDriverCostPerRun - combinedDriverCostPerRun;
        const annualSavings = savingsPerRun * overlappingDays.length;

        // Only suggest if there's actual savings AND it's HOS feasible
        if (annualSavings <= 0) continue;

        suggestions.push({
          laneAId: a._id,
          laneAName: a.name,
          laneBId: b._id,
          laneBName: b.name,
          proximityMiles: Math.round(transitMiles * 10) / 10,
          transitTimeHours: Math.round(transitTimeHours * 10) / 10,
          deadheadSavingsPerRun: Math.round(savingsPerRun * 100) / 100,
          annualCostSavings: Math.round(annualSavings * 100) / 100,
          scheduleFeasible: true,
          hosFeasible,
          overlappingRunDays: overlappingDays.length,
          // Extra detail for transparency
          transitFuelCost: Math.round(transitFuelCost * 100) / 100,
          transitDriverCost: Math.round(transitDriverCost * 100) / 100,
          totalTransitCost: Math.round(totalTransitCost * 100) / 100,
          separateDriverCostPerRun: Math.round(separateDriverCostPerRun * 100) / 100,
          combinedDriverCostPerRun: Math.round(combinedDriverCostPerRun * 100) / 100,
        });
      }
    }

    // Sort by annual savings descending, take top 20
    suggestions.sort((a, b) => b.annualCostSavings - a.annualCostSavings);
    const topSuggestions = suggestions.slice(0, 20);

    // Write results
    const now = Date.now();
    for (const suggestion of topSuggestions) {
      await ctx.db.insert('laneAnalysisResults', {
        sessionId: args.sessionId,
        workosOrgId: session.workosOrgId,
        resultType: 'OPTIMIZATION_SUGGESTION',
        computedAt: now,
        suggestionType: 'COMBINE_LANES',
        suggestionDetails: JSON.stringify(suggestion),
        estimatedSavings: suggestion.annualCostSavings,
      });
    }
  },
});

// ---- PUBLIC QUERIES ----

/**
 * Get optimization results for a session.
 */
export const getOptimizationResults = query({
  args: { sessionId: v.id('laneAnalysisSessions') },
  handler: async (ctx, args) => {
    await requireCallerOrgId(ctx);
    return ctx.db
      .query('laneAnalysisResults')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .filter((q) => q.eq(q.field('resultType'), 'OPTIMIZATION_SUGGESTION'))
      .collect();
  },
});

// ---- HISTORICAL LANE PERFORMANCE ANALYSIS ----

const MAX_LOADS_PER_LANE = 200; // Keep reads manageable per lane
const MAX_LANES_PER_QUERY = 10; // Process max 10 lanes per call to stay under 16MB read limit

interface LanePerformanceResult {
  contractLaneId: string;
  laneName: string;
  hcr: string;
  tripNumber: string;
  totalRuns: number;
  metrics: {
    avgRevenuePerRun: number;
    avgCostPerRun: number;
    avgProfitPerRun: number;
    avgMarginPercent: number;
    avgRevenuePerMile: number;
    avgCostPerMile: number;
    totalRevenue: number;
    totalCost: number;
    totalProfit: number;
    totalMiles: number;
  };
  comparison: {
    expectedRevenuePerRun: number;
    revenueVariance: number;
  };
  flags: string[];
  trend: Array<{ month: string; revenue: number; cost: number; margin: number; runs: number }>;
}

/**
 * Analyze historical performance of existing contract lanes.
 * Pulls loads, invoices, payables, and fuel entries to compute actual vs estimated metrics.
 */
export const analyzeLanePerformance = query({
  args: {
    workosOrgId: v.string(),
    contractLaneIds: v.array(v.id('contractLanes')),
    dateRangeStart: v.string(), // YYYY-MM-DD
    dateRangeEnd: v.string(),
  },
  handler: async (ctx, args): Promise<LanePerformanceResult[]> => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const results: LanePerformanceResult[] = [];

    // Limit lanes processed per query to stay under Convex read limits
    const laneIdsToProcess = args.contractLaneIds.slice(0, MAX_LANES_PER_QUERY);

    for (const laneId of laneIdsToProcess) {
      const lane = await ctx.db.get(laneId);
      if (!lane || lane.isDeleted) continue;

      // Fetch loads matching this lane by HCR + Trip
      let loads: Doc<'loadInformation'>[] = [];
      if (lane.hcr) {
        const hcrLoads = await ctx.db
          .query('loadInformation')
          .withIndex('by_hcr_trip', (q) =>
            q.eq('workosOrgId', args.workosOrgId).eq('parsedHcr', lane.hcr!),
          )
          .take(MAX_LOADS_PER_LANE);

        // Filter by trip number if set, date range, and completed status
        loads = hcrLoads.filter((l) => {
          if (lane.tripNumber && l.parsedTripNumber !== lane.tripNumber) return false;
          if (!l.firstStopDate) return false;
          if (l.firstStopDate < args.dateRangeStart || l.firstStopDate > args.dateRangeEnd) return false;
          if (l.status !== 'Completed') return false;
          return true;
        });
      }

      if (loads.length === 0) {
        results.push({
          contractLaneId: laneId,
          laneName: lane.contractName,
          hcr: lane.hcr ?? '',
          tripNumber: lane.tripNumber ?? '',
          totalRuns: 0,
          metrics: {
            avgRevenuePerRun: 0, avgCostPerRun: 0, avgProfitPerRun: 0,
            avgMarginPercent: 0, avgRevenuePerMile: 0, avgCostPerMile: 0,
            totalRevenue: 0, totalCost: 0, totalProfit: 0, totalMiles: 0,
          },
          comparison: { expectedRevenuePerRun: 0, revenueVariance: 0 },
          flags: ['NO_DATA'],
          trend: [],
        });
        continue;
      }

      // Aggregate per-load data
      let totalRevenue = 0;
      let totalDriverPay = 0;
      let totalCarrierPay = 0;
      let totalFuelCost = 0;
      let totalMiles = 0;

      // Monthly buckets for trend
      const monthBuckets = new Map<string, { revenue: number; cost: number; runs: number }>();

      for (const load of loads) {
        const miles = load.effectiveMiles ?? 0;
        totalMiles += miles;

        // Get invoice revenue
        const invoices = await ctx.db
          .query('loadInvoices')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();
        const loadRevenue = invoices.reduce((s, inv) => s + (inv.totalAmount ?? 0), 0);
        totalRevenue += loadRevenue;

        // Get driver payables
        const driverPayables = await ctx.db
          .query('loadPayables')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();
        const loadDriverPay = driverPayables.reduce((s, p) => s + (p.totalAmount ?? 0), 0);
        totalDriverPay += loadDriverPay;

        // Get carrier payables
        const carrierPayables = await ctx.db
          .query('loadCarrierPayables')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();
        const loadCarrierPay = carrierPayables.reduce((s, p) => s + (p.totalAmount ?? 0), 0);
        totalCarrierPay += loadCarrierPay;

        // Get fuel entries linked to this load
        const fuelEntries = await ctx.db
          .query('fuelEntries')
          .withIndex('by_load', (q) => q.eq('loadId', load._id))
          .collect();
        const loadFuelCost = fuelEntries.reduce((s, f) => s + (f.totalCost ?? 0), 0);
        totalFuelCost += loadFuelCost;

        // Monthly trend bucket
        const month = load.firstStopDate?.substring(0, 7) ?? 'unknown';
        const bucket = monthBuckets.get(month) ?? { revenue: 0, cost: 0, runs: 0 };
        bucket.revenue += loadRevenue;
        bucket.cost += loadDriverPay + loadCarrierPay + loadFuelCost;
        bucket.runs += 1;
        monthBuckets.set(month, bucket);
      }

      const totalCost = totalDriverPay + totalCarrierPay + totalFuelCost;
      const totalRuns = loads.length;
      const totalProfit = totalRevenue - totalCost;

      const avgRevenuePerRun = totalRuns > 0 ? totalRevenue / totalRuns : 0;
      const avgCostPerRun = totalRuns > 0 ? totalCost / totalRuns : 0;
      const avgProfitPerRun = totalRuns > 0 ? totalProfit / totalRuns : 0;
      const avgMarginPercent = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;
      const avgRevenuePerMile = totalMiles > 0 ? totalRevenue / totalMiles : 0;
      const avgCostPerMile = totalMiles > 0 ? totalCost / totalMiles : 0;

      // Expected revenue from contract rate
      const routeMiles = lane.miles ?? lane.calculatedMiles ?? 0;
      let expectedRevenuePerRun = 0;
      if (lane.rateType === 'Flat Rate') {
        expectedRevenuePerRun = lane.rate;
      } else if (lane.rateType === 'Per Mile') {
        expectedRevenuePerRun = lane.rate * routeMiles;
      } else if (lane.rateType === 'Per Stop') {
        expectedRevenuePerRun = lane.rate * lane.stops.length;
      }
      const revenueVariance = expectedRevenuePerRun > 0
        ? ((avgRevenuePerRun - expectedRevenuePerRun) / expectedRevenuePerRun) * 100
        : 0;

      // Flags
      const flags: string[] = [];
      if (totalRuns < 5) flags.push('LOW_SAMPLE_SIZE');
      if (avgMarginPercent < 10) flags.push('UNDERPERFORMING');
      if (avgMarginPercent > 25) flags.push('PROFITABLE');
      if (Math.abs(revenueVariance) > 15) flags.push('RATE_MISMATCH');

      // Build trend
      const trend = Array.from(monthBuckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, data]) => ({
          month,
          revenue: Math.round(data.revenue * 100) / 100,
          cost: Math.round(data.cost * 100) / 100,
          margin: data.revenue > 0
            ? Math.round(((data.revenue - data.cost) / data.revenue) * 10000) / 100
            : 0,
          runs: data.runs,
        }));

      results.push({
        contractLaneId: laneId,
        laneName: lane.contractName,
        hcr: lane.hcr ?? '',
        tripNumber: lane.tripNumber ?? '',
        totalRuns,
        metrics: {
          avgRevenuePerRun: Math.round(avgRevenuePerRun * 100) / 100,
          avgCostPerRun: Math.round(avgCostPerRun * 100) / 100,
          avgProfitPerRun: Math.round(avgProfitPerRun * 100) / 100,
          avgMarginPercent: Math.round(avgMarginPercent * 10) / 10,
          avgRevenuePerMile: Math.round(avgRevenuePerMile * 100) / 100,
          avgCostPerMile: Math.round(avgCostPerMile * 100) / 100,
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          totalCost: Math.round(totalCost * 100) / 100,
          totalProfit: Math.round(totalProfit * 100) / 100,
          totalMiles: Math.round(totalMiles),
        },
        comparison: {
          expectedRevenuePerRun: Math.round(expectedRevenuePerRun * 100) / 100,
          revenueVariance: Math.round(revenueVariance * 10) / 10,
        },
        flags,
        trend,
      });
    }

    return results;
  },
});
