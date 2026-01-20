import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';

/**
 * Driver Settlement Engine
 * 
 * Handles the "Pay Period Statement" workflow for driver gross pay.
 * This is the Power User accounting interface for processing driver payments.
 * 
 * Key Features:
 * - Groups payables by pay period
 * - Respects "Hold" flags for incomplete paperwork
 * - Variance detection (mileage, POD status)
 * - Approval workflow with frozen totals
 */

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate unique statement number
 * Format: SET-YYYY-NNN (e.g., SET-2025-001)
 */
async function generateStatementNumber(
  ctx: any,
  workosOrgId: string
): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `SET-${year}-`;

  // Find the highest statement number for this year
  const existingStatements = await ctx.db
    .query('driverSettlements')
    .withIndex('by_org_status', (q: any) => q.eq('workosOrgId', workosOrgId))
    .collect();

  const thisYearStatements = existingStatements.filter((s: Doc<'driverSettlements'>) =>
    s.statementNumber.startsWith(prefix)
  );

  let maxNumber = 0;
  for (const stmt of thisYearStatements) {
    const numPart = stmt.statementNumber.split('-')[2];
    const num = parseInt(numPart, 10);
    if (num > maxNumber) maxNumber = num;
  }

  const nextNumber = maxNumber + 1;
  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
}

/**
 * Calculate variance between payable quantity and load effective miles
 */
function calculateMileageVariance(
  payableQuantity: number,
  loadEffectiveMiles: number | undefined
): { variance: number; percentVariance: number; level: 'OK' | 'INFO' | 'WARNING' } {
  if (!loadEffectiveMiles || loadEffectiveMiles === 0) {
    return { variance: 0, percentVariance: 0, level: 'OK' };
  }

  const variance = payableQuantity - loadEffectiveMiles;
  const percentVariance = (variance / loadEffectiveMiles) * 100;

  let level: 'OK' | 'INFO' | 'WARNING' = 'OK';
  if (Math.abs(percentVariance) > 10) {
    level = 'WARNING';
  } else if (Math.abs(percentVariance) > 5) {
    level = 'INFO';
  }

  return { variance, percentVariance, level };
}

// ============================================
// PAY PLAN PERIOD CALCULATIONS
// ============================================

/**
 * Get the day of week as a number (0 = Sunday, 1 = Monday, etc.)
 */
function getDayOfWeekNumber(
  day: 'SUNDAY' | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY'
): number {
  const dayMap: Record<string, number> = {
    SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3,
    THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
  };
  return dayMap[day];
}

/**
 * Calculate weekly period start date
 */
function calculateWeeklyPeriodStart(referenceDate: Date, startDayOfWeek: number): Date {
  const date = new Date(referenceDate);
  const currentDay = date.getDay();
  const daysToSubtract = (currentDay - startDayOfWeek + 7) % 7;
  date.setDate(date.getDate() - daysToSubtract);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Calculate biweekly period start date (aligned to fixed anchor)
 */
function calculateBiweeklyPeriodStart(referenceDate: Date, startDayOfWeek: number): Date {
  const anchorDate = new Date('2024-01-01T00:00:00');
  const anchorDayOfWeek = anchorDate.getDay();
  const daysToAdjust = (startDayOfWeek - anchorDayOfWeek + 7) % 7;
  anchorDate.setDate(anchorDate.getDate() + daysToAdjust);
  
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksSinceAnchor = Math.floor((referenceDate.getTime() - anchorDate.getTime()) / msPerWeek);
  const biweeklyPeriods = Math.floor(weeksSinceAnchor / 2);
  
  const periodStart = new Date(anchorDate);
  periodStart.setDate(periodStart.getDate() + biweeklyPeriods * 14);
  periodStart.setHours(0, 0, 0, 0);
  return periodStart;
}

/**
 * Calculate semimonthly period start (1st-15th or 16th-end)
 */
function calculateSemimonthlyPeriodStart(referenceDate: Date): Date {
  const date = new Date(referenceDate);
  const dayOfMonth = date.getDate();
  date.setDate(dayOfMonth <= 15 ? 1 : 16);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Calculate monthly period start
 */
function calculateMonthlyPeriodStart(referenceDate: Date, startDayOfMonth: number): Date {
  const date = new Date(referenceDate);
  const currentDay = date.getDate();
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const effectiveStartDay = Math.min(startDayOfMonth, lastDayOfMonth);
  
  if (currentDay < effectiveStartDay) {
    date.setMonth(date.getMonth() - 1);
  }
  
  const lastDayOfTargetMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(startDayOfMonth, lastDayOfTargetMonth));
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Calculate period end based on frequency and start
 */
function calculatePeriodEnd(
  periodStart: Date,
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY'
): Date {
  const endDate = new Date(periodStart);

  switch (frequency) {
    case 'WEEKLY':
      endDate.setDate(endDate.getDate() + 7);
      break;
    case 'BIWEEKLY':
      endDate.setDate(endDate.getDate() + 14);
      break;
    case 'SEMIMONTHLY':
      if (periodStart.getDate() === 1) {
        endDate.setDate(16);
      } else {
        endDate.setMonth(endDate.getMonth() + 1);
        endDate.setDate(1);
      }
      break;
    case 'MONTHLY':
      endDate.setMonth(endDate.getMonth() + 1);
      break;
  }

  // End at 23:59:59.999 of the day before
  endDate.setTime(endDate.getTime() - 1);
  return endDate;
}

/**
 * Calculate the period dates from a Pay Plan
 */
function calculatePlanPeriod(
  plan: Doc<'payPlans'>,
  referenceDate: Date = new Date()
): { periodStart: Date; periodEnd: Date } {
  let periodStart: Date;

  switch (plan.frequency) {
    case 'WEEKLY':
      periodStart = calculateWeeklyPeriodStart(
        referenceDate,
        getDayOfWeekNumber(plan.periodStartDayOfWeek!)
      );
      break;
    case 'BIWEEKLY':
      periodStart = calculateBiweeklyPeriodStart(
        referenceDate,
        getDayOfWeekNumber(plan.periodStartDayOfWeek!)
      );
      break;
    case 'SEMIMONTHLY':
      periodStart = calculateSemimonthlyPeriodStart(referenceDate);
      break;
    case 'MONTHLY':
      periodStart = calculateMonthlyPeriodStart(referenceDate, plan.periodStartDayOfMonth || 1);
      break;
  }

  const periodEnd = calculatePeriodEnd(periodStart, plan.frequency);
  return { periodStart, periodEnd };
}

/**
 * Get the payable trigger timestamp based on the plan's trigger type
 * Maps payableTrigger to actual database fields
 */
async function getPayableTriggerTimestamp(
  ctx: any,
  payable: Doc<'loadPayables'>,
  triggerType: 'DELIVERY_DATE' | 'COMPLETION_DATE' | 'APPROVAL_DATE'
): Promise<number | null> {
  const payableLabel = payable.loadId ? `LOAD-${payable._id.slice(-8)}` : 'STANDALONE';
  const debugLog = (source: string, timestamp: number | null, details?: string) => {
    console.log(`[PAYABLE_TIMESTAMP] ${payableLabel} | Source: ${source} | Timestamp: ${timestamp ? new Date(timestamp).toISOString() : 'null'} ${details || ''}`);
  };

  switch (triggerType) {
    case 'APPROVAL_DATE':
      // Use the payable's approvedAt field
      debugLog('APPROVAL_DATE', payable.approvedAt || null);
      return payable.approvedAt || null;

    case 'DELIVERY_DATE':
    case 'COMPLETION_DATE':
      // For standalone payables (no loadId), use createdAt as the trigger
      if (!payable.loadId) {
        debugLog('STANDALONE_CREATED_AT', payable.createdAt);
        return payable.createdAt;
      }

      // Try to get timestamp from leg first
      if (payable.legId) {
        const leg = await ctx.db.get(payable.legId);
        if (leg) {
          if (triggerType === 'COMPLETION_DATE' && leg.completedAt) {
            debugLog('LEG_COMPLETED_AT', leg.completedAt);
            return leg.completedAt;
          }

          // DELIVERY_DATE - get end stop's checkedOutAt
          if (leg.endStopId) {
            const endStop = await ctx.db.get(leg.endStopId);
            if (endStop?.checkedOutAt) {
              const timestamp = new Date(endStop.checkedOutAt).getTime();
              if (!isNaN(timestamp)) {
                debugLog('LEG_ENDSTOP_CHECKEDOUT', timestamp, `raw: ${endStop.checkedOutAt}`);
                return timestamp;
              }
            }
          }

          // Fall back to leg completedAt if available
          if (leg.completedAt) {
            debugLog('LEG_COMPLETED_AT_FALLBACK', leg.completedAt);
            return leg.completedAt;
          }
        }
      }

      // Try to get delivery timestamp from the load's last delivery stop
      const load = await ctx.db.get(payable.loadId);
      if (load) {
        // Get all stops for this load
        const stops = await ctx.db
          .query('loadStops')
          .withIndex('by_load', (q: any) => q.eq('loadId', payable.loadId))
          .collect();

        // Filter to delivery stops, sorted by sequence (last delivery first)
        const deliveryStops = stops
          .filter((s: typeof stops[0]) => s.stopType === 'DELIVERY')
          .sort((a: typeof stops[0], b: typeof stops[0]) => (b.sequenceNumber || 0) - (a.sequenceNumber || 0));

        console.log(`[PAYABLE_TIMESTAMP] ${payableLabel} | Total stops: ${stops.length} | Delivery stops: ${deliveryStops.length}`);

        if (deliveryStops.length > 0) {
          const lastDelivery = deliveryStops[0];
          console.log(`[PAYABLE_TIMESTAMP] ${payableLabel} | Last delivery stop: checkedOutAt=${lastDelivery.checkedOutAt}, windowEndTime=${lastDelivery.windowEndTime}, windowBeginTime=${lastDelivery.windowBeginTime}`);
          
          // Priority 1: Use actual checkedOutAt if available (physical event)
          if (lastDelivery.checkedOutAt) {
            const timestamp = new Date(lastDelivery.checkedOutAt).getTime();
            if (!isNaN(timestamp)) {
              debugLog('LOADSTOP_CHECKEDOUT', timestamp, `raw: ${lastDelivery.checkedOutAt}`);
              return timestamp;
            }
          }
          
          // Priority 2: Fall back to scheduled delivery window end time
          // This is the "expected" delivery time for payroll purposes
          if (lastDelivery.windowEndTime) {
            const timestamp = new Date(lastDelivery.windowEndTime).getTime();
            if (!isNaN(timestamp)) {
              debugLog('LOADSTOP_WINDOW_END', timestamp, `raw: ${lastDelivery.windowEndTime}`);
              return timestamp;
            }
          }
          
          // Priority 3: Fall back to scheduled delivery window begin time
          if (lastDelivery.windowBeginTime) {
            const timestamp = new Date(lastDelivery.windowBeginTime).getTime();
            if (!isNaN(timestamp)) {
              debugLog('LOADSTOP_WINDOW_BEGIN', timestamp, `raw: ${lastDelivery.windowBeginTime}`);
              return timestamp;
            }
          }
        }
        
        // NOTE: Do NOT use lastExternalUpdatedAt as it represents sync time, not delivery time
      }

      // IMPORTANT: Do NOT fall back to createdAt for load-based payables
      // This prevents old loads from being pulled into current settlements
      // Payables without valid trigger timestamps will be skipped
      debugLog('NO_TIMESTAMP_FOUND', null);
      return null;

    default:
      // Unknown trigger type - skip this payable
      debugLog('UNKNOWN_TRIGGER_TYPE', null);
      return null;
  }
}

/**
 * Check if a timestamp is within the cutoff window
 */
function isWithinCutoffWindow(
  timestamp: number,
  periodEnd: number,
  cutoffTime: string,
  timezone: string
): boolean {
  // Parse cutoff time (e.g., "17:00")
  const [hours, minutes] = cutoffTime.split(':').map(Number);
  
  // Create the cutoff datetime for the period end day
  const cutoffDate = new Date(periodEnd);
  cutoffDate.setHours(hours, minutes, 0, 0);
  
  // If timestamp is before the cutoff on the period end day, it's included
  return timestamp <= cutoffDate.getTime();
}

// ============================================
// QUERIES
// ============================================

/**
 * Get all settlements for an organization
 */
export const listForOrganization = query({
  args: {
    workosOrgId: v.string(),
    status: v.optional(
      v.union(
        v.literal('DRAFT'),
        v.literal('PENDING'),
        v.literal('APPROVED'),
        v.literal('PAID'),
        v.literal('VOID')
      )
    ),
    payPlanId: v.optional(v.id('payPlans')),
  },
  returns: v.array(
    v.object({
      _id: v.id('driverSettlements'),
      _creationTime: v.number(),
      driverId: v.id('drivers'),
      driverName: v.string(),
      workosOrgId: v.string(),
      periodStart: v.float64(),
      periodEnd: v.float64(),
      // Pay Plan fields
      payPlanId: v.optional(v.id('payPlans')),
      periodNumber: v.optional(v.number()),
      payPlanName: v.optional(v.string()),
      periodLabel: v.string(),
      // Status
      status: v.union(
        v.literal('DRAFT'),
        v.literal('PENDING'),
        v.literal('APPROVED'),
        v.literal('PAID'),
        v.literal('VOID')
      ),
      grossTotal: v.optional(v.float64()),
      totalMiles: v.optional(v.float64()),
      totalLoads: v.optional(v.number()),
      totalManualAdjustments: v.optional(v.float64()),
      statementNumber: v.string(),
      approvedBy: v.optional(v.string()),
      approvedAt: v.optional(v.float64()),
      paidAt: v.optional(v.float64()),
      paidMethod: v.optional(v.string()),
      paidReference: v.optional(v.string()),
      notes: v.optional(v.string()),
      voidedBy: v.optional(v.string()),
      voidedAt: v.optional(v.float64()),
      voidReason: v.optional(v.string()),
      createdAt: v.float64(),
      createdBy: v.string(),
      updatedAt: v.float64(),
      // Audit flags for dashboard
      hasAuditWarnings: v.boolean(),
    })
  ),
  handler: async (ctx, args) => {
    let dbQuery = ctx.db
      .query('driverSettlements')
      .withIndex('by_org_status', (q) => q.eq('workosOrgId', args.workosOrgId));

    let settlements = await dbQuery.collect();

    // Filter by status if provided
    if (args.status) {
      settlements = settlements.filter((s) => s.status === args.status);
    }

    // Filter by payPlanId if provided
    if (args.payPlanId) {
      settlements = settlements.filter((s) => s.payPlanId === args.payPlanId);
    }

    // Enrich with driver names and format period labels
    const enrichedSettlements = await Promise.all(
      settlements.map(async (settlement) => {
        const driver = await ctx.db.get(settlement.driverId);
        const driverName = driver
          ? `${driver.firstName} ${driver.lastName}`
          : 'Unknown Driver';

        // Format period label: "Period X • Jan 2 - Jan 8"
        const formatDate = (timestamp: number) => {
          const d = new Date(timestamp);
          return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        };
        
        const periodLabel = settlement.periodNumber
          ? `Period ${settlement.periodNumber} • ${formatDate(settlement.periodStart)} - ${formatDate(settlement.periodEnd)}`
          : `${formatDate(settlement.periodStart)} - ${formatDate(settlement.periodEnd)}`;

        // Check for audit warnings (missing PODs, variance issues)
        const payables = await ctx.db
          .query('loadPayables')
          .filter((q) => q.eq(q.field('settlementId'), settlement._id))
          .collect();

        let hasAuditWarnings = false;
        for (const payable of payables) {
          if (payable.loadId) {
            const load = await ctx.db.get(payable.loadId);
            if (load && !load.podStorageId) {
              hasAuditWarnings = true;
              break;
            }
          }
        }

        return {
          ...settlement,
          driverName,
          periodLabel,
          hasAuditWarnings,
        };
      })
    );

    return enrichedSettlements.sort((a, b) => b.periodStart - a.periodStart);
  },
});

/**
 * Get all settlements for a driver
 */
export const listForDriver = query({
  args: {
    driverId: v.id('drivers'),
    status: v.optional(
      v.union(
        v.literal('DRAFT'),
        v.literal('PENDING'),
        v.literal('APPROVED'),
        v.literal('PAID'),
        v.literal('VOID')
      )
    ),
  },
  returns: v.array(
    v.object({
      _id: v.id('driverSettlements'),
      _creationTime: v.number(),
      driverId: v.id('drivers'),
      workosOrgId: v.string(),
      periodStart: v.float64(),
      periodEnd: v.float64(),
      status: v.union(
        v.literal('DRAFT'),
        v.literal('PENDING'),
        v.literal('APPROVED'),
        v.literal('PAID'),
        v.literal('VOID')
      ),
      grossTotal: v.optional(v.float64()),
      totalMiles: v.optional(v.float64()),
      totalLoads: v.optional(v.number()),
      totalManualAdjustments: v.optional(v.float64()),
      statementNumber: v.string(),
      approvedBy: v.optional(v.string()),
      approvedAt: v.optional(v.float64()),
      paidAt: v.optional(v.float64()),
      paidMethod: v.optional(v.string()),
      paidReference: v.optional(v.string()),
      notes: v.optional(v.string()),
      voidedBy: v.optional(v.string()),
      voidedAt: v.optional(v.float64()),
      voidReason: v.optional(v.string()),
      createdAt: v.float64(),
      createdBy: v.string(),
      updatedAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    let query = ctx.db
      .query('driverSettlements')
      .withIndex('by_driver', (q) => q.eq('driverId', args.driverId));

    const settlements = await query.collect();

    // Filter by status if provided
    if (args.status) {
      return settlements.filter((s) => s.status === args.status);
    }

    return settlements.sort((a, b) => b.periodStart - a.periodStart);
  },
});

/**
 * Get detailed settlement view with variance detection
 * This is the "Power User Auditor View"
 */
export const getSettlementDetails = query({
  args: {
    settlementId: v.id('driverSettlements'),
  },
  returns: v.object({
    settlement: v.object({
      _id: v.id('driverSettlements'),
      _creationTime: v.number(),
      driverId: v.id('drivers'),
      workosOrgId: v.string(),
      periodStart: v.float64(),
      periodEnd: v.float64(),
      // Pay Plan fields
      payPlanId: v.optional(v.id('payPlans')),
      periodNumber: v.optional(v.number()),
      payPlanName: v.optional(v.string()),
      // Status
      status: v.union(
        v.literal('DRAFT'),
        v.literal('PENDING'),
        v.literal('APPROVED'),
        v.literal('PAID'),
        v.literal('VOID')
      ),
      grossTotal: v.optional(v.float64()),
      totalMiles: v.optional(v.float64()),
      totalLoads: v.optional(v.number()),
      totalManualAdjustments: v.optional(v.float64()),
      statementNumber: v.string(),
      approvedBy: v.optional(v.string()),
      approvedAt: v.optional(v.float64()),
      paidAt: v.optional(v.float64()),
      paidMethod: v.optional(v.string()),
      paidReference: v.optional(v.string()),
      notes: v.optional(v.string()),
      voidedBy: v.optional(v.string()),
      voidedAt: v.optional(v.float64()),
      voidReason: v.optional(v.string()),
      createdAt: v.float64(),
      createdBy: v.string(),
      updatedAt: v.float64(),
    }),
    driver: v.object({
      _id: v.id('drivers'),
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
    }),
    payables: v.array(
      v.object({
        _id: v.id('loadPayables'),
        loadId: v.optional(v.id('loadInformation')),
        loadInternalId: v.optional(v.string()),
        loadOrderNumber: v.optional(v.string()),
        description: v.string(),
        quantity: v.float64(),
        rate: v.float64(),
        totalAmount: v.float64(),
        sourceType: v.union(v.literal('SYSTEM'), v.literal('MANUAL')),
        isLocked: v.boolean(),
        warningMessage: v.optional(v.string()),
        receiptStorageId: v.optional(v.id('_storage')),
        isRebillable: v.optional(v.boolean()),
        createdAt: v.float64(),
      })
    ),
    heldPayables: v.array(
      v.object({
        _id: v.id('loadPayables'),
        loadId: v.optional(v.id('loadInformation')),
        loadInternalId: v.optional(v.string()),
        loadOrderNumber: v.optional(v.string()),
        description: v.string(),
        quantity: v.float64(),
        rate: v.float64(),
        totalAmount: v.float64(),
        sourceType: v.union(v.literal('SYSTEM'), v.literal('MANUAL')),
        isLocked: v.boolean(),
        createdAt: v.float64(),
      })
    ),
    auditFlags: v.object({
      missingPods: v.array(
        v.object({
          loadId: v.id('loadInformation'),
          loadInternalId: v.string(),
          orderNumber: v.string(),
        })
      ),
      mileageVariances: v.array(
        v.object({
          loadId: v.id('loadInformation'),
          loadInternalId: v.string(),
          payableQuantity: v.float64(),
          loadEffectiveMiles: v.float64(),
          variance: v.float64(),
          percentVariance: v.float64(),
          level: v.union(v.literal('INFO'), v.literal('WARNING')),
        })
      ),
      missingReceipts: v.array(
        v.object({
          payableId: v.id('loadPayables'),
          description: v.string(),
          amount: v.float64(),
        })
      ),
    }),
    summary: v.object({
      totalGross: v.float64(),
      systemCalculated: v.float64(),
      manualAdjustments: v.float64(),
      totalMiles: v.float64(),
      totalHours: v.float64(),
      uniqueLoads: v.number(),
      averageRatePerMile: v.optional(v.float64()),
    }),
  }),
  handler: async (ctx, args) => {
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    // Get driver info
    const driver = await ctx.db.get(settlement.driverId);
    if (!driver) throw new Error('Driver not found');

    // Get all payables for this settlement (including recently held ones)
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
      .collect();

    // Also get recently held payables for this driver (for visibility in UI)
    // These are payables whose loads are marked as held
    const allDriverPayables = await ctx.db
      .query('loadPayables')
      .withIndex('by_driver', (q) => q.eq('driverId', settlement.driverId))
      .collect();
    
    const heldPayables: typeof payables = [];
    for (const payable of allDriverPayables) {
      if (!payable.settlementId && payable.loadId) {
        const load = await ctx.db.get(payable.loadId);
        if (load?.isHeld === true) {
          heldPayables.push(payable);
        }
      }
    }

    // Enrich payables with load details and map to return type
    const enrichedPayables = await Promise.all(
      payables.map(async (payable) => {
        let loadInternalId: string | undefined = undefined;
        let loadOrderNumber: string | undefined = undefined;

        if (payable.loadId) {
          const load = await ctx.db.get(payable.loadId);
          loadInternalId = load?.internalId;
          loadOrderNumber = load?.orderNumber;
        }

        // Map to return type (only include validated fields)
        return {
          _id: payable._id,
          loadId: payable.loadId,
          loadInternalId,
          loadOrderNumber,
          description: payable.description,
          quantity: payable.quantity,
          rate: payable.rate,
          totalAmount: payable.totalAmount,
          sourceType: payable.sourceType,
          isLocked: payable.isLocked,
          warningMessage: payable.warningMessage,
          receiptStorageId: payable.receiptStorageId,
          isRebillable: payable.isRebillable,
          createdAt: payable.createdAt,
        };
      })
    );

    // Audit Flags - The "Power User" variance detection
    const missingPods: Array<{
      loadId: Id<'loadInformation'>;
      loadInternalId: string;
      orderNumber: string;
    }> = [];
    const mileageVariances: Array<{
      loadId: Id<'loadInformation'>;
      loadInternalId: string;
      payableQuantity: number;
      loadEffectiveMiles: number;
      variance: number;
      percentVariance: number;
      level: 'INFO' | 'WARNING';
    }> = [];
    const missingReceipts: Array<{
      payableId: Id<'loadPayables'>;
      description: string;
      amount: number;
    }> = [];

    // Check each payable for audit issues
    const uniqueLoadIds = new Set<Id<'loadInformation'>>();
    for (const payable of payables) {
      if (payable.loadId) {
        uniqueLoadIds.add(payable.loadId);
        const load = await ctx.db.get(payable.loadId);

        // POD Check
        if (load && !load.hasSignedPod) {
          if (!missingPods.find((p) => p.loadId === load._id)) {
            missingPods.push({
              loadId: load._id,
              loadInternalId: load.internalId,
              orderNumber: load.orderNumber,
            });
          }
        }

        // Mileage Variance Check (for mileage-based pay)
        if (load && payable.sourceType === 'SYSTEM' && payable.quantity > 0) {
          const varianceCheck = calculateMileageVariance(
            payable.quantity,
            load.effectiveMiles
          );
          if (varianceCheck.level !== 'OK') {
            mileageVariances.push({
              loadId: load._id,
              loadInternalId: load.internalId,
              payableQuantity: payable.quantity,
              loadEffectiveMiles: load.effectiveMiles ?? 0,
              variance: varianceCheck.variance,
              percentVariance: varianceCheck.percentVariance,
              level: varianceCheck.level,
            });
          }
        }
      }

      // Receipt Check (for manual adjustments)
      if (
        payable.sourceType === 'MANUAL' &&
        payable.totalAmount > 0 &&
        !payable.receiptStorageId
      ) {
        missingReceipts.push({
          payableId: payable._id,
          description: payable.description,
          amount: payable.totalAmount,
        });
      }
    }

    // Enrich held payables with load details
    const enrichedHeldPayables = await Promise.all(
      heldPayables.map(async (payable) => {
        let loadInternalId: string | undefined = undefined;
        let loadOrderNumber: string | undefined = undefined;

        if (payable.loadId) {
          const load = await ctx.db.get(payable.loadId);
          loadInternalId = load?.internalId;
          loadOrderNumber = load?.orderNumber;
        }

        return {
          _id: payable._id,
          loadId: payable.loadId,
          loadInternalId,
          loadOrderNumber,
          description: payable.description,
          quantity: payable.quantity,
          rate: payable.rate,
          totalAmount: payable.totalAmount,
          sourceType: payable.sourceType,
          isLocked: payable.isLocked,
          createdAt: payable.createdAt,
        };
      })
    );

    // Calculate summary
    const totalGross = payables.reduce((sum, p) => sum + p.totalAmount, 0);
    const systemCalculated = payables
      .filter((p) => p.sourceType === 'SYSTEM')
      .reduce((sum, p) => sum + p.totalAmount, 0);
    const manualAdjustments = payables
      .filter((p) => p.sourceType === 'MANUAL')
      .reduce((sum, p) => sum + p.totalAmount, 0);
    const totalMiles = payables
      .filter((p) => p.sourceType === 'SYSTEM')
      .reduce((sum, p) => sum + p.quantity, 0);
    
    // Calculate total hours (from hour-based payables)
    const totalHours = payables
      .filter((p) => 
        p.description.toLowerCase().includes('hour') || 
        p.description.toLowerCase().includes('hr') ||
        p.description.toLowerCase().includes('layover') ||
        p.description.toLowerCase().includes('detention')
      )
      .reduce((sum, p) => sum + p.quantity, 0);
    
    const averageRatePerMile = totalMiles > 0 ? totalGross / totalMiles : undefined;

    return {
      settlement,
      driver: {
        _id: driver._id,
        firstName: driver.firstName,
        lastName: driver.lastName,
        email: driver.email,
      },
      payables: enrichedPayables,
      heldPayables: enrichedHeldPayables,
      auditFlags: {
        missingPods,
        mileageVariances,
        missingReceipts,
      },
      summary: {
        totalGross,
        systemCalculated,
        manualAdjustments,
        totalMiles,
        totalHours,
        uniqueLoads: uniqueLoadIds.size,
        averageRatePerMile,
      },
    };
  },
});

/**
 * Update a manual payable
 * Only works for MANUAL items in DRAFT settlements
 */
export const updateManualPayable = mutation({
  args: {
    payableId: v.id('loadPayables'),
    description: v.string(),
    quantity: v.float64(),
    rate: v.float64(),
    isRebillable: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    
    if (!payable) {
      throw new Error('Payable not found');
    }
    
    if (payable.sourceType !== 'MANUAL') {
      throw new Error('Can only edit manual adjustments');
    }
    
    // Check if settlement is locked (APPROVED or later)
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && settlement.status !== 'DRAFT') {
        throw new Error('Cannot edit payables in approved settlements');
      }
    }
    
    // Calculate new total
    const totalAmount = args.quantity * args.rate;
    
    await ctx.db.patch(args.payableId, {
      description: args.description,
      quantity: args.quantity,
      rate: args.rate,
      totalAmount,
      isRebillable: args.isRebillable,
      updatedAt: Date.now(),
    });
    
    return { success: true, message: 'Manual adjustment updated' };
  },
});

/**
 * Delete a manual payable
 * Only works for MANUAL items in DRAFT settlements
 */
export const deleteManualPayable = mutation({
  args: {
    payableId: v.id('loadPayables'),
  },
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    
    if (!payable) {
      throw new Error('Payable not found');
    }
    
    if (payable.sourceType !== 'MANUAL') {
      throw new Error('Can only delete manual adjustments');
    }
    
    // Check if settlement is locked (APPROVED or later)
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && settlement.status !== 'DRAFT') {
        throw new Error('Cannot delete payables from approved settlements');
      }
    }
    
    await ctx.db.delete(args.payableId);
    
    return { success: true, message: 'Manual adjustment deleted' };
  },
});

/**
 * Get unassigned payables for a driver
 * Used to preview what will be included in the next statement
 */
export const getUnassignedPayables = query({
  args: {
    driverId: v.id('drivers'),
    periodStart: v.optional(v.float64()),
    periodEnd: v.optional(v.float64()),
  },
  returns: v.object({
    unassignedPayables: v.array(
      v.object({
        _id: v.id('loadPayables'),
        loadId: v.optional(v.id('loadInformation')),
        loadInternalId: v.optional(v.string()),
        description: v.string(),
        totalAmount: v.float64(),
        createdAt: v.float64(),
        isHeld: v.boolean(),
      })
    ),
    heldPayables: v.array(
      v.object({
        _id: v.id('loadPayables'),
        loadId: v.optional(v.id('loadInformation')),
        loadInternalId: v.optional(v.string()),
        description: v.string(),
        totalAmount: v.float64(),
        createdAt: v.float64(),
        heldReason: v.optional(v.string()),
      })
    ),
    totalUnassigned: v.float64(),
    totalHeld: v.float64(),
  }),
  handler: async (ctx, args) => {
    // Get all payables without a settlement
    const allUnassigned = await ctx.db
      .query('loadPayables')
      .withIndex('by_driver_unassigned', (q) =>
        q.eq('driverId', args.driverId).eq('settlementId', undefined)
      )
      .collect();

    // Separate into regular and held
    const unassignedPayables: Array<any> = [];
    const heldPayables: Array<any> = [];

    for (const payable of allUnassigned) {
      // Check if load is held
      let isHeld = false;
      let heldReason: string | undefined;

      if (payable.loadId) {
        const load = await ctx.db.get(payable.loadId);
        if (load?.isHeld) {
          isHeld = true;
          heldReason = load.heldReason;
        }
      }

      const enriched = {
        _id: payable._id,
        loadId: payable.loadId,
        loadInternalId: payable.loadId
          ? (await ctx.db.get(payable.loadId))?.internalId
          : undefined,
        description: payable.description,
        totalAmount: payable.totalAmount,
        createdAt: payable.createdAt,
      };

      if (isHeld) {
        heldPayables.push({ ...enriched, heldReason });
      } else {
        // Apply date filter if provided
        if (args.periodStart && payable.createdAt < args.periodStart) continue;
        if (args.periodEnd && payable.createdAt > args.periodEnd) continue;
        unassignedPayables.push({ ...enriched, isHeld: false });
      }
    }

    const totalUnassigned = unassignedPayables.reduce((sum, p) => sum + p.totalAmount, 0);
    const totalHeld = heldPayables.reduce((sum, p) => sum + p.totalAmount, 0);

    return {
      unassignedPayables,
      heldPayables,
      totalUnassigned,
      totalHeld,
    };
  },
});

// ============================================
// MUTATIONS
// ============================================

/**
 * Generate a new settlement statement
 * The "Payroll Run" wizard - gathers all unassigned payables
 */
export const generateStatement = mutation({
  args: {
    driverId: v.id('drivers'),
    periodStart: v.float64(),
    periodEnd: v.float64(),
    workosOrgId: v.string(),
    userId: v.string(),
    includeHeldItems: v.optional(v.boolean()), // Should we pull in previously held items?
  },
  returns: v.object({
    settlementId: v.id('driverSettlements'),
    statementNumber: v.string(),
    payablesAssigned: v.number(),
    grossTotal: v.float64(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();

    // Generate statement number
    const statementNumber = await generateStatementNumber(ctx, args.workosOrgId);

    // Find all unassigned payables in the date range
    const allUnassigned = await ctx.db
      .query('loadPayables')
      .withIndex('by_driver_unassigned', (q) =>
        q.eq('driverId', args.driverId).eq('settlementId', undefined)
      )
      .collect();

    // Filter payables
    const payablesToAssign: Array<Id<'loadPayables'>> = [];
    let grossTotal = 0;

    for (const payable of allUnassigned) {
      // Check if load is held
      let isLoadHeld = false;
      if (payable.loadId) {
        const load = await ctx.db.get(payable.loadId);
        if (load?.isHeld) {
          isLoadHeld = true;
        }
      }

      // Include logic:
      // 1. If held and includeHeldItems=true, include it
      // 2. If not held and within date range, include it
      // 3. Otherwise skip

      if (isLoadHeld) {
        if (args.includeHeldItems) {
          payablesToAssign.push(payable._id);
          grossTotal += payable.totalAmount;
        }
      } else {
        // Check date range
        if (payable.createdAt >= args.periodStart && payable.createdAt <= args.periodEnd) {
          payablesToAssign.push(payable._id);
          grossTotal += payable.totalAmount;
        }
      }
    }

    // Create the settlement
    const settlementId = await ctx.db.insert('driverSettlements', {
      driverId: args.driverId,
      workosOrgId: args.workosOrgId,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      status: 'DRAFT',
      statementNumber,
      createdAt: now,
      createdBy: args.userId,
      updatedAt: now,
    });

    // Assign payables to settlement
    for (const payableId of payablesToAssign) {
      await ctx.db.patch(payableId, {
        settlementId,
        updatedAt: now,
      });
    }

    return {
      settlementId,
      statementNumber,
      payablesAssigned: payablesToAssign.length,
      grossTotal,
    };
  },
});

/**
 * Update settlement status with approval workflow
 * When moving to APPROVED, freeze the totals
 */
export const updateSettlementStatus = mutation({
  args: {
    settlementId: v.id('driverSettlements'),
    newStatus: v.union(
      v.literal('DRAFT'),
      v.literal('PENDING'),
      v.literal('APPROVED'),
      v.literal('PAID'),
      v.literal('VOID')
    ),
    userId: v.string(),
    notes: v.optional(v.string()),
    paidMethod: v.optional(v.string()),
    paidReference: v.optional(v.string()),
    voidReason: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    const now = Date.now();
    const updates: Partial<Doc<'driverSettlements'>> = {
      status: args.newStatus,
      updatedAt: now,
    };

    // Status-specific logic
    if (args.newStatus === 'APPROVED') {
      // FREEZE the totals - calculate and lock
      const payables = await ctx.db
        .query('loadPayables')
        .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
        .collect();

      const grossTotal = payables.reduce((sum, p) => sum + p.totalAmount, 0);
      const totalMiles = payables
        .filter((p) => p.sourceType === 'SYSTEM')
        .reduce((sum, p) => sum + p.quantity, 0);
      const totalManualAdjustments = payables
        .filter((p) => p.sourceType === 'MANUAL')
        .reduce((sum, p) => sum + p.totalAmount, 0);

      // Count unique loads
      const uniqueLoadIds = new Set<string>();
      for (const payable of payables) {
        if (payable.loadId) {
          uniqueLoadIds.add(payable.loadId);
        }
      }

      updates.grossTotal = grossTotal;
      updates.totalMiles = totalMiles;
      updates.totalLoads = uniqueLoadIds.size;
      updates.totalManualAdjustments = totalManualAdjustments;
      updates.approvedBy = args.userId;
      updates.approvedAt = now;

      // Set approvedAt on all payables (for APPROVAL_DATE trigger in Pay Plans)
      for (const payable of payables) {
        await ctx.db.patch(payable._id, {
          approvedAt: now,
          isLocked: true, // Lock payables when settlement is approved
          updatedAt: now,
        });
      }
    } else if (args.newStatus === 'PAID') {
      updates.paidAt = now;
      updates.paidMethod = args.paidMethod;
      updates.paidReference = args.paidReference;
    } else if (args.newStatus === 'VOID') {
      updates.voidedBy = args.userId;
      updates.voidedAt = now;
      updates.voidReason = args.voidReason;
    }

    if (args.notes) {
      updates.notes = args.notes;
    }

    await ctx.db.patch(args.settlementId, updates);

    return null;
  },
});

/**
 * Add a manual adjustment to a settlement
 * This is the "Quick Add" feature for accountants
 */
export const addManualAdjustment = mutation({
  args: {
    settlementId: v.id('driverSettlements'),
    driverId: v.id('drivers'),
    loadId: v.optional(v.id('loadInformation')),
    description: v.string(),
    amount: v.float64(),
    isRebillable: v.optional(v.boolean()),
    workosOrgId: v.string(),
    userId: v.string(),
  },
  returns: v.id('loadPayables'),
  handler: async (ctx, args) => {
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    // Cannot add to approved/paid settlements
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') {
      throw new Error('Cannot add adjustments to approved or paid settlements');
    }

    const now = Date.now();

    const payableId = await ctx.db.insert('loadPayables', {
      loadId: args.loadId,
      legId: undefined,
      driverId: args.driverId,
      settlementId: args.settlementId,
      description: args.description,
      quantity: 1,
      rate: args.amount,
      totalAmount: args.amount,
      sourceType: 'MANUAL',
      isLocked: true, // Manual adjustments are always locked
      isRebillable: args.isRebillable,
      workosOrgId: args.workosOrgId,
      createdAt: now,
      createdBy: args.userId,
      updatedAt: now,
    });

    return payableId;
  },
});

/**
 * Remove a payable from a settlement (unassign it)
 */
export const removePayableFromSettlement = mutation({
  args: {
    payableId: v.id('loadPayables'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const payable = await ctx.db.get(args.payableId);
    if (!payable) throw new Error('Payable not found');

    if (!payable.settlementId) {
      throw new Error('Payable is not assigned to a settlement');
    }

    const settlement = await ctx.db.get(payable.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    // Cannot remove from approved/paid settlements
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') {
      throw new Error('Cannot remove payables from approved or paid settlements');
    }

    await ctx.db.patch(args.payableId, {
      settlementId: undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Delete a settlement (must be DRAFT or VOID)
 * - Load-based payables are UNASSIGNED (can be picked up by next settlement)
 * - Standalone adjustments are PERMANENTLY DELETED (they're per-statement)
 */
export const deleteSettlement = mutation({
  args: {
    settlementId: v.id('driverSettlements'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    // Can only delete DRAFT or VOID settlements
    if (settlement.status !== 'DRAFT' && settlement.status !== 'VOID') {
      throw new Error('Can only delete DRAFT or VOID settlements');
    }

    // Get all payables for this settlement
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
      .collect();

    for (const payable of payables) {
      // Standalone adjustments (no loadId) are deleted permanently
      // They were added specifically for this statement
      if (!payable.loadId) {
        await ctx.db.delete(payable._id);
        continue;
      }
      
      // Load-based payables are unassigned so they can be picked up by next settlement
      await ctx.db.patch(payable._id, {
        settlementId: undefined,
        updatedAt: Date.now(),
      });
    }

    // Delete the settlement
    await ctx.db.delete(args.settlementId);

    return null;
  },
});

/**
 * Refresh a DRAFT settlement with the latest payables
 * - Unassigns current load-based payables
 * - Deletes standalone adjustments (they're per-statement)
 * - Re-queries for eligible payables in the period
 * - Re-assigns to the same statement
 */
export const refreshDraftSettlement = mutation({
  args: {
    settlementId: v.id('driverSettlements'),
  },
  returns: v.object({
    payablesAdded: v.number(),
    payablesRemoved: v.number(),
    grossTotal: v.float64(),
  }),
  handler: async (ctx, args) => {
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');

    // Can only refresh DRAFT settlements
    if (settlement.status !== 'DRAFT') {
      throw new Error('Can only refresh DRAFT settlements');
    }

    // Get current payables
    const currentPayables = await ctx.db
      .query('loadPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
      .collect();

    const previousCount = currentPayables.length;

    // Unassign load-based payables, delete standalone adjustments
    for (const payable of currentPayables) {
      if (!payable.loadId) {
        // Standalone adjustment - delete it
        await ctx.db.delete(payable._id);
      } else {
        // Load-based - unassign it
        await ctx.db.patch(payable._id, {
          settlementId: undefined,
          updatedAt: Date.now(),
        });
      }
    }

    // Get the driver's pay plan
    const driver = await ctx.db.get(settlement.driverId);
    if (!driver) throw new Error('Driver not found');

    let payablesToAssign: Array<Id<'loadPayables'>> = [];
    let grossTotal = 0;

    // If driver has a pay plan, use plan-aware filtering
    if (driver.payPlanId && settlement.payPlanId) {
      const plan = await ctx.db.get(driver.payPlanId);
      if (plan && plan.isActive) {
        // Resolve timezone
        let timezone = plan.timezone;
        if (!timezone) {
          const org = await ctx.db
            .query('organizations')
            .withIndex('by_organization', (q: any) => q.eq('workosOrgId', settlement.workosOrgId))
            .first();
          timezone = org?.defaultTimezone || 'America/New_York';
        }

        // Find all unassigned payables for this driver
        const allUnassigned = await ctx.db
          .query('loadPayables')
          .withIndex('by_driver_unassigned', (q) =>
            q.eq('driverId', settlement.driverId).eq('settlementId', undefined)
          )
          .collect();

        const periodStart = new Date(settlement.periodStart);
        const periodEnd = new Date(settlement.periodEnd);

        for (const payable of allUnassigned) {
          // Check if load is held
          let isLoadHeld = false;
          if (payable.loadId) {
            const load = await ctx.db.get(payable.loadId);
            if (load?.isHeld) {
              isLoadHeld = true;
            }
          }

          // Skip held loads
          if (isLoadHeld) continue;

          // Get the trigger timestamp based on plan configuration
          const triggerTimestamp = await getPayableTriggerTimestamp(ctx, payable, plan.payableTrigger);
          
          if (!triggerTimestamp) {
            // Skip payables without a valid trigger timestamp
            continue;
          }

          // Check if within period
          const withinPeriod = 
            triggerTimestamp >= periodStart.getTime() && 
            triggerTimestamp <= periodEnd.getTime();

          if (withinPeriod) {
            // Check cutoff time
            const withinCutoff = isWithinCutoffWindow(
              triggerTimestamp,
              periodEnd.getTime(),
              plan.cutoffTime,
              timezone
            );

            if (withinCutoff) {
              payablesToAssign.push(payable._id);
              grossTotal += payable.totalAmount;
            }
          }
        }
      }
    } else {
      // No pay plan - use simple date range filtering
      const allUnassigned = await ctx.db
        .query('loadPayables')
        .withIndex('by_driver_unassigned', (q) =>
          q.eq('driverId', settlement.driverId).eq('settlementId', undefined)
        )
        .collect();

      for (const payable of allUnassigned) {
        // Check if load is held
        let isLoadHeld = false;
        if (payable.loadId) {
          const load = await ctx.db.get(payable.loadId);
          if (load?.isHeld) {
            isLoadHeld = true;
          }
        }

        // Skip held loads
        if (isLoadHeld) continue;

        // Simple date range check using createdAt
        const triggerTime = payable.createdAt;
        if (triggerTime >= settlement.periodStart && triggerTime <= settlement.periodEnd) {
          payablesToAssign.push(payable._id);
          grossTotal += payable.totalAmount;
        }
      }
    }

    // Assign payables to this settlement
    for (const payableId of payablesToAssign) {
      await ctx.db.patch(payableId, {
        settlementId: args.settlementId,
        updatedAt: Date.now(),
      });
    }

    // Update settlement totals
    await ctx.db.patch(args.settlementId, {
      grossTotal,
      updatedAt: Date.now(),
    });

    return {
      payablesAdded: payablesToAssign.length,
      payablesRemoved: previousCount,
      grossTotal,
    };
  },
});

// ============================================
// PAY PLAN-AWARE SETTLEMENT GENERATION
// ============================================

/**
 * Generate a settlement using the driver's assigned Pay Plan
 * Auto-calculates period dates based on plan configuration
 */
export const generateStatementFromPlan = mutation({
  args: {
    driverId: v.id('drivers'),
    workosOrgId: v.string(),
    userId: v.string(),
    includeHeldItems: v.optional(v.boolean()),
    referenceDate: v.optional(v.float64()), // Override reference date for testing
  },
  returns: v.object({
    settlementId: v.id('driverSettlements'),
    statementNumber: v.string(),
    payablesAssigned: v.number(),
    grossTotal: v.float64(),
    periodStart: v.float64(),
    periodEnd: v.float64(),
    planName: v.string(),
  }),
  handler: async (ctx, args) => {
    const driver = await ctx.db.get(args.driverId);
    if (!driver) throw new Error('Driver not found');
    if (!driver.payPlanId) throw new Error('Driver has no Pay Plan assigned');

    const plan = await ctx.db.get(driver.payPlanId);
    if (!plan) throw new Error('Pay Plan not found');
    if (!plan.isActive) throw new Error('Pay Plan is inactive');

    const now = Date.now();
    const refDate = args.referenceDate ? new Date(args.referenceDate) : new Date();

    // Calculate period dates from the plan
    const { periodStart, periodEnd } = calculatePlanPeriod(plan, refDate);

    // Resolve timezone
    let timezone = plan.timezone;
    if (!timezone) {
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_organization', (q: any) => q.eq('workosOrgId', args.workosOrgId))
        .first();
      timezone = org?.defaultTimezone || 'America/New_York';
    }

    // Generate statement number
    const statementNumber = await generateStatementNumber(ctx, args.workosOrgId);

    // Find all unassigned payables
    const allUnassigned = await ctx.db
      .query('loadPayables')
      .withIndex('by_driver_unassigned', (q) =>
        q.eq('driverId', args.driverId).eq('settlementId', undefined)
      )
      .collect();

    // Filter payables based on plan trigger and cutoff
    const payablesToAssign: Array<Id<'loadPayables'>> = [];
    let grossTotal = 0;

    for (const payable of allUnassigned) {
      // Check if load is held
      let isLoadHeld = false;
      if (payable.loadId) {
        const load = await ctx.db.get(payable.loadId);
        if (load?.isHeld) {
          isLoadHeld = true;
        }
      }

      if (isLoadHeld) {
        // Include held items only if explicitly requested
        if (args.includeHeldItems) {
          payablesToAssign.push(payable._id);
          grossTotal += payable.totalAmount;
        }
        continue;
      }

      // Get the trigger timestamp based on plan configuration
      const triggerTimestamp = await getPayableTriggerTimestamp(ctx, payable, plan.payableTrigger);
      
      if (!triggerTimestamp) {
        // Skip payables without a valid trigger timestamp
        continue;
      }

      // Check if within period and cutoff
      const withinPeriod = 
        triggerTimestamp >= periodStart.getTime() && 
        triggerTimestamp <= periodEnd.getTime();

      if (withinPeriod) {
        // Check cutoff time
        const withinCutoff = isWithinCutoffWindow(
          triggerTimestamp,
          periodEnd.getTime(),
          plan.cutoffTime,
          timezone
        );

        if (withinCutoff) {
          payablesToAssign.push(payable._id);
          grossTotal += payable.totalAmount;
        }
      }
    }

    // Handle standalone adjustments
    if (plan.includeStandaloneAdjustments) {
      const standalonePayables = allUnassigned.filter(p => !p.loadId && !p.legId);
      for (const payable of standalonePayables) {
        if (!payablesToAssign.includes(payable._id)) {
          // Check if created within period
          if (payable.createdAt >= periodStart.getTime() && payable.createdAt <= periodEnd.getTime()) {
            payablesToAssign.push(payable._id);
            grossTotal += payable.totalAmount;
          }
        }
      }
    }

    // Calculate period number
    const yearStart = new Date(periodStart.getFullYear(), 0, 1);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceYearStart = Math.floor((periodStart.getTime() - yearStart.getTime()) / msPerDay);
    
    let periodNumber: number;
    switch (plan.frequency) {
      case 'WEEKLY':
        periodNumber = Math.floor(daysSinceYearStart / 7) + 1;
        break;
      case 'BIWEEKLY':
        periodNumber = Math.floor(daysSinceYearStart / 14) + 1;
        break;
      case 'SEMIMONTHLY':
        const month = periodStart.getMonth();
        const isFirstHalf = periodStart.getDate() <= 15;
        periodNumber = month * 2 + (isFirstHalf ? 1 : 2);
        break;
      case 'MONTHLY':
        periodNumber = periodStart.getMonth() + 1;
        break;
      default:
        periodNumber = 1;
    }

    // Create the settlement with Pay Plan link
    const settlementId = await ctx.db.insert('driverSettlements', {
      driverId: args.driverId,
      workosOrgId: args.workosOrgId,
      periodStart: periodStart.getTime(),
      periodEnd: periodEnd.getTime(),
      payPlanId: plan._id,
      periodNumber,
      payPlanName: plan.name,
      status: 'DRAFT',
      statementNumber,
      createdAt: now,
      createdBy: args.userId,
      updatedAt: now,
    });

    // Assign payables to settlement
    for (const payableId of payablesToAssign) {
      await ctx.db.patch(payableId, {
        settlementId,
        updatedAt: now,
      });
    }

    return {
      settlementId,
      statementNumber,
      payablesAssigned: payablesToAssign.length,
      grossTotal,
      periodStart: periodStart.getTime(),
      periodEnd: periodEnd.getTime(),
      planName: plan.name,
    };
  },
});

/**
 * Bulk generate settlements for all drivers on a specific Pay Plan
 * VERSION: 2026-01-06-v2 (with date filtering fix)
 */
export const bulkGenerateByPlan = mutation({
  args: {
    planId: v.id('payPlans'),
    workosOrgId: v.string(),
    userId: v.string(),
    includeHeldItems: v.optional(v.boolean()),
    referenceDate: v.optional(v.float64()),
  },
  returns: v.object({
    success: v.number(),
    failed: v.number(),
    settlements: v.array(v.object({
      driverId: v.id('drivers'),
      driverName: v.string(),
      settlementId: v.optional(v.id('driverSettlements')),
      statementNumber: v.optional(v.string()),
      grossTotal: v.optional(v.float64()),
      error: v.optional(v.string()),
    })),
  }),
  handler: async (ctx, args) => {
    console.log('🚀 [BULK_GENERATE] VERSION 2026-01-06-v2 - Starting settlement generation with DATE FILTERING FIX');
    
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay Plan not found');
    if (!plan.isActive) throw new Error('Pay Plan is inactive');

    // Get all drivers on this plan
    const drivers = await ctx.db
      .query('drivers')
      .filter((q) =>
        q.and(
          q.eq(q.field('organizationId'), args.workosOrgId),
          q.eq(q.field('payPlanId'), args.planId),
          q.neq(q.field('isDeleted'), true)
        )
      )
      .collect();

    let success = 0;
    let failed = 0;
    const settlements: Array<{
      driverId: Id<'drivers'>;
      driverName: string;
      settlementId?: Id<'driverSettlements'>;
      statementNumber?: string;
      grossTotal?: number;
      error?: string;
    }> = [];

    const now = Date.now();
    const refDate = args.referenceDate ? new Date(args.referenceDate) : new Date();
    const { periodStart, periodEnd } = calculatePlanPeriod(plan, refDate);

    // Calculate period number (periods since start of year)
    const yearStart = new Date(periodStart.getFullYear(), 0, 1);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceYearStart = Math.floor((periodStart.getTime() - yearStart.getTime()) / msPerDay);
    
    let periodNumber: number;
    switch (plan.frequency) {
      case 'WEEKLY':
        periodNumber = Math.floor(daysSinceYearStart / 7) + 1;
        break;
      case 'BIWEEKLY':
        periodNumber = Math.floor(daysSinceYearStart / 14) + 1;
        break;
      case 'SEMIMONTHLY':
        // 2 periods per month
        const month = periodStart.getMonth();
        const isFirstHalf = periodStart.getDate() <= 15;
        periodNumber = month * 2 + (isFirstHalf ? 1 : 2);
        break;
      case 'MONTHLY':
        periodNumber = periodStart.getMonth() + 1;
        break;
      default:
        periodNumber = 1;
    }

    // Resolve timezone once
    let timezone = plan.timezone;
    if (!timezone) {
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_organization', (q: any) => q.eq('workosOrgId', args.workosOrgId))
        .first();
      timezone = org?.defaultTimezone || 'America/New_York';
    }

    for (const driver of drivers) {
      try {
        // Check if driver already has a settlement for this period
        const existingSettlement = await ctx.db
          .query('driverSettlements')
          .withIndex('by_driver_status', (q) => q.eq('driverId', driver._id))
          .filter((q) =>
            q.and(
              q.eq(q.field('periodStart'), periodStart.getTime()),
              q.eq(q.field('periodEnd'), periodEnd.getTime())
            )
          )
          .first();

        if (existingSettlement) {
          settlements.push({
            driverId: driver._id,
            driverName: `${driver.firstName} ${driver.lastName}`,
            error: 'Settlement already exists for this period',
          });
          failed++;
          continue;
        }

        // Find all unassigned payables
        const allUnassigned = await ctx.db
          .query('loadPayables')
          .withIndex('by_driver_unassigned', (q) =>
            q.eq('driverId', driver._id).eq('settlementId', undefined)
          )
          .collect();

        // Filter payables
        const payablesToAssign: Array<Id<'loadPayables'>> = [];
        let grossTotal = 0;

        for (const payable of allUnassigned) {
          let isLoadHeld = false;
          if (payable.loadId) {
            const load = await ctx.db.get(payable.loadId);
            if (load?.isHeld) isLoadHeld = true;
          }

          if (isLoadHeld) {
            if (args.includeHeldItems) {
              payablesToAssign.push(payable._id);
              grossTotal += payable.totalAmount;
            }
            continue;
          }

          const triggerTimestamp = await getPayableTriggerTimestamp(ctx, payable, plan.payableTrigger);
          const payableLabel = payable.loadId ? `LOAD-${payable._id.slice(-8)}` : 'STANDALONE';
          
          if (!triggerTimestamp) {
            console.log(`[PERIOD_CHECK] ${payableLabel} | SKIPPED - no trigger timestamp`);
            continue;
          }

          const withinPeriod =
            triggerTimestamp >= periodStart.getTime() &&
            triggerTimestamp <= periodEnd.getTime();

          console.log(`[PERIOD_CHECK] ${payableLabel} | Trigger: ${new Date(triggerTimestamp).toISOString()} | Period: ${periodStart.toISOString()} - ${periodEnd.toISOString()} | Within: ${withinPeriod}`);

          if (withinPeriod) {
            const withinCutoff = isWithinCutoffWindow(
              triggerTimestamp,
              periodEnd.getTime(),
              plan.cutoffTime,
              timezone!
            );

            if (withinCutoff) {
              payablesToAssign.push(payable._id);
              grossTotal += payable.totalAmount;
            }
          }
        }

        // Handle standalone adjustments
        if (plan.includeStandaloneAdjustments) {
          const standalonePayables = allUnassigned.filter(p => !p.loadId && !p.legId);
          for (const payable of standalonePayables) {
            if (!payablesToAssign.includes(payable._id)) {
              if (payable.createdAt >= periodStart.getTime() && payable.createdAt <= periodEnd.getTime()) {
                payablesToAssign.push(payable._id);
                grossTotal += payable.totalAmount;
              }
            }
          }
        }

        // Skip if no payables
        if (payablesToAssign.length === 0) {
          settlements.push({
            driverId: driver._id,
            driverName: `${driver.firstName} ${driver.lastName}`,
            error: 'No payables found for this period',
          });
          failed++;
          continue;
        }

        // Generate statement number
        const statementNumber = await generateStatementNumber(ctx, args.workosOrgId);

        // Create settlement with Pay Plan link
        const settlementId = await ctx.db.insert('driverSettlements', {
          driverId: driver._id,
          workosOrgId: args.workosOrgId,
          periodStart: periodStart.getTime(),
          periodEnd: periodEnd.getTime(),
          payPlanId: plan._id,
          periodNumber,
          payPlanName: plan.name,
          status: 'DRAFT',
          statementNumber,
          createdAt: now,
          createdBy: args.userId,
          updatedAt: now,
        });

        // Assign payables
        for (const payableId of payablesToAssign) {
          await ctx.db.patch(payableId, {
            settlementId,
            updatedAt: now,
          });
        }

        settlements.push({
          driverId: driver._id,
          driverName: `${driver.firstName} ${driver.lastName}`,
          settlementId,
          statementNumber,
          grossTotal,
        });
        success++;
      } catch (error) {
        settlements.push({
          driverId: driver._id,
          driverName: `${driver.firstName} ${driver.lastName}`,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failed++;
      }
    }

    return { success, failed, settlements };
  },
});

