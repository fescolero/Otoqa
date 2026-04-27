import { getFederalHolidaysForYear } from './holidays';

// ==========================================
// LANE ANALYZER — Pure Math
// Schedule expansion, HOS analysis, cost calculations,
// adjacency graphs, multi-leg shift building.
//
// This module is ctx-free and DB-free. Every export is a pure function
// (or a value/type used by one). Convex handlers live in
// laneAnalyzerCalculations.ts and import from here.
// ==========================================

// ---- CONSTANTS ----

// FMCSA Hours of Service
const HOS = {
  MAX_DRIVE_SOLO: 11, // hours
  MAX_DUTY_SOLO: 14, // hours
  BREAK_AFTER: 8, // hours driving before mandatory 30-min break
  BREAK_DURATION: 0.5, // hours
  OFF_DUTY_REQUIRED: 10, // hours between shifts
  WEEKLY_CAP: 70, // hours in rolling 8-day window
  MAX_DRIVE_TEAM_EFFECTIVE: 20, // conservative buffer (22 theoretical)
  PRE_POST_TRIP: 1.0, // hours for pre/post-trip inspections
} as const;

// Default stop dwell time by type (hours) — overridable via session settings
const DEFAULT_STOP_DWELL: Record<string, number> = {
  APPT: 0.5,
  Live: 1.0,
  FCFS: 1.5,
};

/** Build a STOP_DWELL map from session overrides or defaults */
export function buildStopDwell(overrides?: {
  dwellTimeApptMinutes?: number;
  dwellTimeLiveMinutes?: number;
  dwellTimeFcfsMinutes?: number;
}): Record<string, number> {
  return {
    APPT: overrides?.dwellTimeApptMinutes != null ? overrides.dwellTimeApptMinutes / 60 : DEFAULT_STOP_DWELL.APPT,
    Live: overrides?.dwellTimeLiveMinutes != null ? overrides.dwellTimeLiveMinutes / 60 : DEFAULT_STOP_DWELL.Live,
    FCFS: overrides?.dwellTimeFcfsMinutes != null ? overrides.dwellTimeFcfsMinutes / 60 : DEFAULT_STOP_DWELL.FCFS,
  };
}

// State → PADD region mapping for fuel prices
const STATE_TO_PADD: Record<string, string> = {
  // PADD 1 - East Coast
  CT: 'PADD1', DC: 'PADD1', DE: 'PADD1', FL: 'PADD1', GA: 'PADD1',
  MA: 'PADD1', MD: 'PADD1', ME: 'PADD1', NC: 'PADD1', NH: 'PADD1',
  NJ: 'PADD1', NY: 'PADD1', PA: 'PADD1', RI: 'PADD1', SC: 'PADD1',
  VA: 'PADD1', VT: 'PADD1', WV: 'PADD1',
  // PADD 2 - Midwest
  IA: 'PADD2', IL: 'PADD2', IN: 'PADD2', KS: 'PADD2', KY: 'PADD2',
  MI: 'PADD2', MN: 'PADD2', MO: 'PADD2', ND: 'PADD2', NE: 'PADD2',
  OH: 'PADD2', OK: 'PADD2', SD: 'PADD2', TN: 'PADD2', WI: 'PADD2',
  // PADD 3 - Gulf Coast
  AL: 'PADD3', AR: 'PADD3', LA: 'PADD3', MS: 'PADD3', NM: 'PADD3', TX: 'PADD3',
  // PADD 4 - Rocky Mountain
  CO: 'PADD4', ID: 'PADD4', MT: 'PADD4', UT: 'PADD4', WY: 'PADD4',
  // PADD 5 - West Coast
  AK: 'PADD5', AZ: 'PADD5', CA: 'PADD5', HI: 'PADD5', NV: 'PADD5',
  OR: 'PADD5', WA: 'PADD5',
};

// ---- PURE CALCULATION FUNCTIONS ----

/**
 * Expand a schedule rule into an array of YYYY-MM-DD dates for a given year.
 * Respects active days, federal holiday exclusions, custom exclusions,
 * and optional contract period bounds.
 */
export function calculateScheduleForYear(
  scheduleRule: {
    activeDays: number[];
    excludeFederalHolidays: boolean;
    customExclusions: string[];
  },
  year: number,
  contractPeriodStart?: string,
  contractPeriodEnd?: string,
): string[] {
  if (scheduleRule.activeDays.length === 0) return [];

  const activeDaysSet = new Set(scheduleRule.activeDays);
  const customExclusionsSet = new Set(scheduleRule.customExclusions);
  const holidaySet = scheduleRule.excludeFederalHolidays
    ? new Set(getFederalHolidaysForYear(year))
    : new Set<string>();

  const dates: string[] = [];

  // Determine bounds
  const startDate = contractPeriodStart
    ? new Date(contractPeriodStart + 'T00:00:00')
    : new Date(year, 0, 1);
  const endDate = contractPeriodEnd
    ? new Date(contractPeriodEnd + 'T00:00:00')
    : new Date(year, 11, 31);

  // Clamp to analysis year
  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const effectiveStart = startDate > yearStart ? startDate : yearStart;
  const effectiveEnd = endDate < yearEnd ? endDate : yearEnd;

  const current = new Date(effectiveStart);
  while (current <= effectiveEnd) {
    const dayOfWeek = current.getDay();
    const dateStr = formatDateStr(current);

    if (
      activeDaysSet.has(dayOfWeek) &&
      !holidaySet.has(dateStr) &&
      !customExclusionsSet.has(dateStr)
    ) {
      dates.push(dateStr);
    }

    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function formatDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Analyze HOS requirements for a single route.
 * Determines if the route is feasible for a solo driver or requires a team.
 */
export function hosAnalyzeRoute(
  routeDurationHours: number,
  numStops: number,
  stopTypes?: string[],
  options?: {
    stopDwellOverrides?: Record<string, number>; // custom dwell times by type (hours)
    prePostTripHours?: number; // override for pre/post-trip (default 1.0)
    apptWindows?: Array<{ start?: string; end?: string }>; // actual time windows per stop
    useApptWindowsForDwell?: boolean;
  },
): {
  requiresTeam: boolean;
  driveTimePerRun: number;
  dutyTimePerRun: number;
  dwellTimeTotal: number;
  prePostTripTime: number;
  breaksNeeded: number;
  cycleTimeHours: number;
  maxDailyRuns: number;
  borderlineTeam: boolean;
} {
  const STOP_DWELL = options?.stopDwellOverrides ?? DEFAULT_STOP_DWELL;
  const prePostTrip = options?.prePostTripHours ?? HOS.PRE_POST_TRIP;

  // Calculate dwell time based on stop types
  let stopDwell = 0;
  if (options?.useApptWindowsForDwell && options.apptWindows && options.apptWindows.length > 0) {
    // Use actual appointment windows to estimate dwell
    for (let i = 0; i < (stopTypes?.length ?? numStops); i++) {
      const window = options.apptWindows[i];
      if (window?.start && window?.end) {
        const startH = parseTimeToHours(window.start);
        const endH = parseTimeToHours(window.end);
        if (startH !== null && endH !== null && endH > startH) {
          // Use window duration as max dwell, but at least the type default
          const windowDuration = endH - startH;
          const typeDefault = STOP_DWELL[stopTypes?.[i] ?? ''] ?? 0.75;
          stopDwell += Math.min(windowDuration, Math.max(typeDefault, 0.25));
          continue;
        }
      }
      // Fallback to type-based dwell
      stopDwell += STOP_DWELL[stopTypes?.[i] ?? ''] ?? 0.75;
    }
  } else if (stopTypes && stopTypes.length > 0) {
    for (const t of stopTypes) {
      stopDwell += STOP_DWELL[t] ?? 0.75;
    }
  } else {
    stopDwell = numStops * 0.75;
  }

  const totalDutyTime = routeDurationHours + prePostTrip + stopDwell;

  // Insert mandatory 30-min breaks
  const breaksNeeded = Math.floor(routeDurationHours / HOS.BREAK_AFTER);
  const totalDutyWithBreaks = totalDutyTime + breaksNeeded * HOS.BREAK_DURATION;

  const fitsInSoloDrive = routeDurationHours <= HOS.MAX_DRIVE_SOLO;
  const fitsInSoloDuty = totalDutyWithBreaks <= HOS.MAX_DUTY_SOLO;
  const borderlineTeam =
    fitsInSoloDrive && fitsInSoloDuty && routeDurationHours >= HOS.MAX_DRIVE_SOLO - 1;

  if (fitsInSoloDrive && fitsInSoloDuty) {
    // Solo feasible
    const cycleTime = totalDutyWithBreaks + HOS.OFF_DUTY_REQUIRED;
    const maxDailyRuns = Math.max(1, Math.floor(24 / cycleTime));

    return {
      requiresTeam: false,
      driveTimePerRun: routeDurationHours,
      dutyTimePerRun: totalDutyWithBreaks,
      dwellTimeTotal: stopDwell,
      prePostTripTime: prePostTrip,
      breaksNeeded,
      cycleTimeHours: cycleTime,
      maxDailyRuns,
      borderlineTeam,
    };
  }

  // Team required
  return {
    requiresTeam: true,
    driveTimePerRun: routeDurationHours,
    dutyTimePerRun: routeDurationHours + stopDwell,
    dwellTimeTotal: stopDwell,
    prePostTripTime: prePostTrip,
    breaksNeeded: 0,
    cycleTimeHours: routeDurationHours + stopDwell + 2,
    maxDailyRuns: 1,
    borderlineTeam: false,
  };
}

/**
 * Calculate driver pay for a single run based on pay type.
 */
export function calculateDriverPay(
  payType: 'PER_MILE' | 'PER_HOUR' | 'FLAT_PER_RUN',
  payRate: number,
  routeMiles: number,
  dutyTimeHours: number,
): number {
  switch (payType) {
    case 'PER_MILE':
      return routeMiles * payRate;
    case 'PER_HOUR':
      return dutyTimeHours * payRate;
    case 'FLAT_PER_RUN':
      return payRate;
  }
}

/**
 * Calculate fuel cost for a route.
 */
export function calculateFuelCost(
  routeMiles: number,
  mpg: number,
  fuelPricePerGallon: number,
): number {
  if (mpg <= 0) return 0;
  return (routeMiles / mpg) * fuelPricePerGallon;
}

/**
 * Calculate revenue per run including fuel surcharge and accessorials.
 */
export function calculateRevenuePerRun(entry: {
  ratePerRun?: number;
  rateType?: string;
  ratePerMile?: number;
  routeMiles?: number;
  minimumRate?: number;
  fuelSurchargeType?: string;
  fuelSurchargeValue?: number;
  stopOffRate?: number;
  includedStops?: number;
  numStops: number;
}): number {
  // Base rate
  let baseRate = 0;
  if (entry.rateType === 'Flat Rate' && entry.ratePerRun) {
    baseRate = entry.ratePerRun;
  } else if (entry.rateType === 'Per Mile' && entry.ratePerMile && entry.routeMiles) {
    baseRate = entry.ratePerMile * entry.routeMiles;
  } else if (entry.rateType === 'Per Stop') {
    baseRate = (entry.ratePerRun ?? 0) * entry.numStops;
  } else if (entry.ratePerRun) {
    baseRate = entry.ratePerRun;
  }

  // Minimum rate enforcement
  if (entry.minimumRate && baseRate < entry.minimumRate) {
    baseRate = entry.minimumRate;
  }

  // Fuel surcharge (revenue side — what customer pays)
  let fuelSurcharge = 0;
  if (entry.fuelSurchargeType && entry.fuelSurchargeValue) {
    switch (entry.fuelSurchargeType) {
      case 'PERCENTAGE':
        fuelSurcharge = baseRate * (entry.fuelSurchargeValue / 100);
        break;
      case 'FLAT':
        fuelSurcharge = entry.fuelSurchargeValue;
        break;
      case 'DOE_INDEX':
        // DOE index-based surcharge — uses the value as a per-mile surcharge
        fuelSurcharge = (entry.fuelSurchargeValue ?? 0) * (entry.routeMiles ?? 0);
        break;
    }
  }

  // Stop-off accessorials (extra stops beyond included)
  let accessorials = 0;
  const included = entry.includedStops ?? 2;
  if (entry.stopOffRate && entry.numStops > included) {
    accessorials = (entry.numStops - included) * entry.stopOffRate;
  }

  return baseRate + fuelSurcharge + accessorials;
}

/**
 * Haversine distance between two lat/lng points in miles.
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 3959; // Earth's radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Get PADD region for a US state abbreviation.
 */
export function getPaddRegion(state: string): string {
  return STATE_TO_PADD[state.toUpperCase()] ?? 'US_AVERAGE';
}

/**
 * Calculate minimum and realistic driver/truck counts for a set of lanes.
 */
export function calculateDriverCounts(
  entries: Array<{
    hosAnalysis: ReturnType<typeof hosAnalyzeRoute>;
    annualRunCount: number;
    equipmentClass?: string;
    scheduleDates: string[];
  }>,
  schedulePattern: {
    pattern: string;
    onDays: number;
    offDays: number;
  },
): {
  minDriverCount: number;
  realisticDriverCount: number;
  truckCount: number;
  truckCountByEquipment: Record<string, number>;
  peakDay: { date: string; driversNeeded: number };
} {
  // Build day → lane count map to find peak concurrency
  const dayLaneCount = new Map<string, number>();
  const dayTeamLanes = new Map<string, number>();

  for (const entry of entries) {
    for (const date of entry.scheduleDates) {
      const current = dayLaneCount.get(date) ?? 0;
      dayLaneCount.set(date, current + 1);
      if (entry.hosAnalysis.requiresTeam) {
        const currentTeam = dayTeamLanes.get(date) ?? 0;
        dayTeamLanes.set(date, currentTeam + 1);
      }
    }
  }

  // Peak day = day with most lanes running
  let peakDate = '';
  let peakCount = 0;
  for (const [date, count] of dayLaneCount) {
    const teamCount = dayTeamLanes.get(date) ?? 0;
    const driversNeeded = count + teamCount; // team lanes need 2 drivers
    if (driversNeeded > peakCount) {
      peakCount = driversNeeded;
      peakDate = date;
    }
  }

  // Minimum drivers = peak day concurrency (each lane needs 1 driver, team needs 2)
  const minDriverCount = peakCount;

  // Truck count = peak day lanes (1 truck per lane regardless of solo/team)
  const truckCount = Math.max(...Array.from(dayLaneCount.values()), 0);

  // Truck count by equipment type
  const equipmentPeaks = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const eqClass = entry.equipmentClass ?? 'Dry Van';
    for (const date of entry.scheduleDates) {
      if (!equipmentPeaks.has(date)) equipmentPeaks.set(date, new Map());
      const dayMap = equipmentPeaks.get(date)!;
      dayMap.set(eqClass, (dayMap.get(eqClass) ?? 0) + 1);
    }
  }

  const truckCountByEquipment: Record<string, number> = {};
  for (const dayMap of equipmentPeaks.values()) {
    for (const [eq, count] of dayMap) {
      truckCountByEquipment[eq] = Math.max(truckCountByEquipment[eq] ?? 0, count);
    }
  }

  // Realistic = factor in on/off pattern + relief buffer
  const availabilityRatio = schedulePattern.onDays / (schedulePattern.onDays + schedulePattern.offDays);
  const reliefBuffer = 1.15; // 15% for sick/vacation
  const realisticDriverCount = Math.ceil((minDriverCount / availabilityRatio) * reliefBuffer);

  return {
    minDriverCount,
    realisticDriverCount,
    truckCount,
    truckCountByEquipment,
    peakDay: { date: peakDate, driversNeeded: peakCount },
  };
}

/**
 * Parse schedule pattern string into on/off days.
 */
export function parseSchedulePattern(
  pattern: string,
  customOnDays?: number,
  customOffDays?: number,
): { onDays: number; offDays: number } {
  switch (pattern) {
    case '5on2off':
      return { onDays: 5, offDays: 2 };
    case '6on1off':
      return { onDays: 6, offDays: 1 };
    case '7on':
      return { onDays: 7, offDays: 0 };
    case 'custom':
      return { onDays: customOnDays ?? 5, offDays: customOffDays ?? 2 };
    default:
      return { onDays: 5, offDays: 2 };
  }
}

// ---- MULTI-LEG SHIFT BUILDER ----

/** A single edge in the adjacency graph: "after finishing lane A, lane B can follow" */
interface LaneEdge {
  fromId: string;
  toId: string;
  deadheadMiles: number;
  deadheadDriveHours: number;
}

/** A driver shift = ordered list of lane IDs the driver runs in one day */
export interface DriverShift {
  legs: string[];
  totalDriveHours: number;
  totalDutyHours: number; // includes wait time — it's on-duty
  totalMiles: number;
  totalDeadheadMiles: number;
  /** Total wait/idle time between legs (included in duty) */
  totalWaitHours?: number;
  /** Base the driver returns to after shift */
  baseName?: string | null;
  /** Miles from last leg destination back to base */
  returnToBaseMiles?: number;
  /** Drive hours from last leg destination back to base */
  returnToBaseDriveHours?: number;
  /** Drive hours from base to first pickup (included in totalDriveHours) */
  fromBaseDriveHours?: number;
  /** Per-leg gap details for display */
  legGaps?: Array<{
    miles: number;
    driveHours: number;
    waitHours: number;
  }>;
}

/** Input entry for the shift builder */
export interface ShiftBuilderEntry {
  id: string;
  originCity: string;
  originState: string;
  originLat?: number;
  originLng?: number;
  destCity: string;
  destState: string;
  destLat?: number;
  destLng?: number;
  routeDurationHours: number;
  routeMiles: number;
  scheduleDates: string[];
  hosAnalysis: ReturnType<typeof hosAnalyzeRoute>;
  originApptType?: string;
  destApptType?: string;
  originScheduledTime?: string;
  destScheduledTime?: string;
  originScheduledEndTime?: string;
  destScheduledEndTime?: string;
}

/**
 * Build an adjacency graph: for each lane, which other lanes can follow it?
 * Criteria: lane A's dest is near lane B's origin (within maxDeadhead miles)
 */
export function buildAdjacencyGraph(
  entries: ShiftBuilderEntry[],
  maxDeadheadMiles: number,
): Map<string, LaneEdge[]> {
  const graph = new Map<string, LaneEdge[]>();

  for (const from of entries) {
    const edges: LaneEdge[] = [];
    for (const to of entries) {
      if (from.id === to.id) continue;

      let deadheadMiles = 0;
      if (from.destLat && from.destLng && to.originLat && to.originLng) {
        deadheadMiles = haversineDistance(from.destLat, from.destLng, to.originLat, to.originLng);
      } else {
        // Fallback: city+state string match = 0 deadhead, otherwise skip
        const destKey = `${from.destCity.toLowerCase()},${from.destState.toLowerCase()}`;
        const origKey = `${to.originCity.toLowerCase()},${to.originState.toLowerCase()}`;
        if (destKey !== origKey) continue;
      }

      if (deadheadMiles > maxDeadheadMiles) continue;

      edges.push({
        fromId: from.id,
        toId: to.id,
        deadheadMiles,
        deadheadDriveHours: deadheadMiles / 55,
      });
    }

    // Sort edges: prefer short deadhead (closer destinations first)
    edges.sort((a, b) => a.deadheadMiles - b.deadheadMiles);
    graph.set(from.id, edges);
  }

  return graph;
}

/** Find the nearest base to a lat/lng point */
function findNearestBase(lat: number, lng: number, bases: BaseLocation[]): { base: BaseLocation; distMiles: number } | null {
  if (bases.length === 0) return null;
  let best: { base: BaseLocation; distMiles: number } | null = null;
  for (const base of bases) {
    const d = haversineDistance(lat, lng, base.lat, base.lng);
    if (!best || d < best.distMiles) {
      best = { base, distMiles: d };
    }
  }
  return best;
}

/** Find nearest base by city/state name matching (fallback when no coords) */
function findNearestBaseByCity(
  city: string,
  state: string,
  bases: BaseLocation[],
): { base: BaseLocation; distMiles: number } | null {
  if (bases.length === 0) return null;
  const cityNorm = city.toLowerCase().trim();
  const stateNorm = state.toLowerCase().trim();

  // Exact city+state match
  for (const base of bases) {
    if (base.city.toLowerCase().trim() === cityNorm && base.state.toLowerCase().trim() === stateNorm) {
      return { base, distMiles: 0 };
    }
  }

  // Same state match (pick first in same state)
  for (const base of bases) {
    if (base.state.toLowerCase().trim() === stateNorm) {
      return { base, distMiles: 50 }; // estimate — same state but different city
    }
  }

  // No match — return first base with a large estimated distance
  return { base: bases[0], distMiles: 200 };
}

/** Check if a lane's destination is within return distance of a base */
function isReturnableToBase(
  entry: ShiftBuilderEntry,
  baseLat: number,
  baseLng: number,
  maxReturnMiles: number = MAX_RETURN_TO_BASE_MILES,
  baseCity?: string,
  baseState?: string,
): { canReturn: boolean; returnMiles: number; returnDriveHours: number } {
  const destLat = entry.destLat;
  const destLng = entry.destLng;

  // If we have coordinates on BOTH sides, use haversine distance
  if (destLat != null && destLng != null && baseLat !== 0 && baseLng !== 0) {
    const dist = haversineDistance(destLat, destLng, baseLat, baseLng);
    return {
      canReturn: dist <= maxReturnMiles,
      returnMiles: dist,
      returnDriveHours: dist / 55,
    };
  }

  // NO COORDINATES — fall back to city/state matching
  // If destination city matches the base city, assume returnable
  if (baseCity && baseState) {
    const destCityNorm = entry.destCity.toLowerCase().trim();
    const destStateNorm = entry.destState.toLowerCase().trim();
    const baseCityNorm = baseCity.toLowerCase().trim();
    const baseStateNorm = baseState.toLowerCase().trim();

    if (destCityNorm === baseCityNorm && destStateNorm === baseStateNorm) {
      return { canReturn: true, returnMiles: 0, returnDriveHours: 0 };
    }

    // Different city — assume NOT returnable (conservative)
    // Estimate distance based on known route miles as heuristic
    return { canReturn: false, returnMiles: 999, returnDriveHours: 999 / 55 };
  }

  // No coords AND no base city — assume NOT returnable (safe default)
  return { canReturn: false, returnMiles: 999, returnDriveHours: 999 / 55 };
}

/** Same-city commute buffer in hours (15 min) */
const SAME_CITY_COMMUTE_HOURS = 0.25;

/** Calculate deadhead drive hours from a base to a lane's origin, or from a lane's dest back to base */
function baseDeadheadHours(
  pointLat: number | undefined,
  pointLng: number | undefined,
  pointCity: string,
  pointState: string,
  baseLat: number | null,
  baseLng: number | null,
  baseCity: string | null,
  baseState: string | null,
): number {
  // ALWAYS check city match first — same city = small fixed commute, not haversine
  if (baseCity && baseState) {
    const pCity = pointCity.toLowerCase().trim();
    const pState = pointState.toLowerCase().trim();
    if (pCity === baseCity.toLowerCase().trim() && pState === baseState.toLowerCase().trim()) {
      return SAME_CITY_COMMUTE_HOURS; // 15 min within same city
    }
  }

  // Different city: use coordinates if both sides have them
  if (pointLat != null && pointLng != null && baseLat != null && baseLat !== 0 && baseLng != null && baseLng !== 0) {
    const dist = haversineDistance(pointLat, pointLng, baseLat, baseLng);
    // If very close (under 10mi), treat as same area — small commute
    if (dist <= 10) return SAME_CITY_COMMUTE_HOURS;
    return dist / 55; // assume 55mph deadhead
  }

  // Different city, no coords — estimate based on whether same state
  if (baseState && pointState.toLowerCase().trim() === baseState.toLowerCase().trim()) {
    return 0.75; // same state, different city — ~45 min estimate
  }
  return 1.0; // different state — 1h estimate
}

/** Max idle wait time between legs before it's considered inefficient (hours) */
export const MAX_WAIT_BETWEEN_LEGS = 3.0;

/**
 * Check if adding a new leg to a shift is HOS-feasible AND time-efficient.
 *
 * Tracks the clock: what time does the driver finish the current leg, what time
 * does the next pickup start, and is the gap acceptable?
 *
 * Returns updated totals + the new clock-out time, or null if infeasible.
 */
function canAddLeg(
  currentDrive: number,
  currentDuty: number,
  currentClockTime: number | null, // clock time when driver finishes current leg (hours from midnight)
  nextEntry: ShiftBuilderEntry,
  deadheadDriveHours: number,
  prePostTripHours: number,
  isFirstLeg: boolean,
  maxWaitHours: number,
): {
  newDrive: number;
  newDuty: number;
  newClockTime: number | null;
  waitTime: number;
} | null {
  const legDrive = nextEntry.routeDurationHours + deadheadDriveHours;
  const legDwell = nextEntry.hosAnalysis.dwellTimeTotal ?? 0;
  const legDuty = legDrive + legDwell + (isFirstLeg ? prePostTripHours : 0);

  // --- Parse next leg's times ---
  const nextPickupStart = nextEntry.originScheduledTime
    ? parseTimeToHours(nextEntry.originScheduledTime)
    : null;
  const nextPickupEnd = nextEntry.originScheduledEndTime
    ? parseTimeToHours(nextEntry.originScheduledEndTime)
    : null;
  const nextDeliveryEnd = nextEntry.destScheduledEndTime
    ? parseTimeToHours(nextEntry.destScheduledEndTime)
    : (nextEntry.destScheduledTime ? parseTimeToHours(nextEntry.destScheduledTime) : null);

  // --- Clock time / wait time check ---
  let waitTime = 0;
  let legStartClock: number | null = null;

  if (currentClockTime !== null) {
    // When could the driver arrive at the next origin?
    const earliestArrival = currentClockTime + deadheadDriveHours;

    if (nextPickupStart !== null) {
      // The pickup window: from nextPickupStart to nextPickupEnd (or +15min if no end)
      // The driver can arrive any time during this window and still load successfully.
      // Add a grace buffer: driver arriving within the dwell/loading time is acceptable
      // because loading starts when they arrive, not at the window start.
      const ARRIVAL_GRACE_MINUTES = 15; // driver can arrive up to 15 min into loading
      const pickupWindowEnd = nextPickupEnd ?? (nextPickupStart + ARRIVAL_GRACE_MINUTES / 60);

      // HARD CHECK: driver must arrive before the pickup window closes + grace
      if (earliestArrival > pickupWindowEnd + (ARRIVAL_GRACE_MINUTES / 60)) {
        return null; // can't make the pickup window even with grace
      }

      // HARD CHECK: next leg's pickup must start AFTER previous leg finishes
      if (nextPickupStart < currentClockTime && deadheadDriveHours === 0) {
        if (currentClockTime - nextPickupStart > 0.25) {
          return null;
        }
      }

      if (earliestArrival < nextPickupStart) {
        waitTime = nextPickupStart - earliestArrival;
        if (waitTime > maxWaitHours) {
          return null; // too much idle time
        }
        legStartClock = nextPickupStart;
      } else {
        // Driver arrives during the pickup window — they start loading on arrival
        legStartClock = earliestArrival;
      }
    } else {
      // No appointment time on next leg — must still be after current clock
      legStartClock = earliestArrival;
    }
  } else if (nextPickupStart !== null) {
    // No clock from previous leg, but next leg has appointment time
    // Use the pickup time as the clock start
    legStartClock = nextPickupStart;
  }

  // --- HOS check ---
  const totalNewDuty = currentDuty + legDuty + waitTime;
  const totalNewDrive = currentDrive + legDrive;

  const breaksNeeded = Math.floor(totalNewDrive / HOS.BREAK_AFTER);
  const dutyWithBreaks = totalNewDuty + breaksNeeded * HOS.BREAK_DURATION;

  if (totalNewDrive > HOS.MAX_DRIVE_SOLO) return null;
  if (dutyWithBreaks > HOS.MAX_DUTY_SOLO) return null;

  // --- Calculate when this leg finishes ---
  // Use the LATER of: (computed arrival) or (scheduled delivery time)
  // This ensures the clock reflects reality — if delivery is at 13:00 but
  // driver arrives at 12:00, they're there until 13:00.
  let newClockTime: number | null = null;
  if (legStartClock !== null) {
    const computedFinish = legStartClock + legDwell + nextEntry.routeDurationHours;
    if (nextDeliveryEnd !== null && nextDeliveryEnd > computedFinish) {
      // Delivery window ends later than computed — driver waits at destination
      newClockTime = nextDeliveryEnd;
    } else {
      newClockTime = computedFinish;
    }
  }

  return {
    newDrive: totalNewDrive,
    newDuty: dutyWithBreaks,
    newClockTime,
    waitTime,
  };
}

/**
 * For a single day, build driver shifts by greedily chaining lanes.
 *
 * Algorithm:
 * 1. Get all lanes running today, sorted by pickup time
 * 2. For each unassigned lane, start a new shift
 * 3. After each leg, find the BEST next leg: closest geographically,
 *    fits in HOS, and has minimal wait time
 * 4. Reject any leg that would leave the driver idle > MAX_WAIT hours
 * 5. A lane is only chained if it's genuinely efficient — otherwise
 *    it becomes a separate shift for a different driver
 */
/** Minimum duty hours before a shift is considered "underutilized" and eligible for merging */
const MIN_EFFICIENT_DUTY_HOURS = 8.0;

// ---- SHIFT STATE for the optimizer ----

interface ShiftState {
  shift: DriverShift;
  lastLaneId: string;
  clockTime: number | null;
  /** Base location the driver returns to (lat/lng). Null if no base assigned. */
  baseLat: number | null;
  baseLng: number | null;
  baseName: string | null;
  baseCity: string | null;
  baseState: string | null;
  /** Drive hours from base to first pickup (included in shift duty) */
  deadheadFromBaseHours: number;
  /** Current estimated drive hours from last leg's destination back to base */
  deadheadToBaseHours: number;
}

/**
 * Score a candidate assignment of a lane to a shift (or as a new shift).
 * LOWER score = BETTER assignment.
 *
 * The scoring function balances:
 * - Minimizing total shifts (driver count) — heavily penalize new shifts
 * - Minimizing wait time — idle drivers are wasteful
 * - Minimizing deadhead — empty miles cost fuel + driver pay
 * - Maximizing HOS utilization — prefer filling shifts closer to capacity
 */
function scoreAssignment(
  isNewShift: boolean,
  waitTime: number,
  deadheadMiles: number,
  resultingDutyHours: number,
  shiftLegCount: number,
): number {
  // Heavy penalty for creating a new shift (new driver needed)
  const newShiftPenalty = isNewShift ? 1000 : 0;

  // Prefer extending shifts that are already underutilized
  const utilizationBonus = isNewShift ? 0 : -Math.min(resultingDutyHours / 14, 1) * 50;

  // Penalize wait time (each hour of wait = 10 penalty points)
  const waitPenalty = waitTime * 10;

  // Penalize deadhead (each mile = 0.5 penalty)
  const deadheadPenalty = deadheadMiles * 0.5;

  // Bonus for filling underutilized shifts (< 6h duty)
  const fillBonus = (!isNewShift && resultingDutyHours < MIN_EFFICIENT_DUTY_HOURS)
    ? -20 * shiftLegCount
    : 0;

  return newShiftPenalty + utilizationBonus + waitPenalty + deadheadPenalty + fillBonus;
}

/**
 * Build driver shifts for a single day using a global scoring optimizer.
 *
 * Instead of greedy pickup-time-first, this:
 * 1. Seeds one shift per lane (all lanes need to be covered)
 * 2. On each iteration, finds the GLOBALLY BEST lane→shift assignment
 *    across ALL unassigned lanes and ALL open shifts
 * 3. Compares "extend existing shift" vs "create new shift" using a scoring function
 * 4. Repeats until all lanes are assigned
 * 5. Pass 2: consolidation — tries to merge any remaining short shifts
 */
interface BaseLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
  city: string;
  state: string;
}

/** Max distance (miles) the last leg's destination can be from the base for return-to-base check */
const MAX_RETURN_TO_BASE_MILES = 80;

export function buildShiftsForDay(
  lanesRunningToday: ShiftBuilderEntry[],
  graph: Map<string, LaneEdge[]>,
  maxLegs: number,
  prePostTripHours: number,
  maxWaitHours: number = MAX_WAIT_BETWEEN_LEGS,
  weeklyDutyCeiling: number = 14,
  bases: BaseLocation[] = [],
  multiSeed: boolean = false,
): DriverShift[] {
  if (lanesRunningToday.length === 0) return [];

  const sorted = [...lanesRunningToday].sort((a, b) => {
    const aTime = a.originScheduledTime ? (parseTimeToHours(a.originScheduledTime) ?? 99) : 99;
    const bTime = b.originScheduledTime ? (parseTimeToHours(b.originScheduledTime) ?? 99) : 99;
    return aTime - bTime;
  });

  // Fast path: single seed (used for most days in the year)
  if (!multiSeed || lanesRunningToday.length <= 4) {
    return _buildShiftsForDaySingleSeed(
      lanesRunningToday, sorted, sorted[0], graph, maxLegs, prePostTripHours,
      maxWaitHours, weeklyDutyCeiling, bases,
    );
  }

  // Multi-seed optimization: only for peak days
  // Try different starting lanes and pick the result with fewest drivers
  const seedCandidates: ShiftBuilderEntry[] = [sorted[0]];
  const seen = new Set<string>([sorted[0].id]);

  // Add middle, last, and evenly spaced
  const indices = [
    Math.floor(sorted.length / 4),
    Math.floor(sorted.length / 2),
    Math.floor(sorted.length * 3 / 4),
    sorted.length - 1,
  ];
  for (const idx of indices) {
    if (idx > 0 && idx < sorted.length && !seen.has(sorted[idx].id)) {
      seedCandidates.push(sorted[idx]);
      seen.add(sorted[idx].id);
    }
    if (seedCandidates.length >= 5) break;
  }

  let bestResult: DriverShift[] | null = null;
  let bestDriverCount = Infinity;

  for (const seed of seedCandidates) {
    const result = _buildShiftsForDaySingleSeed(
      lanesRunningToday, sorted, seed, graph, maxLegs, prePostTripHours,
      maxWaitHours, weeklyDutyCeiling, bases,
    );
    if (result.length < bestDriverCount) {
      bestDriverCount = result.length;
      bestResult = result;
    }
    if (bestDriverCount <= Math.ceil(lanesRunningToday.length / maxLegs)) break;
  }

  return bestResult ?? [];
}

function _buildShiftsForDaySingleSeed(
  lanesRunningToday: ShiftBuilderEntry[],
  sorted: ShiftBuilderEntry[],
  seedLane: ShiftBuilderEntry,
  graph: Map<string, LaneEdge[]>,
  maxLegs: number,
  prePostTripHours: number,
  maxWaitHours: number,
  weeklyDutyCeiling: number,
  bases: BaseLocation[],
): DriverShift[] {
  const laneMap = new Map(lanesRunningToday.map((l) => [l.id, l]));
  const assigned = new Set<string>();
  const openShifts: ShiftState[] = [];

  // Seed with the given starting lane
  const firstLane = seedLane;
  assigned.add(firstLane.id);
  const pickupTime = firstLane.originScheduledTime ? parseTimeToHours(firstLane.originScheduledTime) : null;
  const dwell = firstLane.hosAnalysis.dwellTimeTotal ?? 0;
  // Clock = when driver finishes this leg. Use delivery end time if available,
  // otherwise compute from pickup + dwell + drive.
  const firstDeliveryEnd = firstLane.destScheduledEndTime
    ? parseTimeToHours(firstLane.destScheduledEndTime)
    : (firstLane.destScheduledTime ? parseTimeToHours(firstLane.destScheduledTime) : null);
  const computedFinish = pickupTime !== null ? pickupTime + dwell + firstLane.routeDurationHours : null;
  const firstLegClock = firstDeliveryEnd !== null && computedFinish !== null
    ? Math.max(firstDeliveryEnd, computedFinish)
    : (firstDeliveryEnd ?? computedFinish);

  // Assign nearest base for this driver's shift
  // Try geocoded coords first, fall back to city/state matching
  const firstBase = (firstLane.originLat != null && firstLane.originLng != null)
    ? findNearestBase(firstLane.originLat, firstLane.originLng, bases)
    : findNearestBaseByCity(firstLane.originCity, firstLane.originState, bases);

  // Calculate deadhead FROM base TO first pickup
  const dhFromBase = firstBase ? baseDeadheadHours(
    firstLane.originLat, firstLane.originLng, firstLane.originCity, firstLane.originState,
    firstBase.base.lat, firstBase.base.lng, firstBase.base.city, firstBase.base.state,
  ) : 0;
  // Calculate deadhead FROM first lane's destination back TO base (for return reservation)
  const dhToBase = firstBase ? baseDeadheadHours(
    firstLane.destLat, firstLane.destLng, firstLane.destCity, firstLane.destState,
    firstBase.base.lat, firstBase.base.lng, firstBase.base.city, firstBase.base.state,
  ) : 0;

  openShifts.push({
    shift: {
      legs: [firstLane.id],
      totalDriveHours: firstLane.routeDurationHours + dhFromBase,
      totalDutyHours: firstLane.hosAnalysis.dutyTimePerRun + dhFromBase,
      totalMiles: firstLane.routeMiles + (dhFromBase * 55),
      totalDeadheadMiles: dhFromBase * 55,
    },
    lastLaneId: firstLane.id,
    clockTime: firstLegClock,
    baseLat: firstBase?.base.lat ?? null,
    baseLng: firstBase?.base.lng ?? null,
    baseName: firstBase?.base.name ?? null,
    baseCity: firstBase?.base.city ?? null,
    baseState: firstBase?.base.state ?? null,
    deadheadFromBaseHours: dhFromBase,
    deadheadToBaseHours: dhToBase,
  });

  // ---- MAIN LOOP: assign all remaining lanes ----
  // Each iteration picks the single best global assignment

  let safety = 0;
  const maxIterations = lanesRunningToday.length * 2; // prevent infinite loops

  while (assigned.size < lanesRunningToday.length && safety++ < maxIterations) {
    let bestAssignment: {
      laneId: string;
      shiftIdx: number; // -1 = create new shift
      score: number;
      result: NonNullable<ReturnType<typeof canAddLeg>> | null;
      edge: LaneEdge | null;
    } | null = null;

    // For each unassigned lane, evaluate all possible placements
    for (const lane of sorted) {
      if (assigned.has(lane.id)) continue;

      // Option A: Extend each existing open shift
      for (let si = 0; si < openShifts.length; si++) {
        const s = openShifts[si];
        if (s.shift.legs.length >= maxLegs) continue;

        const edges = graph.get(s.lastLaneId) ?? [];
        const edge = edges.find((e) => e.toId === lane.id);
        if (!edge) continue; // not geographically connected

        // Calculate return-to-base hours if this leg were the last one
        const candidateReturnHours = (s.baseLat != null || s.baseCity != null)
          ? baseDeadheadHours(
              lane.destLat, lane.destLng, lane.destCity, lane.destState,
              s.baseLat, s.baseLng, s.baseCity, s.baseState,
            )
          : 0;

        // Adaptive wait: allow longer waits for underutilized shifts
        // A shift with 3h duty has 11h remaining — it can afford a long wait
        // A shift with 12h duty should NOT wait long — it's nearly full
        const effectiveMaxWait = s.shift.totalDutyHours < MIN_EFFICIENT_DUTY_HOURS
          ? Math.max(maxWaitHours, 5.0) // underutilized: up to 5h wait
          : maxWaitHours;

        const result = canAddLeg(
          s.shift.totalDriveHours,
          s.shift.totalDutyHours,
          s.clockTime,
          lane,
          edge.deadheadDriveHours,
          prePostTripHours,
          false,
          effectiveMaxWait,
        );
        if (!result) continue;

        // RETURN-TO-BASE CHECK 1: distance check — is the destination even near the base?
        if (s.baseLat != null && s.baseLng != null || s.baseCity != null) {
          const returnCheck = isReturnableToBase(
            lane, s.baseLat ?? 0, s.baseLng ?? 0,
            MAX_RETURN_TO_BASE_MILES,
            s.baseCity ?? undefined, s.baseState ?? undefined,
          );
          if (!returnCheck.canReturn) {
            continue; // HARD REJECT — driver would be stranded far from base
          }
        }

        // RETURN-TO-BASE CHECK 2: HOS reservation — does the driver have enough
        // drive/duty hours left to get back to base AFTER this leg?
        if (candidateReturnHours > 0) {
          const driveWithReturn = result.newDrive + candidateReturnHours;
          const dutyWithReturn = result.newDuty + candidateReturnHours;
          if (driveWithReturn > HOS.MAX_DRIVE_SOLO || dutyWithReturn > HOS.MAX_DUTY_SOLO) {
            continue; // REJECT — driver can't make it back to base within HOS
          }
        }

        const score = scoreAssignment(
          false,
          result.waitTime,
          edge.deadheadMiles,
          result.newDuty,
          s.shift.legs.length + 1,
        );

        if (!bestAssignment || score < bestAssignment.score) {
          bestAssignment = { laneId: lane.id, shiftIdx: si, score, result, edge };
        }
      }

      // Option B: Create a new shift (always possible, but penalized)
      const newShiftScore = scoreAssignment(true, 0, 0, lane.hosAnalysis.dutyTimePerRun, 1);

      if (!bestAssignment || newShiftScore < bestAssignment.score) {
        bestAssignment = { laneId: lane.id, shiftIdx: -1, score: newShiftScore, result: null, edge: null };
      }
    }

    if (!bestAssignment) break; // shouldn't happen, but safety

    const lane = laneMap.get(bestAssignment.laneId)!;
    assigned.add(bestAssignment.laneId);

    if (bestAssignment.shiftIdx === -1) {
      // Create new shift — clock set to when this leg actually finishes
      const pt = lane.originScheduledTime ? parseTimeToHours(lane.originScheduledTime) : null;
      const dw = lane.hosAnalysis.dwellTimeTotal ?? 0;
      const delEnd = lane.destScheduledEndTime
        ? parseTimeToHours(lane.destScheduledEndTime)
        : (lane.destScheduledTime ? parseTimeToHours(lane.destScheduledTime) : null);
      const compFinish = pt !== null ? pt + dw + lane.routeDurationHours : null;
      const newClock = delEnd !== null && compFinish !== null
        ? Math.max(delEnd, compFinish)
        : (delEnd ?? compFinish);

      // Assign nearest base for this new shift (coords or city fallback)
      const newBase = (lane.originLat != null && lane.originLng != null)
        ? findNearestBase(lane.originLat, lane.originLng, bases)
        : findNearestBaseByCity(lane.originCity, lane.originState, bases);

      // Calculate base deadhead (from base → first pickup, and last delivery → base)
      const newDhFrom = newBase ? baseDeadheadHours(
        lane.originLat, lane.originLng, lane.originCity, lane.originState,
        newBase.base.lat, newBase.base.lng, newBase.base.city, newBase.base.state,
      ) : 0;
      const newDhTo = newBase ? baseDeadheadHours(
        lane.destLat, lane.destLng, lane.destCity, lane.destState,
        newBase.base.lat, newBase.base.lng, newBase.base.city, newBase.base.state,
      ) : 0;

      openShifts.push({
        shift: {
          legs: [lane.id],
          totalDriveHours: lane.routeDurationHours + newDhFrom,
          totalDutyHours: lane.hosAnalysis.dutyTimePerRun + newDhFrom,
          totalMiles: lane.routeMiles + (newDhFrom * 55),
          totalDeadheadMiles: newDhFrom * 55,
        },
        lastLaneId: lane.id,
        clockTime: newClock,
        baseLat: newBase?.base.lat ?? null,
        baseLng: newBase?.base.lng ?? null,
        baseName: newBase?.base.name ?? null,
        baseCity: newBase?.base.city ?? null,
        baseState: newBase?.base.state ?? null,
        deadheadFromBaseHours: newDhFrom,
        deadheadToBaseHours: newDhTo,
      });
    } else {
      // Extend existing shift
      const s = openShifts[bestAssignment.shiftIdx];
      const result = bestAssignment.result!;
      const edge = bestAssignment.edge!;

      s.shift.legs.push(lane.id);
      s.shift.totalDriveHours = result.newDrive;
      s.shift.totalDutyHours = result.newDuty;
      s.shift.totalMiles += lane.routeMiles + edge.deadheadMiles;
      s.shift.totalDeadheadMiles += edge.deadheadMiles;
      s.shift.totalWaitHours = (s.shift.totalWaitHours ?? 0) + result.waitTime;
      if (!s.shift.legGaps) s.shift.legGaps = [];
      s.shift.legGaps.push({
        miles: edge.deadheadMiles,
        driveHours: edge.deadheadDriveHours,
        waitHours: result.waitTime,
      });
      s.lastLaneId = lane.id;
      s.clockTime = result.newClockTime;

      // Recalculate return-to-base hours for the new last leg
      if (s.baseLat != null || s.baseCity != null) {
        s.deadheadToBaseHours = baseDeadheadHours(
          lane.destLat, lane.destLng, lane.destCity, lane.destState,
          s.baseLat, s.baseLng, s.baseCity, s.baseState,
        );
      }
    }
  }

  // ---- PASS 2: Aggressively consolidate underutilized shifts ----
  // Uses relaxed wait time (up to 6h) for merging — it's cheaper to have
  // one driver wait than to hire a second driver for a single run.
  // Tries BOTH directions: donor-after-receiver AND donor-before-receiver.
  const MERGE_MAX_WAIT = Math.max(maxWaitHours, 6.0); // at least 6h for consolidation

  const mergedIndices = new Set<number>();

  // Sort shifts by duty (shortest first) — merge the smallest shifts first
  const sortedByDuty = openShifts
    .map((s, i) => ({ s, i }))
    .filter((x) => x.s.shift.totalDutyHours < MIN_EFFICIENT_DUTY_HOURS)
    .sort((a, b) => a.s.shift.totalDutyHours - b.s.shift.totalDutyHours);

  /** Try merging donor legs onto the end of receiver shift */
  function tryMergeAppend(
    receiver: ShiftState, donor: ShiftState,
  ): { feasible: boolean; drive: number; duty: number; clock: number | null; edgeMiles: number } | null {
    if (receiver.shift.legs.length + donor.shift.legs.length > maxLegs) return null;

    const edges = graph.get(receiver.lastLaneId) ?? [];
    const edge = edges.find((e) => e.toId === donor.shift.legs[0]);
    if (!edge) return null;

    let testDrive = receiver.shift.totalDriveHours;
    let testDuty = receiver.shift.totalDutyHours;
    let testClock = receiver.clockTime;

    for (let i = 0; i < donor.shift.legs.length; i++) {
      const legEntry = laneMap.get(donor.shift.legs[i]);
      if (!legEntry) return null;
      const connectEdge = i === 0 ? edge : (graph.get(donor.shift.legs[i - 1]) ?? []).find((e) => e.toId === donor.shift.legs[i]);
      const dhH = connectEdge?.deadheadDriveHours ?? 0;
      const result = canAddLeg(testDrive, testDuty, testClock, legEntry, dhH, prePostTripHours, false, MERGE_MAX_WAIT);
      if (!result) return null;

      // Also check return-to-base HOS reservation for the last leg
      if (i === donor.shift.legs.length - 1 && (receiver.baseLat != null || receiver.baseCity != null)) {
        const retH = baseDeadheadHours(
          legEntry.destLat, legEntry.destLng, legEntry.destCity, legEntry.destState,
          receiver.baseLat, receiver.baseLng, receiver.baseCity, receiver.baseState,
        );
        if (retH > 0 && (result.newDrive + retH > HOS.MAX_DRIVE_SOLO || result.newDuty + retH > HOS.MAX_DUTY_SOLO)) return null;
      }

      testDrive = result.newDrive;
      testDuty = result.newDuty;
      testClock = result.newClockTime;
    }

    // Return-to-base distance check
    if (receiver.baseLat != null || receiver.baseCity != null) {
      const lastLane = laneMap.get(donor.lastLaneId);
      if (lastLane) {
        const rtb = isReturnableToBase(lastLane, receiver.baseLat ?? 0, receiver.baseLng ?? 0, MAX_RETURN_TO_BASE_MILES, receiver.baseCity ?? undefined, receiver.baseState ?? undefined);
        if (!rtb.canReturn) return null;
      }
    }

    return { feasible: true, drive: testDrive, duty: testDuty, clock: testClock, edgeMiles: edge.deadheadMiles };
  }

  for (const { s: donor, i: donorIdx } of sortedByDuty) {
    if (mergedIndices.has(donorIdx)) continue;

    let bestReceiver: { idx: number; drive: number; duty: number; clock: number | null; edgeMiles: number; reverse: boolean } | null = null;
    let bestScore = Infinity;

    for (let ri = 0; ri < openShifts.length; ri++) {
      if (ri === donorIdx || mergedIndices.has(ri)) continue;
      const receiver = openShifts[ri];

      // Direction 1: append donor after receiver
      const fwd = tryMergeAppend(receiver, donor);
      if (fwd) {
        const score = fwd.duty; // prefer the combination with lowest total duty (most efficient)
        if (score < bestScore) {
          bestScore = score;
          bestReceiver = { idx: ri, ...fwd, reverse: false };
        }
      }

      // Direction 2: append receiver after donor (donor becomes the "base" shift)
      const rev = tryMergeAppend(donor, receiver);
      if (rev) {
        const score = rev.duty;
        if (score < bestScore) {
          bestScore = score;
          bestReceiver = { idx: ri, reverse: true, ...rev };
        }
      }
    }

    if (bestReceiver) {
      const ri = bestReceiver.idx;
      if (bestReceiver.reverse) {
        // Donor is the base, receiver legs appended to donor
        const receiver = openShifts[ri];
        for (const legId of receiver.shift.legs) donor.shift.legs.push(legId);
        donor.shift.totalDriveHours = bestReceiver.drive;
        donor.shift.totalDutyHours = bestReceiver.duty;
        donor.shift.totalMiles += receiver.shift.totalMiles + bestReceiver.edgeMiles;
        donor.shift.totalDeadheadMiles += receiver.shift.totalDeadheadMiles + bestReceiver.edgeMiles;
        donor.lastLaneId = receiver.lastLaneId;
        donor.clockTime = bestReceiver.clock;
        donor.deadheadToBaseHours = receiver.deadheadToBaseHours;
        mergedIndices.add(ri);
      } else {
        // Receiver is the base, donor legs appended to receiver
        const receiver = openShifts[ri];
        for (const legId of donor.shift.legs) receiver.shift.legs.push(legId);
        receiver.shift.totalDriveHours = bestReceiver.drive;
        receiver.shift.totalDutyHours = bestReceiver.duty;
        receiver.shift.totalMiles += donor.shift.totalMiles + bestReceiver.edgeMiles;
        receiver.shift.totalDeadheadMiles += donor.shift.totalDeadheadMiles + bestReceiver.edgeMiles;
        receiver.lastLaneId = donor.lastLaneId;
        receiver.clockTime = bestReceiver.clock;
        receiver.deadheadToBaseHours = donor.deadheadToBaseHours;
        mergedIndices.add(donorIdx);
      }
    }
  }

  // After Pass 2, collect surviving shifts
  const afterPass2 = openShifts.filter((_, i) => !mergedIndices.has(i));

  // ---- PASS 3: Cost-Based Weekly HOS Decision ----
  //
  // The engine does NOT blindly rebalance. It simulates both options and picks cheaper:
  //
  // OPTION A — Keep heavy shifts, add weekly relief drivers:
  //   Heavy-shift drivers hit 70h before completing on-cycle.
  //   1 relief driver can cover ~(daysUntilCap) heavy-shift drivers' restart days.
  //   Example: ceiling day = 5.2, so each heavy driver misses ~0.8 days/cycle.
  //   1 relief driver covers ~6 heavy drivers (works their missed days).
  //   Cost: fewer daily shifts, but relief drivers on payroll.
  //
  // OPTION B — Rebalance: split heavy shifts to stay under ceiling.
  //   More daily shifts (more drivers per day), but all complete the on-cycle.
  //   Zero relief needed.
  //   Cost: more daily drivers, but no weekly relief overhead.
  //
  // The engine picks whichever results in fewer TOTAL drivers on payroll.

  if (weeklyDutyCeiling < 14) {
    // Count heavy shifts (over ceiling) and calculate Option A cost
    const heavyShifts = afterPass2.filter(
      (s) => s.shift.totalDutyHours > weeklyDutyCeiling && s.shift.legs.length > 1,
    );
    const heavyCount = heavyShifts.length;

    if (heavyCount > 0) {
      // Option A: how many relief drivers for the heavy shifts?
      const avgHeavyDuty = heavyShifts.reduce((s, h) => s + h.shift.totalDutyHours, 0) / heavyCount;
      const daysUntilCapForHeavy = HOS.WEEKLY_CAP / avgHeavyDuty;
      // Each heavy driver misses (onDays - daysUntilCap) days per cycle
      // One relief driver can cover (daysUntilCap) different heavy drivers
      // (they work one restart-day each for different drivers)
      const onDays = weeklyDutyCeiling < 14 ? Math.round(HOS.WEEKLY_CAP / weeklyDutyCeiling) : 5;
      const reliefNeeded = Math.ceil(heavyCount * ((onDays - daysUntilCapForHeavy) / onDays));
      const optionATotalDrivers = afterPass2.length + reliefNeeded;

      // Option B: simulate rebalancing — how many new shifts would it create?
      let optionBNewShifts = 0;
      let optionBAbsorbed = 0;

      for (const heavy of heavyShifts) {
        if (heavy.shift.legs.length <= 1) continue;
        // Would removing the last leg bring it under ceiling?
        const lastLegId = heavy.shift.legs[heavy.shift.legs.length - 1];
        const lastLane = laneMap.get(lastLegId);
        if (!lastLane) continue;

        const reducedDuty = heavy.shift.totalDutyHours -
          lastLane.routeDurationHours - (lastLane.hosAnalysis.dwellTimeTotal ?? 0);

        if (reducedDuty > weeklyDutyCeiling) {
          // Still over ceiling even after removing — would need multiple removals
          optionBNewShifts += 2; // conservative estimate
          continue;
        }

        // Can the removed leg be absorbed by an existing light shift?
        let canAbsorb = false;
        for (const candidate of afterPass2) {
          if (candidate === heavy) continue;
          if (candidate.shift.legs.length >= maxLegs) continue;
          if (candidate.shift.totalDutyHours + lastLane.hosAnalysis.dutyTimePerRun > weeklyDutyCeiling) continue;

          const edges = graph.get(candidate.lastLaneId) ?? [];
          if (edges.some((e) => e.toId === lastLegId)) {
            canAbsorb = true;
            break;
          }
        }

        if (canAbsorb) {
          optionBAbsorbed++;
        } else {
          optionBNewShifts++;
        }
      }

      const optionBTotalDrivers = afterPass2.length + optionBNewShifts; // absorbed don't add shifts

      // Pick the cheaper option
      if (optionBTotalDrivers < optionATotalDrivers) {
        // Option B wins — actually do the rebalancing
        let rebalanced = true;
        let iterations = 0;

        while (rebalanced && iterations++ < 20) {
          rebalanced = false;

          for (let si = 0; si < afterPass2.length; si++) {
            const s = afterPass2[si];
            if (s.shift.totalDutyHours <= weeklyDutyCeiling) continue;
            if (s.shift.legs.length <= 1) continue;

            const removedLegId = s.shift.legs.pop()!;
            const removedLane = laneMap.get(removedLegId);
            if (!removedLane) continue;

            // Recalculate the shortened shift
            let rd = 0, rdu = prePostTripHours, rm = 0, rdh = 0;
            let rc: number | null = null;
            let prev: string | null = null;

            for (const legId of s.shift.legs) {
              const lane = laneMap.get(legId)!;
              const dhH = prev ? ((graph.get(prev) ?? []).find((e) => e.toId === legId)?.deadheadDriveHours ?? 0) : 0;
              const dhM = prev ? ((graph.get(prev) ?? []).find((e) => e.toId === legId)?.deadheadMiles ?? 0) : 0;
              rd += lane.routeDurationHours + dhH;
              rdu += lane.routeDurationHours + (lane.hosAnalysis.dwellTimeTotal ?? 0) + dhH;
              rm += lane.routeMiles + dhM;
              rdh += dhM;
              const pt = lane.originScheduledTime ? parseTimeToHours(lane.originScheduledTime) : null;
              if (pt !== null) rc = pt + (lane.hosAnalysis.dwellTimeTotal ?? 0) + lane.routeDurationHours;
              prev = legId;
            }
            rdu += Math.floor(rd / HOS.BREAK_AFTER) * HOS.BREAK_DURATION;

            s.shift.totalDriveHours = rd;
            s.shift.totalDutyHours = rdu;
            s.shift.totalMiles = rm;
            s.shift.totalDeadheadMiles = rdh;
            s.lastLaneId = s.shift.legs[s.shift.legs.length - 1];
            s.clockTime = rc;

            // Try to absorb into existing shift under ceiling
            let placed = false;
            for (let ri = 0; ri < afterPass2.length; ri++) {
              if (ri === si) continue;
              const recv = afterPass2[ri];
              if (recv.shift.legs.length >= maxLegs) continue;

              const edges = graph.get(recv.lastLaneId) ?? [];
              const edge = edges.find((e) => e.toId === removedLegId);
              if (!edge) continue;

              const result = canAddLeg(recv.shift.totalDriveHours, recv.shift.totalDutyHours, recv.clockTime, removedLane, edge.deadheadDriveHours, prePostTripHours, false, maxWaitHours);
              if (!result || result.newDuty > weeklyDutyCeiling) continue;

              // Return-to-base check for Pass 3 absorption
              if (recv.baseLat != null && recv.baseLng != null || recv.baseCity != null) {
                const rtbCheck = isReturnableToBase(
                  removedLane, recv.baseLat ?? 0, recv.baseLng ?? 0,
                  MAX_RETURN_TO_BASE_MILES,
                  recv.baseCity ?? undefined, recv.baseState ?? undefined,
                );
                if (!rtbCheck.canReturn) continue;
              }

              recv.shift.legs.push(removedLegId);
              recv.shift.totalDriveHours = result.newDrive;
              recv.shift.totalDutyHours = result.newDuty;
              recv.shift.totalMiles += removedLane.routeMiles + edge.deadheadMiles;
              recv.shift.totalDeadheadMiles += edge.deadheadMiles;
              recv.lastLaneId = removedLegId;
              recv.clockTime = result.newClockTime;
              placed = true;
              break;
            }

            if (!placed) {
              const pt = removedLane.originScheduledTime ? parseTimeToHours(removedLane.originScheduledTime) : null;
              const dw = removedLane.hosAnalysis.dwellTimeTotal ?? 0;
              const rb = (removedLane.originLat != null && removedLane.originLng != null)
                ? findNearestBase(removedLane.originLat, removedLane.originLng, bases)
                : findNearestBaseByCity(removedLane.originCity, removedLane.originState, bases);
              const rbDhFrom = rb ? baseDeadheadHours(
                removedLane.originLat, removedLane.originLng, removedLane.originCity, removedLane.originState,
                rb.base.lat, rb.base.lng, rb.base.city, rb.base.state,
              ) : 0;
              const rbDhTo = rb ? baseDeadheadHours(
                removedLane.destLat, removedLane.destLng, removedLane.destCity, removedLane.destState,
                rb.base.lat, rb.base.lng, rb.base.city, rb.base.state,
              ) : 0;
              afterPass2.push({
                shift: {
                  legs: [removedLegId],
                  totalDriveHours: removedLane.routeDurationHours + rbDhFrom,
                  totalDutyHours: removedLane.hosAnalysis.dutyTimePerRun + rbDhFrom,
                  totalMiles: removedLane.routeMiles + (rbDhFrom * 55),
                  totalDeadheadMiles: rbDhFrom * 55,
                },
                lastLaneId: removedLegId,
                clockTime: pt !== null ? pt + dw + removedLane.routeDurationHours : null,
                baseLat: rb?.base.lat ?? null,
                baseLng: rb?.base.lng ?? null,
                baseName: rb?.base.name ?? null,
                baseCity: rb?.base.city ?? null,
                baseState: rb?.base.state ?? null,
                deadheadFromBaseHours: rbDhFrom,
                deadheadToBaseHours: rbDhTo,
              });
            }

            rebalanced = true;
            break;
          }
        }
      }
      // else: Option A wins — keep heavy shifts as-is, relief drivers are cheaper
    }
  }

  // Calculate return-to-base and from-base for each shift
  for (const s of afterPass2) {
    s.shift.baseName = s.baseName;
    s.shift.fromBaseDriveHours = Math.round(s.deadheadFromBaseHours * 100) / 100;
    if (s.baseLat != null || s.baseCity != null) {
      const lastLane = laneMap.get(s.lastLaneId);
      if (lastLane) {
        const returnHours = baseDeadheadHours(
          lastLane.destLat, lastLane.destLng, lastLane.destCity, lastLane.destState,
          s.baseLat, s.baseLng, s.baseCity, s.baseState,
        );
        s.shift.returnToBaseMiles = Math.round(returnHours * 55 * 100) / 100;
        s.shift.returnToBaseDriveHours = Math.round(returnHours * 100) / 100;
      }
    }
  }

  // Final result sorted by first leg pickup time
  const finalShifts = afterPass2
    .map((s) => s.shift)
    .sort((a, b) => {
      const aLane = laneMap.get(a.legs[0]);
      const bLane = laneMap.get(b.legs[0]);
      const aTime = aLane?.originScheduledTime ? (parseTimeToHours(aLane.originScheduledTime) ?? 99) : 99;
      const bTime = bLane?.originScheduledTime ? (parseTimeToHours(bLane.originScheduledTime) ?? 99) : 99;
      return aTime - bTime;
    });

  return finalShifts;
}

/**
 * Build multi-leg driver shifts across all schedule dates.
 * Returns per-day shift assignments and aggregate driver counts.
 */
export function buildDriverShifts(
  entries: ShiftBuilderEntry[],
  maxDeadheadMiles = 50,
  maxLegs = 6,
  prePostTripHours = 1.0,
  maxWaitHours = MAX_WAIT_BETWEEN_LEGS,
  scheduleOnDays = 5, // days per on-cycle, used to calculate weekly duty ceiling
  bases: BaseLocation[] = [], // all known bases for return-to-base checks
  weeklyHosMode: 'uniform' | 'flexible' = 'flexible',
): {
  /** Map of date → array of shifts for that day */
  dailyShifts: Map<string, DriverShift[]>;
  /** Peak day info */
  peakDay: { date: string; shiftsNeeded: number; driversNeeded: number };
  /** Total unique shift patterns found */
  totalShiftPatterns: number;
  /** Stats */
  avgLegsPerShift: number;
  maxLegsInAnyShift: number;
  /** Weekly HOS stats */
  weeklyHosWarnings: number; // days where drivers were near/over 70h weekly cap
} {
  const entryMap = new Map(entries.map((e) => [e.id, e]));
  const graph = buildAdjacencyGraph(entries, maxDeadheadMiles);

  // Build date → entries map
  const dateEntries = new Map<string, ShiftBuilderEntry[]>();
  for (const e of entries) {
    for (const d of e.scheduleDates) {
      if (!dateEntries.has(d)) dateEntries.set(d, []);
      dateEntries.get(d)!.push(e);
    }
  }

  // Sort dates chronologically for weekly HOS tracking
  const sortedDates = Array.from(dateEntries.keys()).sort();

  // Weekly duty ceiling: max duty per shift so drivers complete the on-cycle
  // Weekly duty ceiling per shift:
  // - "uniform" mode: distribute 70h evenly (conservative). 6-day = 11.67h/day.
  // - "flexible" mode: allow full 14h shifts, manage 70h across the week.
  //   Drivers work full days and take an extra day off if they hit the cap.
  //   This matches real-world operations where drivers vary daily hours.
  const weeklyDutyCeiling = weeklyHosMode === 'uniform' && scheduleOnDays > 0
    ? Math.min(HOS.WEEKLY_CAP / scheduleOnDays, HOS.MAX_DUTY_SOLO)
    : HOS.MAX_DUTY_SOLO; // flexible: let shifts go to 14h

  const dailyShifts = new Map<string, DriverShift[]>();
  let peakDate = '';
  let peakShifts = 0;
  let totalShifts = 0;
  let totalLegs = 0;
  let maxLegsInAnyShift = 0;
  let weeklyHosWarnings = 0;

  // ---- Weekly HOS Tracking ----
  // Track rolling 8-day duty hours per "driver slot" (shift pattern index)
  // Each day we record the duty hours for each shift. Then check if any
  // shift pattern's rolling 8-day total exceeds 70h.
  //
  // Simplified model: we don't track individual drivers across days (that
  // requires full roster scheduling). Instead we track how many shifts per
  // day have HEAVY duty loads and flag when the cumulative weekly hours
  // suggest you'd need MORE drivers than peak-day count.
  const dailyDutyTotals: number[][] = []; // last 8 days of shift duty hours

  for (const date of sortedDates) {
    const lanesRunning = dateEntries.get(date)!;
    const shifts = buildShiftsForDay(lanesRunning, graph, maxLegs, prePostTripHours, maxWaitHours, weeklyDutyCeiling, bases, false);
    dailyShifts.set(date, shifts);

    // Collect duty hours for this day's shifts (sorted by duty desc for pairing)
    const dayDutyHours = shifts.map((s) => s.totalDutyHours).sort((a, b) => b - a);
    dailyDutyTotals.push(dayDutyHours);

    // Keep only last 8 days for rolling window
    if (dailyDutyTotals.length > 8) dailyDutyTotals.shift();

    // Check weekly HOS: for each "driver slot" (by index), sum duty across rolling 8 days
    // If any slot exceeds 70h, flag a warning — means you need extra relief drivers
    const maxSlots = Math.max(...dailyDutyTotals.map((d) => d.length), 0);
    let hasWeeklyWarning = false;
    for (let slot = 0; slot < maxSlots; slot++) {
      let rollingDuty = 0;
      for (const dayHours of dailyDutyTotals) {
        rollingDuty += dayHours[slot] ?? 0;
      }
      if (rollingDuty > HOS.WEEKLY_CAP) {
        hasWeeklyWarning = true;
        break;
      }
    }
    if (hasWeeklyWarning) weeklyHosWarnings++;

    // Track peak day
    let driversForDay = 0;
    for (const shift of shifts) {
      const needsTeam = shift.legs.some((legId) => entryMap.get(legId)?.hosAnalysis.requiresTeam);
      driversForDay += needsTeam ? 2 : 1;
    }

    if (driversForDay > peakShifts) {
      peakShifts = driversForDay;
      peakDate = date;
    }

    totalShifts += shifts.length;
    for (const s of shifts) {
      totalLegs += s.legs.length;
      maxLegsInAnyShift = Math.max(maxLegsInAnyShift, s.legs.length);
    }
  }

  // Multi-seed re-run for days with the most shifts to optimize driver count.
  // Only re-run the top 3 heaviest days to stay within compute budget.
  const heavyDays = sortedDates
    .map((d) => ({ date: d, count: dailyShifts.get(d)?.length ?? 0, lanes: dateEntries.get(d)!.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .filter((d) => d.lanes > 4 && d.count > 1);

  for (const hd of heavyDays) {
    const lanes = dateEntries.get(hd.date)!;
    const optimizedShifts = buildShiftsForDay(
      lanes, graph, maxLegs, prePostTripHours, maxWaitHours,
      weeklyDutyCeiling, bases, true,
    );
    if (optimizedShifts.length < hd.count) {
      dailyShifts.set(hd.date, optimizedShifts);
    }
  }

  // Recalculate all metrics after multi-seed optimization
  peakShifts = 0;
  peakDate = '';
  totalLegs = 0;
  totalShifts = 0;
  maxLegsInAnyShift = 0;
  for (const [date, shifts] of dailyShifts.entries()) {
    let driversForDay = 0;
    for (const shift of shifts) {
      const needsTeam = shift.legs.some((legId) => entryMap.get(legId)?.hosAnalysis.requiresTeam);
      driversForDay += needsTeam ? 2 : 1;
    }
    if (driversForDay > peakShifts) {
      peakShifts = driversForDay;
      peakDate = date;
    }
    totalShifts += shifts.length;
    for (const s of shifts) {
      totalLegs += s.legs.length;
      maxLegsInAnyShift = Math.max(maxLegsInAnyShift, s.legs.length);
    }
  }

  // Count unique shift patterns
  const patternSet = new Set<string>();
  for (const shifts of dailyShifts.values()) {
    for (const s of shifts) {
      patternSet.add(s.legs.join('→'));
    }
  }

  return {
    dailyShifts,
    peakDay: { date: peakDate, shiftsNeeded: peakShifts, driversNeeded: peakShifts },
    totalShiftPatterns: patternSet.size,
    avgLegsPerShift: totalShifts > 0 ? Math.round((totalLegs / totalShifts) * 10) / 10 : 0,
    maxLegsInAnyShift,
    weeklyHosWarnings,
  };
}

/**
 * Calculate driver/truck counts using multi-leg shift building.
 */
export function calculateDriverCountsWithChaining(
  entries: Array<{
    id: string;
    hosAnalysis: ReturnType<typeof hosAnalyzeRoute>;
    annualRunCount: number;
    equipmentClass?: string;
    scheduleDates: string[];
  }>,
  shiftResult: ReturnType<typeof buildDriverShifts>,
  schedulePattern: { pattern: string; onDays: number; offDays: number },
): {
  minDriverCount: number;
  realisticDriverCount: number;
  truckCount: number;
  truckCountByEquipment: Record<string, number>;
  peakDay: { date: string; driversNeeded: number };
  chainedLaneCount: number;
  soloLaneCount: number;
  driverSavings: number;
  weeklyHosWarnings: number;
  weeklyHosExtraDrivers: number;
  avgDutyPerShift: number;
  daysUntilWeeklyCap: number | null; // deprecated, use dutyBands
  dutyBands: Array<{
    label: string;
    shiftCount: number;
    avgDuty: number;
    daysUntilCap: number | null;
    needsRelief: boolean;
    reliefDrivers: number;
  }>;
  avgLegsPerShift: number;
  maxLegsInAnyShift: number;
  totalShiftPatterns: number;
} {
  // Trucks: still 1 per lane running per day (peak day)
  const dayTrucks = new Map<string, number>();
  const dayEquipment = new Map<string, Map<string, number>>();
  for (const entry of entries) {
    const eqClass = entry.equipmentClass ?? 'Dry Van';
    for (const date of entry.scheduleDates) {
      dayTrucks.set(date, (dayTrucks.get(date) ?? 0) + 1);
      if (!dayEquipment.has(date)) dayEquipment.set(date, new Map());
      const eqMap = dayEquipment.get(date)!;
      eqMap.set(eqClass, (eqMap.get(eqClass) ?? 0) + 1);
    }
  }

  const truckCount = Math.max(...Array.from(dayTrucks.values()), 0);
  const truckCountByEquipment: Record<string, number> = {};
  for (const eqMap of dayEquipment.values()) {
    for (const [eq, count] of eqMap) {
      truckCountByEquipment[eq] = Math.max(truckCountByEquipment[eq] ?? 0, count);
    }
  }

  // Count lanes in multi-leg shifts vs solo
  const chainedLaneIds = new Set<string>();
  for (const shifts of shiftResult.dailyShifts.values()) {
    for (const shift of shifts) {
      if (shift.legs.length > 1) {
        shift.legs.forEach((id) => chainedLaneIds.add(id));
      }
    }
  }

  const peakDrivers = shiftResult.peakDay.driversNeeded;

  // Unpaired baseline for comparison
  const unpairedResult = calculateDriverCounts(entries, schedulePattern);
  const driverSavings = unpairedResult.minDriverCount - peakDrivers;

  const availabilityRatio = schedulePattern.onDays / (schedulePattern.onDays + schedulePattern.offDays);
  const reliefBuffer = 1.15;

  // ---- Per-Pattern Weekly 70h/8-day HOS Analysis ----
  //
  // Instead of one flat average, bucket shifts into duty-hour bands
  // and calculate relief needs per band. Light shifts (3h duty) never
  // hit the weekly cap. Only heavy shifts (12h+) need relief coverage.
  //
  // Bands: [0-6h] [6-8h] [8-10h] [10-12h] [12-14h]
  // For each band: how many peak-day shifts fall in it, and do they need relief?

  interface DutyBand {
    label: string;
    minDuty: number;
    maxDuty: number;
    shiftCount: number; // peak day shifts in this band
    avgDuty: number;
    totalDutyHours: number;
    daysUntilCap: number | null; // 70 / avgDuty
    needsRelief: boolean;
    reliefDrivers: number;
  }

  const bandDefs = [
    { label: '0–6h', minDuty: 0, maxDuty: 6 },
    { label: '6–8h', minDuty: 6, maxDuty: 8 },
    { label: '8–10h', minDuty: 8, maxDuty: 10 },
    { label: '10–12h', minDuty: 10, maxDuty: 12 },
    { label: '12–14h', minDuty: 12, maxDuty: 14 },
  ];

  // Use peak day shifts for the band analysis (that's the day that determines driver count)
  const peakDayShifts = shiftResult.dailyShifts.get(shiftResult.peakDay.date) ?? [];

  const dutyBands: DutyBand[] = bandDefs.map((def) => {
    const shiftsInBand = peakDayShifts.filter(
      (s) => s.totalDutyHours >= def.minDuty && s.totalDutyHours < def.maxDuty,
    );
    const count = shiftsInBand.length;
    const totalDuty = shiftsInBand.reduce((sum, s) => sum + s.totalDutyHours, 0);
    const avg = count > 0 ? totalDuty / count : 0;

    let daysUntil: number | null = null;
    let needsRelief = false;
    let reliefDrivers = 0;

    if (avg > 0 && schedulePattern.onDays > 0) {
      daysUntil = HOS.WEEKLY_CAP / avg;
      if (daysUntil < schedulePattern.onDays) {
        needsRelief = true;
        const reliefRatio = (schedulePattern.onDays / daysUntil) - 1;
        reliefDrivers = Math.ceil(count * reliefRatio);
      }
    }

    return {
      label: def.label,
      minDuty: def.minDuty,
      maxDuty: def.maxDuty,
      shiftCount: count,
      avgDuty: Math.round(avg * 10) / 10,
      totalDutyHours: Math.round(totalDuty * 10) / 10,
      daysUntilCap: daysUntil !== null ? Math.round(daysUntil * 10) / 10 : null,
      needsRelief,
      reliefDrivers,
    };
  });

  // Total relief = sum across bands that need it
  const weeklyHosExtraDrivers = dutyBands.reduce((sum, b) => sum + b.reliefDrivers, 0);
  const bandsNeedingRelief = dutyBands.filter((b) => b.needsRelief);

  // Overall stats for display
  let avgDutyPerShift = 0;
  let totalShiftCount = 0;
  for (const shifts of shiftResult.dailyShifts.values()) {
    for (const s of shifts) {
      avgDutyPerShift += s.totalDutyHours;
      totalShiftCount++;
    }
  }
  avgDutyPerShift = totalShiftCount > 0 ? avgDutyPerShift / totalShiftCount : 0;

  const baseRealistic = Math.ceil((peakDrivers / (availabilityRatio || 1)) * reliefBuffer);
  const realisticDriverCount = baseRealistic + weeklyHosExtraDrivers;

  return {
    minDriverCount: peakDrivers,
    realisticDriverCount,
    truckCount,
    truckCountByEquipment,
    peakDay: { date: shiftResult.peakDay.date, driversNeeded: peakDrivers },
    chainedLaneCount: chainedLaneIds.size,
    soloLaneCount: entries.length - chainedLaneIds.size,
    driverSavings,
    weeklyHosWarnings: shiftResult.weeklyHosWarnings ?? 0,
    weeklyHosExtraDrivers,
    avgDutyPerShift: Math.round(avgDutyPerShift * 10) / 10,
    daysUntilWeeklyCap: null, // replaced by per-band analysis
    dutyBands: dutyBands.filter((b) => b.shiftCount > 0), // only bands with shifts
    avgLegsPerShift: shiftResult.avgLegsPerShift,
    maxLegsInAnyShift: shiftResult.maxLegsInAnyShift,
    totalShiftPatterns: shiftResult.totalShiftPatterns,
  };
}

function parseTimeToHours(time: string): number | null {
  const parts = time.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h + m / 60;
}
