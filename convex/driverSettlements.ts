import { v } from 'convex/values';
import { mutation, query, internalMutation } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';

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
  // Counter-doc pattern — one read + one write, instead of collecting every
  // settlement in the org per generated statement (the old approach made
  // bulk generation O(n²) and hit Convex's system-operation limit).
  return nextStatementNumber(ctx, { workosOrgId, scope: 'DRIVER' });
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
 * Get the payable's period-inclusion timestamp.
 *
 * Work is attributed to WHEN IT WAS DONE — the load's start (first pickup),
 * resolved by lib/settlementShared.resolveWorkStartTimestamp. The legacy
 * DELIVERY_DATE / COMPLETION_DATE triggers both resolve this way now: those
 * dates (and the old payable.createdAt fallbacks) put work into the wrong
 * period whenever a load delivered or calculated after the period it was
 * driven in. APPROVAL_DATE remains an explicit opt-in gate on approvedAt.
 */
async function getPayableTriggerTimestamp(
  ctx: any,
  payable: Doc<'loadPayables'>,
  triggerType: 'DELIVERY_DATE' | 'COMPLETION_DATE' | 'APPROVAL_DATE',
  caches?: WorkStartCaches
): Promise<number | null> {
  if (triggerType === 'APPROVAL_DATE') {
    return payable.approvedAt || null;
  }
  return resolveWorkStartTimestamp(ctx, payable, caches ?? newWorkStartCaches());
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
      reopenedAt: v.optional(v.float64()),
      reopenedBy: v.optional(v.string()),
      reopenReason: v.optional(v.string()),
      paidAt: v.optional(v.float64()),
      paidBy: v.optional(v.string()),
      paidMethod: v.optional(v.string()),
      paidReference: v.optional(v.string()),
      notes: v.optional(v.string()),
      voidedBy: v.optional(v.string()),
      voidedAt: v.optional(v.float64()),
      voidReason: v.optional(v.string()),
      acknowledgedBlockers: v.optional(v.array(v.object({
        key: v.string(),
        by: v.string(),
        at: v.float64(),
        note: v.optional(v.string()),
      }))),
      createdAt: v.float64(),
      createdBy: v.string(),
      updatedAt: v.float64(),
    })
  ),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) return [];

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
      reopenedAt: v.optional(v.float64()),
      reopenedBy: v.optional(v.string()),
      reopenReason: v.optional(v.string()),
      paidAt: v.optional(v.float64()),
      paidBy: v.optional(v.string()),
      paidMethod: v.optional(v.string()),
      paidReference: v.optional(v.string()),
      notes: v.optional(v.string()),
      voidedBy: v.optional(v.string()),
      voidedAt: v.optional(v.float64()),
      voidReason: v.optional(v.string()),
      acknowledgedBlockers: v.optional(v.array(v.object({
        key: v.string(),
        by: v.string(),
        at: v.float64(),
        note: v.optional(v.string()),
      }))),
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
        category: v.optional(v.union(
          v.literal('EARNING'),
          v.literal('REIMBURSEMENT'),
          v.literal('DEDUCTION'),
        )),
        isLocked: v.boolean(),
        warningMessage: v.optional(v.string()),
        receiptStorageId: v.optional(v.id('_storage')),
        isRebillable: v.optional(v.boolean()),
        createdAt: v.float64(),
        // When the work happened: load first-pickup / session check-in.
        // workEnd is set for shift lines (session check-out) so the panel
        // can render the time range.
        workStart: v.optional(v.float64()),
        workEnd: v.optional(v.float64()),
        // Shift-line linkage — drives the review panel's per-shift pay
        // profile override picker.
        sessionId: v.optional(v.id('driverSessions')),
        sessionPayProfileOverrideId: v.optional(v.id('payProfiles')),
        // Shift lines: the loads run during the session, one reviewable row
        // each (scheduled time + order number + lane).
        shiftLoads: v.optional(v.array(v.object({
          label: v.string(),
          // Actual check-in at the leg's start stop — the reviewable truth.
          actualAt: v.optional(v.float64()),
          // Dispatch-planned start, shown alongside for comparison.
          scheduledAt: v.optional(v.float64()),
          lane: v.optional(v.string()),
        }))),
        // Review-edit state for inline correction (Phase 2).
        edited: v.boolean(),
        breakMinutes: v.optional(v.float64()),
        clockStart: v.optional(v.float64()),
        clockEnd: v.optional(v.float64()),
        originalRate: v.optional(v.float64()),
        originalQuantity: v.optional(v.float64()),
        originalTotalAmount: v.optional(v.float64()),
        // Rules-drift: engine now computes a different amount than this edit.
        rulesChanged: v.boolean(),
        rulesAmount: v.optional(v.float64()),
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
    const callerOrgId = await requireCallerOrgId(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

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
    const detailCaches = newWorkStartCaches();
    const enrichedPayables = await Promise.all(
      payables.map(async (payable) => {
        let loadInternalId: string | undefined = undefined;
        let loadOrderNumber: string | undefined = undefined;

        // When the work happened — shift lines also carry their end time and
        // the loads run during the session.
        const workStart = await resolveWorkStartTimestamp(ctx, payable, detailCaches);
        let workEnd: number | undefined;
        let shiftLoads: ShiftLoadRow[] | undefined;
        let sessionOverrideId: Id<'payProfiles'> | undefined;
        if (payable.sessionId) {
          const sessionKey = payable.sessionId as string;
          let session = detailCaches.sessions.get(sessionKey);
          if (session === undefined) {
            session = ((await ctx.db.get(payable.sessionId)) ?? null) as Doc<'driverSessions'> | null;
            detailCaches.sessions.set(sessionKey, session);
          }
          workEnd = session?.endedAt ?? undefined;
          sessionOverrideId = session?.payProfileOverrideId;

          if (session?.endedAt) {
            shiftLoads = await buildShiftLoadRows(ctx, settlement.driverId, session, detailCaches);
          }
        }

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
          category: payable.category,
          isLocked: payable.isLocked,
          warningMessage: payable.warningMessage,
          receiptStorageId: payable.receiptStorageId,
          isRebillable: payable.isRebillable,
          createdAt: payable.createdAt,
          workStart: workStart ?? undefined,
          workEnd,
          shiftLoads,
          // Shift-line linkage for the review panel's per-shift pay profile
          // override picker.
          sessionId: payable.sessionId,
          sessionPayProfileOverrideId: sessionOverrideId,
          // Review-edit state. Clock window prefers the reviewer override,
          // falling back to the session-derived work start / end.
          edited: payable.editedAt != null,
          breakMinutes: payable.breakMinutes,
          clockStart: payable.overrideStartAt ?? (payable.sessionId ? (workStart ?? undefined) : undefined),
          clockEnd: payable.overrideEndAt ?? (payable.sessionId ? workEnd : undefined),
          originalRate: payable.originalRate,
          originalQuantity: payable.originalQuantity,
          originalTotalAmount: payable.originalTotalAmount,
          rulesChanged: payable.rulesChangedAt != null,
          rulesAmount: payable.rulesAmount,
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const payable = await ctx.db.get(args.payableId);

    if (!payable) {
      throw new Error('Payable not found');
    }
    if (payable.workosOrgId !== callerOrgId) {
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

    await logAudit(ctx, {
      organizationId: payable.workosOrgId,
      entityType: 'loadPayable',
      entityId: args.payableId,
      entityName: args.description,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Updated manual adjustment "${args.description}" to $${totalAmount.toFixed(2)}`,
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const payable = await ctx.db.get(args.payableId);

    if (!payable) {
      throw new Error('Payable not found');
    }
    if (payable.workosOrgId !== callerOrgId) {
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

    await logAudit(ctx, {
      organizationId: payable.workosOrgId,
      entityType: 'loadPayable',
      entityId: args.payableId,
      entityName: payable.description,
      action: 'deleted',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Deleted manual adjustment "${payable.description}" ($${payable.totalAmount.toFixed(2)})`,
    });

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
    const callerOrgId = await requireCallerOrgId(ctx);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) {
      return { unassignedPayables: [], heldPayables: [], totalUnassigned: 0, totalHeld: 0 };
    }

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
    const workStartCaches = newWorkStartCaches();

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
        // Apply date filter if provided — keyed on when the work was done
        // (load start), not when the payable row was created.
        if (args.periodStart || args.periodEnd) {
          const workStart = await resolveWorkStartTimestamp(ctx, payable, workStartCaches);
          if (workStart == null) continue;
          if (args.periodStart && workStart < args.periodStart) continue;
          if (args.periodEnd && workStart > args.periodEnd) continue;
        }
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== callerOrgId) {
      throw new Error('Driver not found');
    }

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

    // Filter payables — period inclusion keys on when the work was done
    // (load start), not when the payable row was created.
    const payablesToAssign: Array<Id<'loadPayables'>> = [];
    let grossTotal = 0;
    const caches = newWorkStartCaches();

    for (const payable of allUnassigned) {
      // Check if load is held
      let isLoadHeld = false;
      if (payable.loadId) {
        const load = await ctx.db.get(payable.loadId);
        caches.loads.set(payable.loadId as string, load ?? null);
        if (load?.isHeld) {
          isLoadHeld = true;
        }
      }

      // Include logic:
      // 1. If held and includeHeldItems=true, include it
      // 2. If not held and work started within the period, include it
      // 3. Otherwise skip

      if (isLoadHeld) {
        if (args.includeHeldItems) {
          payablesToAssign.push(payable._id);
          grossTotal += payable.totalAmount;
        }
      } else {
        const workStart = await resolveWorkStartTimestamp(ctx, payable, caches);
        if (workStart != null && workStart >= args.periodStart && workStart <= args.periodEnd) {
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
      createdBy: userId,
      updatedAt: now,
    });

    // Assign payables to settlement
    for (const payableId of payablesToAssign) {
      await ctx.db.patch(payableId, {
        settlementId,
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'driverSettlement',
      entityId: settlementId,
      entityName: statementNumber,
      action: 'created',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Generated settlement ${statementNumber} for ${driver.firstName} ${driver.lastName} (${new Date(args.periodStart).toLocaleDateString('en-US')} - ${new Date(args.periodEnd).toLocaleDateString('en-US')})`,
    });

    return {
      settlementId,
      statementNumber,
      payablesAssigned: payablesToAssign.length,
      grossTotal,
    };
  },
});

/**
 * Reviewer acknowledges (verifies) a readiness blocker so it no longer gates
 * approval — recorded with who/when for audit. Idempotent per key. The
 * blocker stays visible (shown as verified); only its gating effect lifts.
 */
export const acknowledgeBlocker = mutation({
  args: {
    settlementId: v.id('driverSettlements'),
    blockerKey: v.string(),
    note: v.optional(v.string()),
    userId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== callerOrgId) throw new Error('Settlement not found');
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') {
      throw new Error('Settlement is already finalized');
    }
    const existing = settlement.acknowledgedBlockers ?? [];
    if (existing.some((a) => a.key === args.blockerKey)) return null; // idempotent
    await ctx.db.patch(args.settlementId, {
      acknowledgedBlockers: [...existing, { key: args.blockerKey, by: userId, at: Date.now(), note: args.note }],
      updatedAt: Date.now(),
    });
    return null;
  },
});

/** Undo a blocker acknowledgement (reviewer changed their mind). */
export const unacknowledgeBlocker = mutation({
  args: { settlementId: v.id('driverSettlements'), blockerKey: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== callerOrgId) throw new Error('Settlement not found');
    if (settlement.status === 'APPROVED' || settlement.status === 'PAID') return null;
    await ctx.db.patch(args.settlementId, {
      acknowledgedBlockers: (settlement.acknowledgedBlockers ?? []).filter((a) => a.key !== args.blockerKey),
      updatedAt: Date.now(),
    });
    return null;
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

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
      updates.approvedBy = userId;
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
      updates.paidBy = userId;
      updates.paidMethod = args.paidMethod;
      updates.paidReference = args.paidReference;
    } else if (args.newStatus === 'VOID') {
      updates.voidedBy = userId;
      updates.voidedAt = now;
      updates.voidReason = args.voidReason;
    }

    if (args.notes) {
      updates.notes = args.notes;
    }

    await ctx.db.patch(args.settlementId, updates);

    await logAudit(ctx, {
      organizationId: settlement.workosOrgId,
      entityType: 'driverSettlement',
      entityId: args.settlementId,
      entityName: settlement.statementNumber,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Changed settlement status from ${settlement.status} to ${args.newStatus}`,
      changesBefore: JSON.stringify({ status: settlement.status }),
      changesAfter: JSON.stringify({ status: args.newStatus }),
      changedFields: ['status'],
    });

    return null;
  },
});

/**
 * Reverse a recorded payment: PAID → APPROVED.
 *
 * Undoes a mistaken "Record payment" — restores the settlement to its approved
 * (still-locked) state and clears the payment stamps so it can be re-recorded.
 * Totals stay frozen from approval; payables stay locked. Only a currently-PAID
 * settlement can be reversed.
 */
export const reversePayment = mutation({
  args: {
    settlementId: v.id('driverSettlements'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }
    if (settlement.status !== 'PAID') {
      throw new Error('Only a paid settlement can have its payment reversed');
    }

    await ctx.db.patch(args.settlementId, {
      status: 'APPROVED',
      paidAt: undefined,
      paidBy: undefined,
      paidMethod: undefined,
      paidReference: undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Reopen an APPROVED settlement back to DRAFT to correct a mistake.
 *
 * Reverses everything approval froze: status → DRAFT, clears the settlement's
 * approval stamps, and per line clears the approval stamp + unlocks the
 * auto-generated (SYSTEM, un-edited) lines so the rules engine and the draft
 * edit tools own them again. Reviewer-edited lines and manual adjustments STAY
 * locked so prior corrections survive. Records reopenedBy/At + reason for audit.
 *
 * PAID settlements must have their payment reversed first (reversePayment) —
 * we never silently un-pay. Re-approving stamps a fresh approvedAt.
 */
export const reopenSettlement = mutation({
  args: {
    settlementId: v.id('driverSettlements'),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement || settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }
    if (settlement.status !== 'APPROVED') {
      throw new Error(
        settlement.status === 'PAID'
          ? 'Reverse the payment before reopening a paid settlement'
          : 'Only an approved settlement can be reopened',
      );
    }
    const reason = args.reason.trim();
    if (!reason) throw new Error('A reason is required to reopen a settlement');

    const now = Date.now();
    const payables = await ctx.db
      .query('loadPayables')
      .withIndex('by_settlement', (q) => q.eq('settlementId', args.settlementId))
      .collect();
    for (const p of payables) {
      await ctx.db.patch(p._id, {
        approvedAt: undefined,
        // Keep manual adjustments + reviewer-edited lines locked; return pristine
        // SYSTEM lines to rules-engine control.
        isLocked: p.sourceType === 'MANUAL' || p.editedAt != null,
        updatedAt: now,
      });
    }

    await ctx.db.patch(args.settlementId, {
      status: 'DRAFT',
      approvedBy: undefined,
      approvedAt: undefined,
      reopenedBy: userId,
      reopenedAt: now,
      reopenReason: reason,
      updatedAt: now,
    });

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
    category: v.optional(v.union(
      v.literal('EARNING'),
      v.literal('REIMBURSEMENT'),
      v.literal('DEDUCTION'),
    )),
    workosOrgId: v.string(),
    userId: v.string(),
  },
  returns: v.id('loadPayables'),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

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
      // Deductions are stored as negative amounts; default classification
      // follows the sign unless the caller picks a section explicitly.
      category: args.category ?? (args.amount < 0 ? 'DEDUCTION' : args.isRebillable ? 'REIMBURSEMENT' : 'EARNING'),
      isLocked: true, // Manual adjustments are always locked
      isRebillable: args.isRebillable,
      workosOrgId: args.workosOrgId,
      createdAt: now,
      createdBy: userId,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: settlement.workosOrgId,
      entityType: 'driverSettlement',
      entityId: args.settlementId,
      entityName: settlement.statementNumber,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Added manual adjustment "${args.description}" ($${args.amount.toFixed(2)}) to settlement ${settlement.statementNumber}`,
    });

    return payableId;
  },
});

/**
 * Review-time line edit (Settlement Review modal). Override a SYSTEM line in
 * place and lock it so the rules engine won't overwrite, preserving the
 * original for audit (decisions: override-in-place + keep original; pay-hours
 * override only — the driver session record stays the GPS truth).
 *
 * Shift lines (SESSION_DURATION): pass overrideStartAt / overrideEndAt /
 * breakMinutes and the paid hours derive from the corrected clock span minus
 * break; the rate may also change. Load lines: pass rate (and/or quantity)
 * and the amount recomputes as quantity × rate.
 */
export const editPayableLine = mutation({
  args: {
    payableId: v.id('loadPayables'),
    rate: v.optional(v.float64()),
    quantity: v.optional(v.float64()),
    overrideStartAt: v.optional(v.float64()),
    overrideEndAt: v.optional(v.float64()),
    breakMinutes: v.optional(v.float64()),
    reason: v.optional(v.string()),
    userId: v.string(),
  },
  returns: v.object({ totalAmount: v.float64(), quantity: v.float64(), rate: v.float64() }),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId } = await requireCallerIdentity(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (!payable || payable.workosOrgId !== callerOrgId) throw new Error('Line not found');
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && (settlement.status === 'APPROVED' || settlement.status === 'PAID')) {
        throw new Error('Cannot edit a finalized settlement');
      }
    }

    const now = Date.now();
    const newRate = args.rate != null ? +args.rate.toFixed(4) : payable.rate;

    // Shift line: derive paid hours from the corrected clock span − break.
    const isShift = !!payable.sessionId;
    let newQuantity = args.quantity != null ? args.quantity : payable.quantity;
    let overrideStartAt = payable.overrideStartAt;
    let overrideEndAt = payable.overrideEndAt;
    let breakMinutes = payable.breakMinutes;
    if (isShift && (args.overrideStartAt != null || args.overrideEndAt != null || args.breakMinutes != null || args.quantity == null)) {
      const session = payable.sessionId ? await ctx.db.get(payable.sessionId) : null;
      const baseStart = session?.startedAt ?? payable.overrideStartAt ?? now;
      const baseEnd = session?.endedAt ?? payable.overrideEndAt ?? now;
      overrideStartAt = args.overrideStartAt ?? payable.overrideStartAt ?? baseStart;
      overrideEndAt = args.overrideEndAt ?? payable.overrideEndAt ?? baseEnd;
      breakMinutes = args.breakMinutes ?? payable.breakMinutes ?? 0;
      const hours = Math.max((overrideEndAt - overrideStartAt) / 3_600_000 - breakMinutes / 60, 0);
      newQuantity = +hours.toFixed(2);
    }

    const newTotal = +(newQuantity * newRate).toFixed(2);

    // Stamp the original once, on the first edit.
    const firstEdit = payable.editedAt == null;
    await ctx.db.patch(args.payableId, {
      rate: newRate,
      quantity: newQuantity,
      totalAmount: newTotal,
      ...(isShift ? { overrideStartAt, overrideEndAt, breakMinutes } : {}),
      isLocked: true,
      editedAt: now,
      editedBy: userId,
      editReason: args.reason ?? payable.editReason,
      ...(firstEdit
        ? {
            originalQuantity: payable.quantity,
            originalRate: payable.rate,
            originalTotalAmount: payable.totalAmount,
          }
        : {}),
      updatedAt: now,
    });
    return { totalAmount: newTotal, quantity: newQuantity, rate: newRate };
  },
});

/** Restore a reviewer-edited line to its original system values. */
export const revertPayableEdit = mutation({
  args: { payableId: v.id('loadPayables') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (!payable || payable.workosOrgId !== callerOrgId) throw new Error('Line not found');
    if (payable.editedAt == null) return null;
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && (settlement.status === 'APPROVED' || settlement.status === 'PAID')) {
        throw new Error('Cannot edit a finalized settlement');
      }
    }
    await ctx.db.patch(args.payableId, {
      quantity: payable.originalQuantity ?? payable.quantity,
      rate: payable.originalRate ?? payable.rate,
      totalAmount: payable.originalTotalAmount ?? payable.totalAmount,
      overrideStartAt: undefined,
      overrideEndAt: undefined,
      breakMinutes: undefined,
      originalQuantity: undefined,
      originalRate: undefined,
      originalTotalAmount: undefined,
      editedAt: undefined,
      editedBy: undefined,
      editReason: undefined,
      rulesAmount: undefined,
      rulesChangedAt: undefined,
      // SYSTEM lines return to the rules engine's control; MANUAL stay locked.
      isLocked: payable.sourceType === 'MANUAL',
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Adopt the rules engine's current amount for a line that drifted from a
 * reviewer edit (rulesChangedAt set). Sets the line to the engine value,
 * clears the edit + drift flags, and unlocks it so rules own it going forward.
 */
export const applyRulesAmount = mutation({
  args: { payableId: v.id('loadPayables') },
  returns: v.null(),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (!payable || payable.workosOrgId !== callerOrgId) throw new Error('Line not found');
    if (payable.rulesAmount == null) return null;
    if (payable.settlementId) {
      const settlement = await ctx.db.get(payable.settlementId);
      if (settlement && (settlement.status === 'APPROVED' || settlement.status === 'PAID')) {
        throw new Error('Cannot edit a finalized settlement');
      }
    }
    const newTotal = payable.rulesAmount;
    await ctx.db.patch(args.payableId, {
      totalAmount: newTotal,
      rate: payable.quantity ? +(newTotal / payable.quantity).toFixed(4) : newTotal,
      overrideStartAt: undefined,
      overrideEndAt: undefined,
      breakMinutes: undefined,
      originalQuantity: undefined,
      originalRate: undefined,
      originalTotalAmount: undefined,
      editedAt: undefined,
      editedBy: undefined,
      editReason: undefined,
      rulesAmount: undefined,
      rulesChangedAt: undefined,
      isLocked: false, // rules own it again
      updatedAt: Date.now(),
    });
    return null;
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const payable = await ctx.db.get(args.payableId);
    if (payable && payable.workosOrgId !== callerOrgId) {
      throw new Error('Payable not found');
    }
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

    // Standalone manual adjustments are per-statement by design (the same
    // rule deleteSettlement applies). Detaching one would strand it in the
    // unsettled pool where every future statement generation re-collects it —
    // the "removed line keeps coming back" loop. Delete it outright instead.
    // Work-derived lines (load/leg/session) keep detach semantics so a line
    // can intentionally roll to the next period.
    const isStandaloneManual =
      payable.sourceType === 'MANUAL' && !payable.loadId && !payable.legId && !payable.sessionId;

    if (isStandaloneManual) {
      await ctx.db.delete(args.payableId);
      // Shadow dual-write: void the mirrored payItem (the line is gone).
      await ctx.scheduler.runAfter(0, internal.payEngine.manualCoverage.syncManualPayItem, {
        workosOrgId: payable.workosOrgId, table: 'loadPayables', payableId: args.payableId,
      });
    } else {
      await ctx.db.patch(args.payableId, {
        settlementId: undefined,
        updatedAt: Date.now(),
      });
    }

    await logAudit(ctx, {
      organizationId: settlement.workosOrgId,
      entityType: 'driverSettlement',
      entityId: settlement._id,
      entityName: settlement.statementNumber,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: isStandaloneManual
        ? `Deleted adjustment "${payable.description}" ($${payable.totalAmount.toFixed(2)}) from settlement ${settlement.statementNumber}`
        : `Removed payable "${payable.description}" from settlement ${settlement.statementNumber}`,
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

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

    await logAudit(ctx, {
      organizationId: settlement.workosOrgId,
      entityType: 'driverSettlement',
      entityId: args.settlementId,
      entityName: settlement.statementNumber,
      action: 'deleted',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Deleted settlement ${settlement.statementNumber}`,
      changesBefore: JSON.stringify(settlement),
    });

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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);
    const settlement = await ctx.db.get(args.settlementId);
    if (!settlement) throw new Error('Settlement not found');
    if (settlement.workosOrgId !== callerOrgId) {
      throw new Error('Settlement not found');
    }

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
        const refreshCaches = newWorkStartCaches();

        for (const payable of allUnassigned) {
          // Check if load is held
          let isLoadHeld = false;
          if (payable.loadId) {
            const load = await ctx.db.get(payable.loadId);
            refreshCaches.loads.set(payable.loadId as string, load ?? null);
            if (load?.isHeld) {
              isLoadHeld = true;
            }
          }

          // Skip held loads
          if (isLoadHeld) continue;

          // Get the trigger timestamp based on plan configuration
          const triggerTimestamp = await getPayableTriggerTimestamp(ctx, payable, plan.payableTrigger, refreshCaches);

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
      // No pay plan — date-range filter keyed on when the work was done.
      const allUnassigned = await ctx.db
        .query('loadPayables')
        .withIndex('by_driver_unassigned', (q) =>
          q.eq('driverId', settlement.driverId).eq('settlementId', undefined)
        )
        .collect();
      const fallbackCaches = newWorkStartCaches();

      for (const payable of allUnassigned) {
        // Check if load is held
        let isLoadHeld = false;
        if (payable.loadId) {
          const load = await ctx.db.get(payable.loadId);
          fallbackCaches.loads.set(payable.loadId as string, load ?? null);
          if (load?.isHeld) {
            isLoadHeld = true;
          }
        }

        // Skip held loads
        if (isLoadHeld) continue;

        const workStart = await resolveWorkStartTimestamp(ctx, payable, fallbackCaches);
        if (workStart != null && workStart >= settlement.periodStart && workStart <= settlement.periodEnd) {
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

    await logAudit(ctx, {
      organizationId: settlement.workosOrgId,
      entityType: 'driverSettlement',
      entityId: args.settlementId,
      entityName: settlement.statementNumber,
      action: 'updated',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Refreshed draft settlement ${settlement.statementNumber} (${payablesToAssign.length} payables, $${grossTotal.toFixed(2)})`,
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const driver = await ctx.db.get(args.driverId);
    if (!driver) throw new Error('Driver not found');
    if (driver.organizationId !== callerOrgId) {
      throw new Error('Driver not found');
    }
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
    const planCaches = newWorkStartCaches();

    for (const payable of allUnassigned) {
      // Check if load is held
      let isLoadHeld = false;
      if (payable.loadId) {
        const load = await ctx.db.get(payable.loadId);
        planCaches.loads.set(payable.loadId as string, load ?? null);
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
      const triggerTimestamp = await getPayableTriggerTimestamp(ctx, payable, plan.payableTrigger, planCaches);

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
      createdBy: userId,
      updatedAt: now,
    });

    // Assign payables to settlement
    for (const payableId of payablesToAssign) {
      await ctx.db.patch(payableId, {
        settlementId,
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'driverSettlement',
      entityId: settlementId,
      entityName: statementNumber,
      action: 'created',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Generated settlement ${statementNumber} for ${driver.firstName} ${driver.lastName} from plan "${plan.name}" (${periodStart.toLocaleDateString('en-US')} - ${periodEnd.toLocaleDateString('en-US')})`,
    });

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
 * Period number within the year for a plan period (Week 23, Period 11, ...).
 */
function planPeriodNumber(plan: Doc<'payPlans'>, periodStart: Date): number {
  const yearStart = new Date(periodStart.getFullYear(), 0, 1);
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysSinceYearStart = Math.floor((periodStart.getTime() - yearStart.getTime()) / msPerDay);
  switch (plan.frequency) {
    case 'WEEKLY':
      return Math.floor(daysSinceYearStart / 7) + 1;
    case 'BIWEEKLY':
      return Math.floor(daysSinceYearStart / 14) + 1;
    case 'SEMIMONTHLY':
      return periodStart.getMonth() * 2 + (periodStart.getDate() <= 15 ? 1 : 2);
    case 'MONTHLY':
      return periodStart.getMonth() + 1;
    default:
      return 1;
  }
}

/**
 * Per-driver settlement generation for the current plan period.
 *
 * One bounded transaction per driver — the fan-out target for
 * bulkGenerateByPlan and the hourly settlements cron. Behavior:
 *   - no settlement for the period yet → create a DRAFT when at least one
 *     payable's work start falls inside the window (no empty statements)
 *   - a DRAFT already exists and `additive` → assign newly-landed in-window
 *     payables to it. ADDITIVE ONLY: never unassigns lines and never touches
 *     manual adjustments — the destructive rebuild stays exclusive to the
 *     user-invoked refreshDraftSettlement.
 *   - settlement exists in any other status → no-op
 */
export const generateOrRefreshForDriver = internalMutation({
  args: {
    driverId: v.id('drivers'),
    planId: v.id('payPlans'),
    workosOrgId: v.string(),
    userId: v.string(),
    includeHeldItems: v.optional(v.boolean()),
    referenceDate: v.optional(v.float64()),
    additive: v.optional(v.boolean()),
    /** Continuation cursor — large backlogs sweep in chunks (self-rescheduled). */
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan || !plan.isActive || plan.workosOrgId !== args.workosOrgId) return null;
    const driver = await ctx.db.get(args.driverId);
    if (!driver || driver.organizationId !== args.workosOrgId || driver.payPlanId !== args.planId) {
      return null;
    }

    const now = Date.now();
    const refDate = args.referenceDate ? new Date(args.referenceDate) : new Date();
    const { periodStart, periodEnd } = calculatePlanPeriod(plan, refDate);

    let timezone = plan.timezone;
    if (!timezone) {
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_organization', (q: any) => q.eq('workosOrgId', args.workosOrgId))
        .first();
      timezone = org?.defaultTimezone || 'America/New_York';
    }

    const existing = await ctx.db
      .query('driverSettlements')
      .withIndex('by_period', (q) =>
        q
          .eq('driverId', args.driverId)
          .eq('periodStart', periodStart.getTime())
          .eq('periodEnd', periodEnd.getTime()),
      )
      .first();

    // Only a DRAFT may be topped up; anything past DRAFT is owned by the
    // approval workflow. (Late-landing pay for a locked current period is
    // swept forward by autoCarryover once the next period becomes current.)
    const currentWritable = !existing || (existing.status === 'DRAFT' && !!args.additive);

    // Chunked scan: a driver's stranded backlog can exceed the per-transaction
    // read budget (observed: 1,200+ unassigned payables), so each run sweeps
    // one page and reschedules itself with the continuation cursor.
    const CHUNK = 200;
    const page = await ctx.db
      .query('loadPayables')
      .withIndex('by_driver_unassigned', (q) =>
        q.eq('driverId', args.driverId).eq('settlementId', undefined),
      )
      .paginate({ numItems: CHUNK, cursor: args.cursor ?? null });
    const allUnassigned = page.page;

    const caches = newWorkStartCaches();
    // Routing buckets — a statement only ever contains its own period's work:
    //   assignToCurrent — work started inside the current period
    //   assignToPrior   — late pay whose own period's statement is still DRAFT
    //                     (assigned there: correct period attribution)
    //   backfill        — late pay whose period has NO statement yet → create
    //                     that period's DRAFT and put the work where it belongs
    //   carryOver       — ONLY late pay whose period is already settled/locked
    //                     (can't reopen); moves to the current draft when the
    //                     plan opts in via autoCarryover, stamped carriedOverAt
    const assignToCurrent: Array<Id<'loadPayables'>> = [];
    const assignToPrior = new Map<Id<'driverSettlements'>, Array<Id<'loadPayables'>>>();
    const backfill = new Map<number, { periodStart: Date; periodEnd: Date; ids: Array<Id<'loadPayables'>> }>();
    const carryOver: Array<Id<'loadPayables'>> = [];

    // Driver's settlement history, fetched lazily on the first late payable.
    let history: Array<Doc<'driverSettlements'>> | null = null;
    const coveringSettlement = async (ts: number) => {
      if (history === null) {
        history = await ctx.db
          .query('driverSettlements')
          .withIndex('by_driver', (q) => q.eq('driverId', args.driverId))
          .collect();
      }
      return history.find(
        (s) => s.status !== 'VOID' && ts >= s.periodStart && ts <= s.periodEnd,
      );
    };

    for (const payable of allUnassigned) {
      let isLoadHeld = false;
      if (payable.loadId) {
        const loadKey = payable.loadId as string;
        let load = caches.loads.get(loadKey);
        if (load === undefined) {
          load = ((await ctx.db.get(payable.loadId)) ?? null) as Doc<'loadInformation'> | null;
          caches.loads.set(loadKey, load);
        }
        if (load?.isHeld) isLoadHeld = true;
      }
      if (isLoadHeld) {
        if (args.includeHeldItems && currentWritable) assignToCurrent.push(payable._id);
        continue;
      }

      // Standalone adjustments respect the plan's opt-in flag.
      if (!payable.loadId && !payable.legId && !plan.includeStandaloneAdjustments) continue;

      const triggerTimestamp = await getPayableTriggerTimestamp(
        ctx,
        payable,
        plan.payableTrigger,
        caches,
      );
      if (triggerTimestamp == null) continue;

      // Future work belongs to a later period — leave it for that period.
      if (triggerTimestamp > periodEnd.getTime()) continue;

      if (triggerTimestamp >= periodStart.getTime()) {
        if (!currentWritable) continue;
        if (!isWithinCutoffWindow(triggerTimestamp, periodEnd.getTime(), plan.cutoffTime, timezone!)) {
          continue;
        }
        assignToCurrent.push(payable._id);
        continue;
      }

      // Late pay — work started before the current period.
      const covering = await coveringSettlement(triggerTimestamp);
      if (covering?.status === 'DRAFT') {
        const list = assignToPrior.get(covering._id) ?? [];
        list.push(payable._id);
        assignToPrior.set(covering._id, list);
      } else if (covering) {
        // That period is settled/locked — the one legitimate carry-forward.
        if (plan.autoCarryover && currentWritable) carryOver.push(payable._id);
        // else: left unassigned for manual handling.
      } else {
        // No statement covers that period — backfill one for the period the
        // work was done in. (Historical backfill skips the cutoff test: the
        // cutoff only disambiguates the live period boundary.)
        const p = calculatePlanPeriod(plan, new Date(triggerTimestamp));
        const key = p.periodStart.getTime();
        const group = backfill.get(key) ?? { periodStart: p.periodStart, periodEnd: p.periodEnd, ids: [] };
        group.ids.push(payable._id);
        backfill.set(key, group);
      }
    }

    // Top up prior-period DRAFTs first — their period owns the work.
    for (const [priorId, payableIds] of assignToPrior) {
      for (const payableId of payableIds) {
        await ctx.db.patch(payableId, { settlementId: priorId, updatedAt: now });
      }
      await ctx.db.patch(priorId, { updatedAt: now });
    }

    // Backfill statements for past periods that never got one. Later chunks
    // (and later runs) find these via the covering-settlement lookup and top
    // them up as prior DRAFTs.
    for (const group of backfill.values()) {
      const statementNumber = await generateStatementNumber(ctx, args.workosOrgId);
      const backfillId = await ctx.db.insert('driverSettlements', {
        driverId: args.driverId,
        workosOrgId: args.workosOrgId,
        periodStart: group.periodStart.getTime(),
        periodEnd: group.periodEnd.getTime(),
        payPlanId: plan._id,
        periodNumber: planPeriodNumber(plan, group.periodStart),
        payPlanName: plan.name,
        status: 'DRAFT',
        statementNumber,
        createdAt: now,
        createdBy: args.userId,
        updatedAt: now,
      });
      for (const payableId of group.ids) {
        await ctx.db.patch(payableId, { settlementId: backfillId, updatedAt: now });
      }
    }

    const currentItems = [...assignToCurrent, ...carryOver];
    if (currentItems.length > 0) {
      let settlementId = existing?._id;
      if (!settlementId) {
        const statementNumber = await generateStatementNumber(ctx, args.workosOrgId);
        settlementId = await ctx.db.insert('driverSettlements', {
          driverId: args.driverId,
          workosOrgId: args.workosOrgId,
          periodStart: periodStart.getTime(),
          periodEnd: periodEnd.getTime(),
          payPlanId: plan._id,
          periodNumber: planPeriodNumber(plan, periodStart),
          payPlanName: plan.name,
          status: 'DRAFT',
          statementNumber,
          createdAt: now,
          createdBy: args.userId,
          updatedAt: now,
        });
      }

      for (const payableId of assignToCurrent) {
        await ctx.db.patch(payableId, { settlementId, updatedAt: now });
      }
      for (const payableId of carryOver) {
        await ctx.db.patch(payableId, { settlementId, carriedOverAt: now, updatedAt: now });
      }
      await ctx.db.patch(settlementId, { updatedAt: now });
    }

    // More backlog to scan — continue from the cursor in a fresh transaction.
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.driverSettlements.generateOrRefreshForDriver, {
        driverId: args.driverId,
        planId: args.planId,
        workosOrgId: args.workosOrgId,
        userId: args.userId,
        includeHeldItems: args.includeHeldItems,
        referenceDate: args.referenceDate,
        additive: args.additive,
        cursor: page.continueCursor,
      });
    }
    return null;
  },
});

/**
 * Bulk generate settlements for all drivers on a Pay Plan.
 *
 * Fans out one scheduled generateOrRefreshForDriver per driver instead of
 * running every driver inside a single transaction — the monolithic version
 * exceeded Convex's system-operation limit on real fleets ("Your request
 * timed out performing too many system operations"). Statements stream into
 * the list reactively as each driver's transaction commits.
 */
export const bulkGenerateByPlan = mutation({
  args: {
    planId: v.id('payPlans'),
    workosOrgId: v.string(),
    userId: v.string(),
    includeHeldItems: v.optional(v.boolean()),
    referenceDate: v.optional(v.float64()),
  },
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay Plan not found');
    if (plan.workosOrgId !== callerOrgId) throw new Error('Pay Plan not found');
    if (!plan.isActive) throw new Error('Pay Plan is inactive');

    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .filter((q) =>
        q.and(q.eq(q.field('payPlanId'), args.planId), q.neq(q.field('isDeleted'), true)),
      )
      .collect();

    let scheduled = 0;
    for (const driver of drivers) {
      // Stagger slightly so the statement-number counter doc isn't hammered
      // by N simultaneous transactions (OCC retries are safe but wasteful).
      await ctx.scheduler.runAfter(
        scheduled * 150,
        internal.driverSettlements.generateOrRefreshForDriver,
        {
          driverId: driver._id,
          planId: args.planId,
          workosOrgId: args.workosOrgId,
          userId,
          includeHeldItems: args.includeHeldItems,
          referenceDate: args.referenceDate,
          additive: true,
        },
      );
      scheduled++;
    }

    console.log(`[BULK_SETTLE] v4 fan-out | Plan: ${args.planId} | Scheduled: ${scheduled}`);

    // Per-driver generation runs async in internal mutations (no user
    // identity there), so the bulk action is logged here at dispatch.
    if (scheduled > 0) {
      await logAudit(ctx, {
        organizationId: callerOrgId,
        entityType: 'driverSettlement',
        entityId: 'bulk',
        entityName: plan.name,
        action: 'bulk_created',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Triggered settlement generation for ${scheduled} driver${scheduled === 1 ? '' : 's'} on plan "${plan.name}"`,
        metadata: JSON.stringify({ scheduled, planId: args.planId, planName: plan.name }),
      });
    }
    return { scheduled };
  },
});

// ============================================
// SETTLEMENTS HUB (web redesign)
// ============================================
//
// The Accounting → Driver Settlements screen works in lifecycle buckets
// computed over the raw statuses (see convex/lib/settlementShared.ts):
// open (accruing) / attention (closed + hard blockers) / ready / approved /
// paid / void. Active rows (DRAFT + PENDING) are a bounded working set, so
// they ship as one enriched list; settled history (APPROVED / PAID / VOID)
// is paginated.

import { paginationOptsValidator } from 'convex/server';
import { internal } from './_generated/api';
import {
  ageDays,
  applyAcknowledgements,
  bucketForSettlement,
  buildShiftLoadRows,
  cadenceFromFrequency,
  classifyPayable,
  computeDriverBlockers,
  loadsForPayables,
  newWorkStartCaches,
  nextStatementNumber,
  payDateFromLag,
  resolveDriverPayBasis,
  resolveWorkStartTimestamp,
  summarizeLines,
  unitsLabel,
  type PayBasisInfo,
  type ShiftLoadRow,
  type WorkStartCaches,
} from './lib/settlementShared';

interface DriverEnrichCaches {
  drivers: Map<string, Doc<'drivers'> | null>;
  payPlans: Map<string, Doc<'payPlans'> | null>;
  payBasis: Map<string, PayBasisInfo | null>;
  loads: Map<string, Doc<'loadInformation'> | null>;
}

const newDriverCaches = (): DriverEnrichCaches => ({
  drivers: new Map(),
  payPlans: new Map(),
  payBasis: new Map(),
  loads: new Map(),
});

/**
 * One settlement → one screen row. Reads payables + referenced loads to
 * compute totals and blockers; resolves pay basis / cadence / pay date from
 * the driver's rate-profile assignment and pay plan.
 */
async function enrichDriverSettlement(
  ctx: any,
  settlement: Doc<'driverSettlements'>,
  caches: DriverEnrichCaches,
  options: { withBlockers: boolean },
) {
  const driverKey = settlement.driverId as string;
  let driver = caches.drivers.get(driverKey);
  if (driver === undefined) {
    driver = ((await ctx.db.get(settlement.driverId)) ?? null) as Doc<'drivers'> | null;
    caches.drivers.set(driverKey, driver);
  }

  const planId = settlement.payPlanId ?? driver?.payPlanId;
  let payPlan: Doc<'payPlans'> | null = null;
  if (planId) {
    const planKey = planId as string;
    const cached = caches.payPlans.get(planKey);
    if (cached === undefined) {
      payPlan = (await ctx.db.get(planId)) ?? null;
      caches.payPlans.set(planKey, payPlan);
    } else {
      payPlan = cached;
    }
  }

  let basisInfo = caches.payBasis.get(driverKey);
  if (basisInfo === undefined) {
    basisInfo = await resolveDriverPayBasis(ctx, settlement.driverId);
    caches.payBasis.set(driverKey, basisInfo);
  }

  const payables = await ctx.db
    .query('loadPayables')
    .withIndex('by_settlement', (q: any) => q.eq('settlementId', settlement._id))
    .collect();

  const summary = summarizeLines(payables);
  let blockers: ReturnType<typeof computeDriverBlockers> = [];
  if (options.withBlockers) {
    const loads = await loadsForPayables(ctx, payables, caches.loads);
    blockers = applyAcknowledgements(
      computeDriverBlockers({ payables, loads, net: summary.net }),
      settlement.acknowledgedBlockers,
    );
  }

  const payDate = payPlan ? payDateFromLag(settlement.periodEnd, payPlan.paymentLagDays) : null;

  return {
    _id: settlement._id,
    statementNumber: settlement.statementNumber,
    status: settlement.status,
    bucket: bucketForSettlement(settlement.status, settlement.periodEnd, blockers),
    payeeId: settlement.driverId,
    payeeName: driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown Driver',
    payeeSub: settlement.payPlanName ?? payPlan?.name ?? null,
    periodStart: settlement.periodStart,
    periodEnd: settlement.periodEnd,
    periodNumber: settlement.periodNumber ?? null,
    payDate,
    paidAt: settlement.paidAt ?? null,
    paidMethod: settlement.paidMethod ?? null,
    paidReference: settlement.paidReference ?? null,
    planBasis: basisInfo?.basis ?? null,
    planDetail: basisInfo?.planDetail ?? null,
    cadence: cadenceFromFrequency(payPlan?.frequency),
    units: unitsLabel(basisInfo?.basis ?? null, summary),
    loadCount: summary.loadCount,
    lineCount: summary.lineCount,
    earnTotal: summary.earnTotal,
    reimbTotal: summary.reimbTotal,
    deductTotal: summary.deductTotal,
    net: summary.net,
    blockers,
    ageDays: ageDays(settlement.periodEnd),
    voidReason: settlement.voidReason ?? null,
    notes: settlement.notes ?? null,
  };
}

export type EnrichedDriverSettlementRow = Awaited<ReturnType<typeof enrichDriverSettlement>>;

/** Cap on the active (DRAFT + PENDING) working set returned in one shot. */
const ACTIVE_ROW_CAP = 500;

/**
 * Active settlements (DRAFT + PENDING) for the open / attention / ready
 * views, enriched and bucketed. The active set is bounded by the number of
 * drivers × open periods, so this returns the full filtered set (capped).
 */
export const listActive = query({
  args: {
    workosOrgId: v.string(),
    view: v.union(v.literal('open'), v.literal('attention'), v.literal('ready')),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const [drafts, pendings] = await Promise.all([
      ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'DRAFT'),
        )
        .collect(),
      ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING'),
        )
        .collect(),
    ]);

    const active = [...drafts, ...pendings]
      .sort((a, b) => b.periodStart - a.periodStart)
      .slice(0, ACTIVE_ROW_CAP);

    const caches = newDriverCaches();
    const rows = [];
    for (const settlement of active) {
      rows.push(await enrichDriverSettlement(ctx, settlement, caches, { withBlockers: true }));
    }

    let filtered = rows.filter((r) => r.bucket === args.view);
    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      filtered = filtered.filter(
        (r) =>
          r.statementNumber.toLowerCase().includes(needle) ||
          r.payeeName.toLowerCase().includes(needle),
      );
    }
    return { rows: filtered, truncated: active.length === ACTIVE_ROW_CAP };
  },
});

/**
 * Settled history (APPROVED / PAID / VOID) — properly paginated since paid
 * history grows without bound.
 */
export const listSettled = query({
  args: {
    workosOrgId: v.string(),
    status: v.union(v.literal('APPROVED'), v.literal('PAID'), v.literal('VOID')),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const result = await ctx.db
      .query('driverSettlements')
      .withIndex('by_org_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', args.status),
      )
      .order('desc')
      .paginate(args.paginationOpts);

    const caches = newDriverCaches();
    let page = [];
    for (const settlement of result.page) {
      // Blockers only matter pre-approval; settled rows skip the load reads.
      page.push(await enrichDriverSettlement(ctx, settlement, caches, { withBlockers: false }));
    }

    if (args.search && args.search.trim() !== '') {
      const needle = args.search.toLowerCase().trim();
      page = page.filter(
        (r) =>
          r.statementNumber.toLowerCase().includes(needle) ||
          r.payeeName.toLowerCase().includes(needle),
      );
    }

    return { ...result, page };
  },
});

/**
 * View counts + header stats for the settlements screen:
 * due this run (ready + approved net), open accruing, blocked count, paid MTD.
 */
export const getViewStats = query({
  args: { workosOrgId: v.string() },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const [drafts, pendings, approved] = await Promise.all([
      ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'DRAFT'),
        )
        .collect(),
      ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'PENDING'),
        )
        .collect(),
      ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'APPROVED'),
        )
        .collect(),
    ]);

    const caches = newDriverCaches();
    let openCount = 0;
    let attentionCount = 0;
    let readyCount = 0;
    let openAccruing = 0;
    let readyNet = 0;
    let blockedNet = 0;
    let oldestBlockedId: Id<'driverSettlements'> | null = null;
    let oldestBlockedAge = -1;

    for (const settlement of [...drafts, ...pendings].slice(0, ACTIVE_ROW_CAP)) {
      const row = await enrichDriverSettlement(ctx, settlement, caches, { withBlockers: true });
      if (row.bucket === 'open') {
        openCount++;
        openAccruing += row.net;
      } else if (row.bucket === 'attention') {
        attentionCount++;
        blockedNet += Math.max(row.net, 0);
        if (row.ageDays > oldestBlockedAge) {
          oldestBlockedAge = row.ageDays;
          oldestBlockedId = settlement._id;
        }
      } else {
        readyCount++;
        readyNet += row.net;
      }
    }

    // Approved totals were frozen at approval time (grossTotal nets out
    // deductions because deduction payables carry negative amounts).
    const approvedNet = approved.reduce((sum, s) => sum + (s.grossTotal ?? 0), 0);

    // Paid month-to-date. Recent-first scan capped — paid history is the one
    // unbounded status; a month of statements sits far below the cap.
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const paidRecent = await ctx.db
      .query('driverSettlements')
      .withIndex('by_org_status', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID'),
      )
      .order('desc')
      .take(1000);
    const paidMtd = paidRecent
      .filter((s) => (s.paidAt ?? 0) >= monthStart.getTime())
      .reduce((sum, s) => sum + (s.grossTotal ?? 0), 0);

    const [paidCount, voidCount] = await Promise.all([
      ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'PAID'),
        )
        .collect()
        .then((r) => r.length),
      ctx.db
        .query('driverSettlements')
        .withIndex('by_org_status', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('status', 'VOID'),
        )
        .collect()
        .then((r) => r.length),
    ]);

    return {
      counts: {
        attention: attentionCount,
        open: openCount,
        ready: readyCount,
        approved: approved.length,
        paid: paidCount,
        void: voidCount,
      },
      dueThisRun: readyNet + approvedNet,
      openAccruing,
      blockedNet,
      paidMtd,
      oldestBlockedId,
    };
  },
});
