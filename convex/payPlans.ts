import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';

// ============================================
// HELPER FUNCTIONS - Period Calculations
// ============================================

/**
 * Get the resolved timezone for a pay plan
 * Priority: plan.timezone > organization.defaultTimezone > "America/New_York"
 */
async function resolveTimezone(
  ctx: any,
  plan: Doc<'payPlans'>
): Promise<string> {
  if (plan.timezone) {
    return plan.timezone;
  }

  // Fetch organization default
  const org = await ctx.db
    .query('organizations')
    .withIndex('by_organization', (q: any) => q.eq('workosOrgId', plan.workosOrgId))
    .first();

  if (org?.defaultTimezone) {
    return org.defaultTimezone;
  }

  return 'America/New_York'; // System default
}

/**
 * Parse cutoff time string (e.g., "17:00") into hours and minutes
 */
function parseCutoffTime(cutoffTime: string): { hours: number; minutes: number } {
  const [hours, minutes] = cutoffTime.split(':').map(Number);
  return { hours: hours || 0, minutes: minutes || 0 };
}

/**
 * Get the day of week as a number (0 = Sunday, 1 = Monday, etc.)
 */
function getDayOfWeekNumber(
  day: 'SUNDAY' | 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY'
): number {
  const dayMap: Record<string, number> = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
  };
  return dayMap[day];
}

/**
 * Calculate the most recent period start for WEEKLY frequency
 */
function calculateWeeklyPeriodStart(
  referenceDate: Date,
  startDayOfWeek: number,
  timezone: string
): Date {
  const date = new Date(referenceDate);
  const currentDay = date.getDay();
  const daysToSubtract = (currentDay - startDayOfWeek + 7) % 7;
  date.setDate(date.getDate() - daysToSubtract);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Calculate the most recent period start for BIWEEKLY frequency
 * Uses a reference anchor date to maintain consistent 2-week intervals
 */
function calculateBiweeklyPeriodStart(
  referenceDate: Date,
  startDayOfWeek: number,
  timezone: string
): Date {
  // Use a fixed anchor date (Jan 1, 2024 was a Monday)
  const anchorDate = new Date('2024-01-01T00:00:00');
  const anchorDayOfWeek = anchorDate.getDay();
  
  // Adjust anchor to the configured start day
  const daysToAdjust = (startDayOfWeek - anchorDayOfWeek + 7) % 7;
  anchorDate.setDate(anchorDate.getDate() + daysToAdjust);
  
  // Calculate weeks since anchor
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const weeksSinceAnchor = Math.floor((referenceDate.getTime() - anchorDate.getTime()) / msPerWeek);
  
  // Round down to nearest even number of weeks (bi-weekly)
  const biweeklyPeriods = Math.floor(weeksSinceAnchor / 2);
  
  const periodStart = new Date(anchorDate);
  periodStart.setDate(periodStart.getDate() + biweeklyPeriods * 14);
  periodStart.setHours(0, 0, 0, 0);
  
  return periodStart;
}

/**
 * Calculate the period start for SEMIMONTHLY frequency
 * Fixed: 1st-15th and 16th-end of month
 */
function calculateSemimonthlyPeriodStart(referenceDate: Date): Date {
  const date = new Date(referenceDate);
  const dayOfMonth = date.getDate();
  
  if (dayOfMonth <= 15) {
    // First half: 1st of current month
    date.setDate(1);
  } else {
    // Second half: 16th of current month
    date.setDate(16);
  }
  
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Calculate the period start for MONTHLY frequency
 */
function calculateMonthlyPeriodStart(
  referenceDate: Date,
  startDayOfMonth: number
): Date {
  const date = new Date(referenceDate);
  const currentDay = date.getDate();
  
  // Clamp to valid day (handle months with fewer days)
  const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const effectiveStartDay = Math.min(startDayOfMonth, lastDayOfMonth);
  
  if (currentDay < effectiveStartDay) {
    // Go to previous month
    date.setMonth(date.getMonth() - 1);
  }
  
  // Set to the start day
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
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY',
  startDayOfMonth?: number
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
        // First half ends on 15th
        endDate.setDate(16);
      } else {
        // Second half ends on 1st of next month
        endDate.setMonth(endDate.getMonth() + 1);
        endDate.setDate(1);
      }
      break;
    case 'MONTHLY':
      endDate.setMonth(endDate.getMonth() + 1);
      break;
  }

  // Subtract 1ms to get 23:59:59.999 of the previous day
  endDate.setTime(endDate.getTime() - 1);
  return endDate;
}

/**
 * Calculate the pay date based on period end and lag days
 */
function calculatePayDate(periodEnd: Date, paymentLagDays: number): Date {
  const payDate = new Date(periodEnd);
  payDate.setDate(payDate.getDate() + paymentLagDays + 1); // +1 because period end is 23:59:59
  payDate.setHours(0, 0, 0, 0);
  return payDate;
}

/**
 * Calculate current period for a pay plan
 */
export function calculateCurrentPeriod(
  plan: Doc<'payPlans'>,
  referenceDate: Date = new Date()
): { periodStart: Date; periodEnd: Date; payDate: Date } {
  let periodStart: Date;

  switch (plan.frequency) {
    case 'WEEKLY':
      if (!plan.periodStartDayOfWeek) {
        throw new Error('WEEKLY frequency requires periodStartDayOfWeek');
      }
      periodStart = calculateWeeklyPeriodStart(
        referenceDate,
        getDayOfWeekNumber(plan.periodStartDayOfWeek),
        plan.timezone || 'America/New_York'
      );
      break;
    case 'BIWEEKLY':
      if (!plan.periodStartDayOfWeek) {
        throw new Error('BIWEEKLY frequency requires periodStartDayOfWeek');
      }
      periodStart = calculateBiweeklyPeriodStart(
        referenceDate,
        getDayOfWeekNumber(plan.periodStartDayOfWeek),
        plan.timezone || 'America/New_York'
      );
      break;
    case 'SEMIMONTHLY':
      periodStart = calculateSemimonthlyPeriodStart(referenceDate);
      break;
    case 'MONTHLY':
      periodStart = calculateMonthlyPeriodStart(
        referenceDate,
        plan.periodStartDayOfMonth || 1
      );
      break;
    default:
      throw new Error(`Unknown frequency: ${plan.frequency}`);
  }

  const periodEnd = calculatePeriodEnd(periodStart, plan.frequency, plan.periodStartDayOfMonth);
  const payDate = calculatePayDate(periodEnd, plan.paymentLagDays);

  return { periodStart, periodEnd, payDate };
}

/**
 * Calculate next N periods for preview
 */
export function calculateNextPeriods(
  plan: Doc<'payPlans'>,
  count: number = 3
): Array<{ periodStart: Date; periodEnd: Date; payDate: Date; label: string }> {
  const periods: Array<{ periodStart: Date; periodEnd: Date; payDate: Date; label: string }> = [];
  let referenceDate = new Date();

  for (let i = 0; i < count; i++) {
    const period = calculateCurrentPeriod(plan, referenceDate);
    
    const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const label = `${formatDate(period.periodStart)} - ${formatDate(period.periodEnd)}`;
    
    periods.push({
      ...period,
      label,
    });

    // Move reference to after this period for next iteration
    referenceDate = new Date(period.periodEnd.getTime() + 1);
  }

  return periods;
}

// ============================================
// QUERIES
// ============================================

/**
 * List all pay plans for an organization
 */
export const list = query({
  args: {
    workosOrgId: v.string(),
    includeInactive: v.optional(v.boolean()),
  },
  returns: v.array(
    v.object({
      _id: v.id('payPlans'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      name: v.string(),
      description: v.optional(v.string()),
      frequency: v.union(
        v.literal('WEEKLY'),
        v.literal('BIWEEKLY'),
        v.literal('SEMIMONTHLY'),
        v.literal('MONTHLY')
      ),
      periodStartDayOfWeek: v.optional(v.union(
        v.literal('SUNDAY'), v.literal('MONDAY'), v.literal('TUESDAY'),
        v.literal('WEDNESDAY'), v.literal('THURSDAY'), v.literal('FRIDAY'),
        v.literal('SATURDAY')
      )),
      periodStartDayOfMonth: v.optional(v.number()),
      timezone: v.optional(v.string()),
      cutoffTime: v.string(),
      paymentLagDays: v.number(),
      payableTrigger: v.union(
        v.literal('DELIVERY_DATE'),
        v.literal('COMPLETION_DATE'),
        v.literal('APPROVAL_DATE')
      ),
      autoCarryover: v.boolean(),
      includeStandaloneAdjustments: v.boolean(),
      isActive: v.boolean(),
      createdAt: v.float64(),
      createdBy: v.string(),
      updatedAt: v.optional(v.float64()),
      driverCount: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    let plans;

    if (args.includeInactive) {
      plans = await ctx.db
        .query('payPlans')
        .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
        .collect();
    } else {
      plans = await ctx.db
        .query('payPlans')
        .withIndex('by_org_active', (q) =>
          q.eq('workosOrgId', args.workosOrgId).eq('isActive', true)
        )
        .collect();
    }

    // Get driver counts for each plan (only Active, non-deleted drivers)
    const enrichedPlans = await Promise.all(
      plans.map(async (plan) => {
        const drivers = await ctx.db
          .query('drivers')
          .filter((q) =>
            q.and(
              q.eq(q.field('organizationId'), args.workosOrgId),
              q.eq(q.field('payPlanId'), plan._id),
              // isDeleted is optional, so check for both false and undefined
              q.neq(q.field('isDeleted'), true)
            )
          )
          .collect();

        // Filter to only Active drivers for consistent count
        const activeDrivers = drivers.filter((d) => d.employmentStatus === 'Active');

        return {
          ...plan,
          driverCount: activeDrivers.length,
        };
      })
    );

    return enrichedPlans;
  },
});

/**
 * Get a single pay plan by ID
 */
export const get = query({
  args: {
    planId: v.id('payPlans'),
  },
  returns: v.union(
    v.object({
      _id: v.id('payPlans'),
      _creationTime: v.number(),
      workosOrgId: v.string(),
      name: v.string(),
      description: v.optional(v.string()),
      frequency: v.union(
        v.literal('WEEKLY'),
        v.literal('BIWEEKLY'),
        v.literal('SEMIMONTHLY'),
        v.literal('MONTHLY')
      ),
      periodStartDayOfWeek: v.optional(v.union(
        v.literal('SUNDAY'), v.literal('MONDAY'), v.literal('TUESDAY'),
        v.literal('WEDNESDAY'), v.literal('THURSDAY'), v.literal('FRIDAY'),
        v.literal('SATURDAY')
      )),
      periodStartDayOfMonth: v.optional(v.number()),
      timezone: v.optional(v.string()),
      cutoffTime: v.string(),
      paymentLagDays: v.number(),
      payableTrigger: v.union(
        v.literal('DELIVERY_DATE'),
        v.literal('COMPLETION_DATE'),
        v.literal('APPROVAL_DATE')
      ),
      autoCarryover: v.boolean(),
      includeStandaloneAdjustments: v.boolean(),
      isActive: v.boolean(),
      createdAt: v.float64(),
      createdBy: v.string(),
      updatedAt: v.optional(v.float64()),
      resolvedTimezone: v.string(),
      currentPeriod: v.object({
        periodStart: v.float64(),
        periodEnd: v.float64(),
        payDate: v.float64(),
      }),
      nextPeriods: v.array(
        v.object({
          periodStart: v.float64(),
          periodEnd: v.float64(),
          payDate: v.float64(),
          label: v.string(),
        })
      ),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan) return null;

    const resolvedTimezone = await resolveTimezone(ctx, plan);
    const currentPeriod = calculateCurrentPeriod(plan);
    const nextPeriods = calculateNextPeriods(plan, 3);

    return {
      ...plan,
      resolvedTimezone,
      currentPeriod: {
        periodStart: currentPeriod.periodStart.getTime(),
        periodEnd: currentPeriod.periodEnd.getTime(),
        payDate: currentPeriod.payDate.getTime(),
      },
      nextPeriods: nextPeriods.map((p) => ({
        periodStart: p.periodStart.getTime(),
        periodEnd: p.periodEnd.getTime(),
        payDate: p.payDate.getTime(),
        label: p.label,
      })),
    };
  },
});

/**
 * Get the pay plan assigned to a driver
 */
export const getForDriver = query({
  args: {
    driverId: v.id('drivers'),
  },
  returns: v.union(
    v.object({
      _id: v.id('payPlans'),
      name: v.string(),
      frequency: v.union(
        v.literal('WEEKLY'),
        v.literal('BIWEEKLY'),
        v.literal('SEMIMONTHLY'),
        v.literal('MONTHLY')
      ),
      currentPeriod: v.object({
        periodStart: v.float64(),
        periodEnd: v.float64(),
        payDate: v.float64(),
      }),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const driver = await ctx.db.get(args.driverId);
    if (!driver || !driver.payPlanId) return null;

    const plan = await ctx.db.get(driver.payPlanId);
    if (!plan) return null;

    const currentPeriod = calculateCurrentPeriod(plan);

    return {
      _id: plan._id,
      name: plan.name,
      frequency: plan.frequency,
      currentPeriod: {
        periodStart: currentPeriod.periodStart.getTime(),
        periodEnd: currentPeriod.periodEnd.getTime(),
        payDate: currentPeriod.payDate.getTime(),
      },
    };
  },
});

/**
 * Get the current pay period for a specific pay plan
 * Returns period details including period number for settlement generation
 */
export const getCurrentPeriodForPlan = query({
  args: {
    planId: v.id('payPlans'),
  },
  returns: v.union(
    v.object({
      planId: v.id('payPlans'),
      planName: v.string(),
      frequency: v.union(
        v.literal('WEEKLY'),
        v.literal('BIWEEKLY'),
        v.literal('SEMIMONTHLY'),
        v.literal('MONTHLY')
      ),
      periodStart: v.float64(),
      periodEnd: v.float64(),
      payDate: v.float64(),
      periodNumber: v.number(),
      periodLabel: v.string(),
    }),
    v.null()
  ),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan || !plan.isActive) return null;

    const currentPeriod = calculateCurrentPeriod(plan);
    
    // Calculate period number (periods since start of year)
    const yearStart = new Date(currentPeriod.periodStart.getFullYear(), 0, 1);
    const msPerDay = 24 * 60 * 60 * 1000;
    const daysSinceYearStart = Math.floor((currentPeriod.periodStart.getTime() - yearStart.getTime()) / msPerDay);
    
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
        const month = currentPeriod.periodStart.getMonth();
        const isFirstHalf = currentPeriod.periodStart.getDate() <= 15;
        periodNumber = month * 2 + (isFirstHalf ? 1 : 2);
        break;
      case 'MONTHLY':
        periodNumber = currentPeriod.periodStart.getMonth() + 1;
        break;
      default:
        periodNumber = 1;
    }

    // Format period label
    const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const periodLabel = `Period ${periodNumber} • ${formatDate(currentPeriod.periodStart)} - ${formatDate(currentPeriod.periodEnd)}`;

    return {
      planId: plan._id,
      planName: plan.name,
      frequency: plan.frequency,
      periodStart: currentPeriod.periodStart.getTime(),
      periodEnd: currentPeriod.periodEnd.getTime(),
      payDate: currentPeriod.payDate.getTime(),
      periodNumber,
      periodLabel,
    };
  },
});

/**
 * Get all active drivers assigned to a specific pay plan
 */
export const getDriversForPlan = query({
  args: {
    planId: v.id('payPlans'),
    workosOrgId: v.string(),
  },
  returns: v.array(
    v.object({
      _id: v.id('drivers'),
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
      employmentStatus: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const drivers = await ctx.db
      .query('drivers')
      .filter((q) =>
        q.and(
          q.eq(q.field('organizationId'), args.workosOrgId),
          q.eq(q.field('payPlanId'), args.planId),
          // isDeleted is optional, so check for NOT true (includes undefined and false)
          q.neq(q.field('isDeleted'), true)
        )
      )
      .collect();

    return drivers
      .filter((d) => d.employmentStatus === 'Active')
      .map((d) => ({
        _id: d._id,
        firstName: d.firstName,
        lastName: d.lastName,
        email: d.email,
        employmentStatus: d.employmentStatus,
      }));
  },
});

/**
 * Get period preview for UI (used during plan creation/editing)
 */
export const previewPeriods = query({
  args: {
    frequency: v.union(
      v.literal('WEEKLY'),
      v.literal('BIWEEKLY'),
      v.literal('SEMIMONTHLY'),
      v.literal('MONTHLY')
    ),
    periodStartDayOfWeek: v.optional(v.union(
      v.literal('SUNDAY'), v.literal('MONDAY'), v.literal('TUESDAY'),
      v.literal('WEDNESDAY'), v.literal('THURSDAY'), v.literal('FRIDAY'),
      v.literal('SATURDAY')
    )),
    periodStartDayOfMonth: v.optional(v.number()),
    paymentLagDays: v.number(),
  },
  returns: v.array(
    v.object({
      periodStart: v.float64(),
      periodEnd: v.float64(),
      payDate: v.float64(),
      label: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    // Calculate periods directly without creating a full Doc object
    const periods: Array<{ periodStart: Date; periodEnd: Date; payDate: Date; label: string }> = [];
    let referenceDate = new Date();

    for (let i = 0; i < 3; i++) {
      let periodStart: Date;

      switch (args.frequency) {
        case 'WEEKLY':
          if (!args.periodStartDayOfWeek) {
            throw new Error('WEEKLY frequency requires periodStartDayOfWeek');
          }
          periodStart = calculateWeeklyPeriodStart(
            referenceDate,
            getDayOfWeekNumber(args.periodStartDayOfWeek),
            'America/New_York'
          );
          break;
        case 'BIWEEKLY':
          if (!args.periodStartDayOfWeek) {
            throw new Error('BIWEEKLY frequency requires periodStartDayOfWeek');
          }
          periodStart = calculateBiweeklyPeriodStart(
            referenceDate,
            getDayOfWeekNumber(args.periodStartDayOfWeek),
            'America/New_York'
          );
          break;
        case 'SEMIMONTHLY':
          periodStart = calculateSemimonthlyPeriodStart(referenceDate);
          break;
        case 'MONTHLY':
          periodStart = calculateMonthlyPeriodStart(
            referenceDate,
            args.periodStartDayOfMonth || 1
          );
          break;
        default:
          throw new Error(`Unknown frequency: ${args.frequency}`);
      }

      const periodEnd = calculatePeriodEnd(periodStart, args.frequency, args.periodStartDayOfMonth);
      const payDate = calculatePayDate(periodEnd, args.paymentLagDays);
      
      const formatDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const label = `${formatDate(periodStart)} - ${formatDate(periodEnd)}`;
      
      periods.push({ periodStart, periodEnd, payDate, label });

      // Move reference to after this period for next iteration
      referenceDate = new Date(periodEnd.getTime() + 1);
    }

    return periods.map((p) => ({
      periodStart: p.periodStart.getTime(),
      periodEnd: p.periodEnd.getTime(),
      payDate: p.payDate.getTime(),
      label: p.label,
    }));
  },
});

// ============================================
// MUTATIONS
// ============================================

/**
 * Create a new pay plan
 */
export const create = mutation({
  args: {
    workosOrgId: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    frequency: v.union(
      v.literal('WEEKLY'),
      v.literal('BIWEEKLY'),
      v.literal('SEMIMONTHLY'),
      v.literal('MONTHLY')
    ),
    periodStartDayOfWeek: v.optional(v.union(
      v.literal('SUNDAY'), v.literal('MONDAY'), v.literal('TUESDAY'),
      v.literal('WEDNESDAY'), v.literal('THURSDAY'), v.literal('FRIDAY'),
      v.literal('SATURDAY')
    )),
    periodStartDayOfMonth: v.optional(v.number()),
    timezone: v.optional(v.string()),
    cutoffTime: v.string(),
    paymentLagDays: v.number(),
    payableTrigger: v.union(
      v.literal('DELIVERY_DATE'),
      v.literal('COMPLETION_DATE'),
      v.literal('APPROVAL_DATE')
    ),
    autoCarryover: v.boolean(),
    includeStandaloneAdjustments: v.boolean(),
    userId: v.string(),
  },
  returns: v.id('payPlans'),
  handler: async (ctx, args) => {
    // Validate frequency-specific fields
    if ((args.frequency === 'WEEKLY' || args.frequency === 'BIWEEKLY') && !args.periodStartDayOfWeek) {
      throw new Error('WEEKLY and BIWEEKLY frequencies require periodStartDayOfWeek');
    }

    if (args.frequency === 'MONTHLY' && !args.periodStartDayOfMonth) {
      throw new Error('MONTHLY frequency requires periodStartDayOfMonth');
    }

    if (args.periodStartDayOfMonth && (args.periodStartDayOfMonth < 1 || args.periodStartDayOfMonth > 28)) {
      throw new Error('periodStartDayOfMonth must be between 1 and 28');
    }

    // Validate cutoff time format
    if (!/^\d{2}:\d{2}$/.test(args.cutoffTime)) {
      throw new Error('cutoffTime must be in HH:MM format (e.g., "17:00")');
    }

    const now = Date.now();

    const planId = await ctx.db.insert('payPlans', {
      workosOrgId: args.workosOrgId,
      name: args.name,
      description: args.description,
      frequency: args.frequency,
      periodStartDayOfWeek: args.periodStartDayOfWeek,
      periodStartDayOfMonth: args.periodStartDayOfMonth,
      timezone: args.timezone,
      cutoffTime: args.cutoffTime,
      paymentLagDays: args.paymentLagDays,
      payableTrigger: args.payableTrigger,
      autoCarryover: args.autoCarryover,
      includeStandaloneAdjustments: args.includeStandaloneAdjustments,
      isActive: true,
      createdAt: now,
      createdBy: args.userId,
    });

    return planId;
  },
});

/**
 * Update an existing pay plan
 */
export const update = mutation({
  args: {
    planId: v.id('payPlans'),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    frequency: v.optional(v.union(
      v.literal('WEEKLY'),
      v.literal('BIWEEKLY'),
      v.literal('SEMIMONTHLY'),
      v.literal('MONTHLY')
    )),
    periodStartDayOfWeek: v.optional(v.union(
      v.literal('SUNDAY'), v.literal('MONDAY'), v.literal('TUESDAY'),
      v.literal('WEDNESDAY'), v.literal('THURSDAY'), v.literal('FRIDAY'),
      v.literal('SATURDAY')
    )),
    periodStartDayOfMonth: v.optional(v.number()),
    timezone: v.optional(v.string()),
    cutoffTime: v.optional(v.string()),
    paymentLagDays: v.optional(v.number()),
    payableTrigger: v.optional(v.union(
      v.literal('DELIVERY_DATE'),
      v.literal('COMPLETION_DATE'),
      v.literal('APPROVAL_DATE')
    )),
    autoCarryover: v.optional(v.boolean()),
    includeStandaloneAdjustments: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');

    const updates: Partial<Doc<'payPlans'>> = {
      updatedAt: Date.now(),
    };

    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (args.frequency !== undefined) updates.frequency = args.frequency;
    if (args.periodStartDayOfWeek !== undefined) updates.periodStartDayOfWeek = args.periodStartDayOfWeek;
    if (args.periodStartDayOfMonth !== undefined) updates.periodStartDayOfMonth = args.periodStartDayOfMonth;
    if (args.timezone !== undefined) updates.timezone = args.timezone;
    if (args.cutoffTime !== undefined) updates.cutoffTime = args.cutoffTime;
    if (args.paymentLagDays !== undefined) updates.paymentLagDays = args.paymentLagDays;
    if (args.payableTrigger !== undefined) updates.payableTrigger = args.payableTrigger;
    if (args.autoCarryover !== undefined) updates.autoCarryover = args.autoCarryover;
    if (args.includeStandaloneAdjustments !== undefined) updates.includeStandaloneAdjustments = args.includeStandaloneAdjustments;

    // Validate frequency-specific fields with the final values
    const finalFrequency = args.frequency ?? plan.frequency;
    const finalDayOfWeek = args.periodStartDayOfWeek ?? plan.periodStartDayOfWeek;
    const finalDayOfMonth = args.periodStartDayOfMonth ?? plan.periodStartDayOfMonth;

    if ((finalFrequency === 'WEEKLY' || finalFrequency === 'BIWEEKLY') && !finalDayOfWeek) {
      throw new Error('WEEKLY and BIWEEKLY frequencies require periodStartDayOfWeek');
    }

    if (finalFrequency === 'MONTHLY' && !finalDayOfMonth) {
      throw new Error('MONTHLY frequency requires periodStartDayOfMonth');
    }

    await ctx.db.patch(args.planId, updates);
    return null;
  },
});

/**
 * Archive a pay plan (soft delete)
 */
export const archive = mutation({
  args: {
    planId: v.id('payPlans'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');

    // Check if any drivers are using this plan
    const driversUsingPlan = await ctx.db
      .query('drivers')
      .filter((q) => q.eq(q.field('payPlanId'), args.planId))
      .collect();

    if (driversUsingPlan.length > 0) {
      throw new Error(
        `Cannot archive pay plan. ${driversUsingPlan.length} driver(s) are currently assigned to it.`
      );
    }

    await ctx.db.patch(args.planId, {
      isActive: false,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Restore an archived pay plan
 */
export const restore = mutation({
  args: {
    planId: v.id('payPlans'),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');

    await ctx.db.patch(args.planId, {
      isActive: true,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Assign a pay plan to a driver
 */
export const assignToDriver = mutation({
  args: {
    driverId: v.id('drivers'),
    planId: v.optional(v.id('payPlans')), // null to unassign
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const driver = await ctx.db.get(args.driverId);
    if (!driver) throw new Error('Driver not found');

    if (args.planId) {
      const plan = await ctx.db.get(args.planId);
      if (!plan) throw new Error('Pay plan not found');
      if (!plan.isActive) throw new Error('Cannot assign inactive pay plan');
    }

    await ctx.db.patch(args.driverId, {
      payPlanId: args.planId,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Bulk assign a pay plan to multiple drivers
 */
export const bulkAssignToDrivers = mutation({
  args: {
    driverIds: v.array(v.id('drivers')),
    planId: v.id('payPlans'),
  },
  returns: v.object({
    success: v.number(),
    failed: v.number(),
  }),
  handler: async (ctx, args) => {
    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');
    if (!plan.isActive) throw new Error('Cannot assign inactive pay plan');

    let success = 0;
    let failed = 0;

    for (const driverId of args.driverIds) {
      try {
        const driver = await ctx.db.get(driverId);
        if (driver) {
          await ctx.db.patch(driverId, {
            payPlanId: args.planId,
            updatedAt: Date.now(),
          });
          success++;
        } else {
          failed++;
        }
      } catch {
        failed++;
      }
    }

    return { success, failed };
  },
});

/**
 * Get all drivers assigned to a specific pay plan
 */
export const getDriversOnPlan = query({
  args: {
    planId: v.id('payPlans'),
  },
  returns: v.array(
    v.object({
      _id: v.id('drivers'),
      firstName: v.string(),
      lastName: v.string(),
      email: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    const drivers = await ctx.db
      .query('drivers')
      .filter((q) => q.eq(q.field('payPlanId'), args.planId))
      .collect();

    return drivers.map((d) => ({
      _id: d._id,
      firstName: d.firstName,
      lastName: d.lastName,
      email: d.email,
    }));
  },
});

