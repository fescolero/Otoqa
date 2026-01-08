import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { Id, Doc } from './_generated/dataModel';

/**
 * Driver Pay Calculation Engine
 * Core logic for calculating driver pay based on rate profiles and rules
 * 
 * Key Constraints (V1):
 * - No GPS tracking
 * - Hourly pay inferred from load stop schedule
 * - Empty miles default to 0 (manual add-on only)
 */

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get stops for a specific leg
 * Pattern: Fetch all stops, filter in memory (efficient for N < 20)
 */
function getStopsForLeg(
  allLoadStops: Doc<'loadStops'>[],
  startStopId: Id<'loadStops'>,
  endStopId: Id<'loadStops'>
): Doc<'loadStops'>[] {
  const sorted = [...allLoadStops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const startSeq = sorted.find((s) => s._id === startStopId)?.sequenceNumber ?? 0;
  const endSeq = sorted.find((s) => s._id === endStopId)?.sequenceNumber ?? Infinity;
  return sorted.filter((s) => s.sequenceNumber >= startSeq && s.sequenceNumber <= endSeq);
}

/**
 * Determine which profile to use for this leg
 * Uses minThreshold from the BASE rule for distance-based selection
 * Priority:
 * 1. Profile whose BASE minThreshold best matches the leg miles
 * 2. Driver's explicit default (isDefault=true)
 * 3. First available profile
 */
function determineProfile(
  assignmentsWithBaseRule: { assignment: Doc<'driverProfileAssignments'>; minThreshold: number }[],
  legLoadedMiles: number
): Id<'rateProfiles'> | null {
  if (assignmentsWithBaseRule.length === 0) return null;

  // Filter to profiles that apply for this distance (minThreshold <= legMiles)
  const applicableProfiles = assignmentsWithBaseRule.filter(
    (a) => legLoadedMiles >= a.minThreshold
  );

  if (applicableProfiles.length === 0) {
    // No profiles match the distance - fall back to driver's default or first
    const defaultAssignment = assignmentsWithBaseRule.find((a) => a.assignment.isDefault);
    return defaultAssignment?.assignment.profileId ?? assignmentsWithBaseRule[0].assignment.profileId;
  }

  // Among applicable profiles, prefer:
  // 1. The one with highest minThreshold (most specific match)
  // 2. If tie, prefer driver's default
  applicableProfiles.sort((a, b) => {
    // Higher threshold = more specific
    if (b.minThreshold !== a.minThreshold) {
      return b.minThreshold - a.minThreshold;
    }
    // Prefer default
    if (a.assignment.isDefault && !b.assignment.isDefault) return -1;
    if (!a.assignment.isDefault && b.assignment.isDefault) return 1;
    return 0;
  });

  return applicableProfiles[0].assignment.profileId;
}

/**
 * Calculate hourly duration from stop times
 * Waterfall: checkedInAt/checkedOutAt -> windowBeginTime/windowEndTime
 */
function calculateHourlyDuration(
  legStops: Doc<'loadStops'>[]
): { hours: number; warning: string | null } {
  if (legStops.length < 2) {
    return { hours: 0, warning: 'Insufficient stops for duration calculation' };
  }

  const sortedStops = [...legStops].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  const firstStop = sortedStops[0];
  const lastStop = sortedStops[sortedStops.length - 1];

  // Waterfall: Actual > Scheduled
  const startTime = firstStop.checkedInAt ?? firstStop.windowBeginTime;
  const endTime = lastStop.checkedOutAt ?? lastStop.windowEndTime;

  if (!startTime || !endTime) {
    return { hours: 0, warning: 'Missing stop times for hourly calculation' };
  }

  try {
    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    const durationMs = endDate.getTime() - startDate.getTime();
    const hours = durationMs / (1000 * 60 * 60);

    if (hours <= 0) {
      return { hours: 0, warning: 'Invalid time range (end before start)' };
    }

    // Round to 2 decimal places
    return { hours: Math.round(hours * 100) / 100, warning: null };
  } catch {
    return { hours: 0, warning: 'Failed to parse stop times' };
  }
}

/**
 * Evaluate a single rule and return the calculated amount
 */
function evaluateRule(
  rule: Doc<'rateRules'>,
  leg: Doc<'dispatchLegs'>,
  load: Doc<'loadInformation'>,
  legStops: Doc<'loadStops'>[],
  invoiceTotal: number | null
): { qty: number; amount: number; warning: string | null } {
  let qty = 0;
  let amount = 0;
  let warning: string | null = null;

  switch (rule.triggerEvent) {
    case 'MILE_LOADED':
      qty = leg.legLoadedMiles;
      amount = qty * rule.rateAmount;
      break;

    case 'MILE_EMPTY':
      // Dormant in V1 - legEmptyMiles defaults to 0
      qty = leg.legEmptyMiles;
      amount = qty * rule.rateAmount;
      break;

    case 'TIME_DURATION': {
      const { hours, warning: hourlyWarning } = calculateHourlyDuration(legStops);
      qty = hours;
      amount = qty * rule.rateAmount;
      warning = hourlyWarning;
      break;
    }

    case 'TIME_WAITING':
      // For detention - would need dwell time tracking
      // V1: Sum up dwellTime from stops if available
      qty = legStops.reduce((sum, s) => sum + (s.dwellTime ?? 0), 0) / 60; // Convert minutes to hours
      amount = qty * rule.rateAmount;
      if (qty === 0) {
        warning = 'No dwell time recorded for detention calculation';
      }
      break;

    case 'COUNT_STOPS':
      qty = legStops.length;
      amount = qty * rule.rateAmount;
      break;

    case 'FLAT_LOAD':
      // Flat rate for entire load - qty=1 means "one load"
      qty = 1;
      amount = rule.rateAmount;
      break;

    case 'FLAT_LEG':
      // Flat rate per leg segment
      qty = 1;
      amount = rule.rateAmount;
      break;

    case 'ATTR_HAZMAT':
      if (load.isHazmat) {
        qty = 1;
        amount = rule.rateAmount;
      }
      break;

    case 'ATTR_TARP':
      if (load.requiresTarp) {
        qty = 1;
        amount = rule.rateAmount;
      }
      break;

    case 'PCT_OF_LOAD':
      if (invoiceTotal && invoiceTotal > 0) {
        qty = invoiceTotal;
        amount = qty * (rule.rateAmount / 100);
      } else {
        warning = 'No invoice total available for percentage calculation';
      }
      break;
  }

  // Apply minimum threshold
  if (rule.minThreshold && qty < rule.minThreshold) {
    return { qty: 0, amount: 0, warning: null };
  }

  // Apply maximum cap
  if (rule.maxCap && amount > rule.maxCap) {
    amount = rule.maxCap;
  }

  return { qty, amount, warning };
}

// ============================================
// MAIN CALCULATION FUNCTION
// ============================================

/**
 * Calculate driver pay for a leg
 * Called when:
 * 1. Driver is assigned to leg
 * 2. Stop times are updated
 * 3. Manual "Recalculate" button is clicked
 */
export const calculateDriverPay = internalMutation({
  args: {
    legId: v.id('dispatchLegs'),
    userId: v.string(),
  },
  handler: async (ctx, args) => {
    const leg = await ctx.db.get(args.legId);
    if (!leg) throw new Error('Leg not found');

    if (!leg.driverId) {
      // No driver assigned - nothing to calculate
      return { success: false, reason: 'No driver assigned' };
    }

    const driverId = leg.driverId;
    const now = Date.now();

    // 1. Get load and stops
    const load = await ctx.db.get(leg.loadId);
    if (!load) throw new Error('Load not found');

    const allStops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
      .collect();

    const legStops = getStopsForLeg(allStops, leg.startStopId, leg.endStopId);

    // 2. Get driver's profile assignments with BASE rule thresholds
    const assignments = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', driverId))
      .collect();

    // Enrich assignments with BASE rule minThreshold
    const assignmentsWithBaseRule = await Promise.all(
      assignments.map(async (assignment) => {
        const rules = await ctx.db
          .query('rateRules')
          .withIndex('by_profile', (q) => q.eq('profileId', assignment.profileId))
          .collect();
        const baseRule = rules.find((r) => r.category === 'BASE' && r.isActive);
        return {
          assignment,
          minThreshold: baseRule?.minThreshold ?? 0,
        };
      })
    );

    // 3. Determine which profile to use
    const profileId = determineProfile(assignmentsWithBaseRule, leg.legLoadedMiles);

    if (!profileId) {
      // No profile assigned - return $0 with warning
      // Check if there are existing payables to clear
      const existingPayables = await ctx.db
        .query('loadPayables')
        .withIndex('by_leg', (q) => q.eq('legId', args.legId))
        .filter((q) => 
          q.and(
            q.eq(q.field('sourceType'), 'SYSTEM'),
            q.eq(q.field('isLocked'), false)
          )
        )
        .collect();

      // Delete existing unlocked system payables
      for (const payable of existingPayables) {
        await ctx.db.delete(payable._id);
      }

      // Insert a $0 warning payable
      await ctx.db.insert('loadPayables', {
        loadId: leg.loadId,
        legId: args.legId,
        driverId,
        description: 'No Pay Profile',
        quantity: 0,
        rate: 0,
        totalAmount: 0,
        sourceType: 'SYSTEM',
        isLocked: false,
        warningMessage: 'Driver has no pay profile assigned. Pay calculated as $0.',
        workosOrgId: load.workosOrgId,
        createdAt: now,
        createdBy: args.userId,
      });

      return { 
        success: true, 
        total: 0, 
        warning: 'No pay profile assigned' 
      };
    }

    // 4. Get the profile and its rules
    const profile = await ctx.db.get(profileId);
    if (!profile || !profile.isActive) {
      return { success: false, reason: 'Profile not found or inactive' };
    }

    const rules = await ctx.db
      .query('rateRules')
      .withIndex('by_profile', (q) => q.eq('profileId', profileId))
      .filter((q) => q.eq(q.field('isActive'), true))
      .collect();

    // 5. Get invoice total for PCT_OF_LOAD calculations
    let invoiceTotal: number | null = null;
    const invoice = await ctx.db
      .query('loadInvoices')
      .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
      .first();
    
    if (invoice?.totalAmount) {
      invoiceTotal = invoice.totalAmount;
    }

    // 6. Delete existing SYSTEM payables for this leg (that are NOT locked)
    const existingPayables = await ctx.db
      .query('loadPayables')
      .withIndex('by_leg', (q) => q.eq('legId', args.legId))
      .filter((q) => 
        q.and(
          q.eq(q.field('sourceType'), 'SYSTEM'),
          q.eq(q.field('isLocked'), false)
        )
      )
      .collect();

    for (const payable of existingPayables) {
      await ctx.db.delete(payable._id);
    }

    // 7. Evaluate each rule and insert payables
    let totalPay = 0;
    const warnings: string[] = [];

    for (const rule of rules) {
      const { qty, amount, warning } = evaluateRule(rule, leg, load, legStops, invoiceTotal);

      if (warning) {
        warnings.push(warning);
      }

      // Only insert if amount > 0
      if (amount > 0) {
        await ctx.db.insert('loadPayables', {
          loadId: leg.loadId,
          legId: args.legId,
          driverId,
          description: rule.name,
          quantity: qty,
          rate: rule.rateAmount,
          totalAmount: amount,
          sourceType: 'SYSTEM',
          isLocked: false,
          ruleId: rule._id,
          warningMessage: warning ?? undefined,
          workosOrgId: load.workosOrgId,
          createdAt: now,
          createdBy: args.userId,
        });

        totalPay += amount;
      }
    }

    // 8. If no payables were created but rules exist, add a $0 line with warning
    if (totalPay === 0 && rules.length > 0) {
      const warningMessage = warnings.length > 0 
        ? warnings.join('; ') 
        : 'All rules evaluated to $0';

      await ctx.db.insert('loadPayables', {
        loadId: leg.loadId,
        legId: args.legId,
        driverId,
        description: `${profile.name} (No applicable charges)`,
        quantity: 0,
        rate: 0,
        totalAmount: 0,
        sourceType: 'SYSTEM',
        isLocked: false,
        warningMessage,
        workosOrgId: load.workosOrgId,
        createdAt: now,
        createdBy: args.userId,
      });
    }

    // 9. Update load's primaryDriverId cache if needed
    if (leg.sequence === 1 && load.primaryDriverId !== driverId) {
      await ctx.db.patch(leg.loadId, { primaryDriverId: driverId });
    }

    return {
      success: true,
      total: totalPay,
      profileName: profile.name,
      rulesApplied: rules.length,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  },
});

// Result type for recalculateForLoad
type RecalculateResult = {
  legId: Id<'dispatchLegs'>;
  success?: boolean;
  total?: number;
  profileName?: string;
  rulesApplied?: number;
  warnings?: string[];
  reason?: string;
  warning?: string;
};

/**
 * Trigger recalculation for all legs of a load
 * Called when load-level data changes (like isHazmat)
 */
export const recalculateForLoad = internalMutation({
  args: {
    loadId: v.id('loadInformation'),
    userId: v.string(),
  },
  handler: async (ctx, args): Promise<RecalculateResult[]> => {
    const legs = await ctx.db
      .query('dispatchLegs')
      .withIndex('by_load', (q) => q.eq('loadId', args.loadId))
      .collect();

    const results: RecalculateResult[] = [];
    for (const leg of legs) {
      if (leg.driverId) {
        const result = await ctx.runMutation(
          internal.driverPayCalculation.calculateDriverPay,
          { legId: leg._id, userId: args.userId }
        );
        results.push({ legId: leg._id, ...result });
      }
    }

    return results;
  },
});

/**
 * Get calculation preview without saving
 * Useful for UI "what-if" scenarios
 */
export const previewCalculation = internalQuery({
  args: {
    legId: v.id('dispatchLegs'),
  },
  handler: async (ctx, args) => {
    const leg = await ctx.db.get(args.legId);
    if (!leg || !leg.driverId) {
      return { success: false, reason: 'Leg not found or no driver' };
    }

    const load = await ctx.db.get(leg.loadId);
    if (!load) return { success: false, reason: 'Load not found' };

    // Get stops
    const allStops = await ctx.db
      .query('loadStops')
      .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
      .collect();
    const legStops = getStopsForLeg(allStops, leg.startStopId, leg.endStopId);

    // Get profile assignments with BASE rule thresholds
    const assignments = await ctx.db
      .query('driverProfileAssignments')
      .withIndex('by_driver', (q) => q.eq('driverId', leg.driverId!))
      .collect();

    const assignmentsWithBaseRule = await Promise.all(
      assignments.map(async (assignment) => {
        const rules = await ctx.db
          .query('rateRules')
          .withIndex('by_profile', (q) => q.eq('profileId', assignment.profileId))
          .collect();
        const baseRule = rules.find((r) => r.category === 'BASE' && r.isActive);
        return {
          assignment,
          minThreshold: baseRule?.minThreshold ?? 0,
        };
      })
    );

    const profileId = determineProfile(assignmentsWithBaseRule, leg.legLoadedMiles);
    if (!profileId) {
      return { 
        success: true, 
        total: 0, 
        warning: 'No pay profile assigned',
        breakdown: []
      };
    }

    const profile = await ctx.db.get(profileId);
    const rules = await ctx.db
      .query('rateRules')
      .withIndex('by_profile', (q) => q.eq('profileId', profileId))
      .filter((q) => q.eq(q.field('isActive'), true))
      .collect();

    // Get invoice
    const invoice = await ctx.db
      .query('loadInvoices')
      .withIndex('by_load', (q) => q.eq('loadId', leg.loadId))
      .first();

    // Calculate preview
    const breakdown = [];
    let total = 0;

    for (const rule of rules) {
      const { qty, amount, warning } = evaluateRule(
        rule, leg, load, legStops, invoice?.totalAmount ?? null
      );
      if (amount > 0 || warning) {
        breakdown.push({
          ruleName: rule.name,
          category: rule.category,
          triggerEvent: rule.triggerEvent,
          quantity: qty,
          rate: rule.rateAmount,
          amount,
          warning,
        });
        total += amount;
      }
    }

    return {
      success: true,
      profileName: profile?.name,
      total,
      breakdown,
    };
  },
});
