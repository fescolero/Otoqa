import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { Doc, Id } from './_generated/dataModel';
import { assertCallerOwnsOrg, requireCallerOrgId, requireCallerIdentity } from './lib/auth';
import { logAudit } from './lib/audit';

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

// ── timezone-aware calendar math ────────────────────────────────────────────
//
// Period boundaries are "midnight on day X in the plan's timezone" (plan
// override > org default > America/New_York) — NOT server-UTC midnights,
// which read a day off for anyone west of Greenwich. All calendar arithmetic
// happens in WALL-CLOCK space: a "wall" Date carries the tz-local calendar
// values in its UTC fields, so getUTCDay/setUTCDate do calendar math free of
// the server's own timezone. Conversions happen only at the edges:
// instant → wall ("what day is it there?") and wall midnight → instant
// ("when is midnight there?").

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function tzFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock components of an instant in `timeZone`, as a UTC-field Date. */
function wallFromInstant(ms: number, timeZone: string): Date {
  try {
    const parts: Record<string, string> = {};
    for (const p of tzFormatter(timeZone).formatToParts(new Date(ms))) {
      if (p.type !== 'literal') parts[p.type] = p.value;
    }
    return new Date(Date.UTC(
      +parts.year, +parts.month - 1, +parts.day,
      +parts.hour === 24 ? 0 : +parts.hour, +parts.minute, +parts.second,
    ));
  } catch {
    // Unknown/unsupported zone — fall back to UTC wall clock.
    return new Date(ms);
  }
}

/** Instant (UTC ms) of the wall-clock time in `wall`'s UTC fields,
 *  interpreted in `timeZone`. Second pass corrects across DST edges. */
function instantFromWall(wall: Date, timeZone: string): number {
  const wallMs = wall.getTime();
  let guess = wallMs;
  for (let i = 0; i < 2; i++) {
    const offset = wallFromInstant(guess, timeZone).getTime() - guess;
    guess = wallMs - offset;
  }
  return guess;
}

/** Parse a "YYYY-MM-DD" anchor into a wall-clock midnight, or null. */
function parseAnchorDate(anchor: string | undefined): Date | null {
  if (!anchor) return null;
  const m = anchor.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}

/** Weekday name from an anchor date — lets BIWEEKLY derive its start day. */
const DOW_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
function dayOfWeekFromAnchor(anchor: string): (typeof DOW_NAMES)[number] | null {
  const d = parseAnchorDate(anchor);
  return d ? DOW_NAMES[d.getUTCDay()] : null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Most recent WEEKLY period start (wall space). */
function weeklyWallStart(wallRef: Date, startDayOfWeek: number): Date {
  const d = new Date(wallRef);
  const daysToSubtract = (d.getUTCDay() - startDayOfWeek + 7) % 7;
  d.setUTCDate(d.getUTCDate() - daysToSubtract);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Most recent BIWEEKLY period start (wall space).
 *
 * With an explicit anchor ("first period starts" date) every 14-day cycle
 * counts forward from it — this is what lets an org control which week is
 * the "on" week; references before the anchor resolve to the anchor itself.
 * Without one, falls back to the legacy fixed anchor (Jan 1, 2024, adjusted
 * to the configured weekday) so pre-existing plans keep their boundaries.
 */
function biweeklyWallStart(wallRef: Date, startDayOfWeek: number, biweeklyAnchor?: string): Date {
  const explicit = parseAnchorDate(biweeklyAnchor);
  let anchor: Date;
  if (explicit) {
    anchor = explicit;
  } else {
    anchor = new Date(Date.UTC(2024, 0, 1)); // a Monday
    const adj = (startDayOfWeek - anchor.getUTCDay() + 7) % 7;
    anchor.setUTCDate(anchor.getUTCDate() + adj);
  }
  const ref = new Date(wallRef);
  ref.setUTCHours(0, 0, 0, 0);
  const daysSince = Math.floor((ref.getTime() - anchor.getTime()) / MS_PER_DAY);
  const cycles = Math.max(0, Math.floor(daysSince / 14));
  const d = new Date(anchor);
  d.setUTCDate(d.getUTCDate() + cycles * 14);
  return d;
}

/** SEMIMONTHLY period start (wall space) — fixed 1st / 16th. */
function semimonthlyWallStart(wallRef: Date): Date {
  const d = new Date(wallRef);
  d.setUTCDate(d.getUTCDate() <= 15 ? 1 : 16);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** MONTHLY period start (wall space), clamped to short months. */
function monthlyWallStart(wallRef: Date, startDayOfMonth: number): Date {
  const d = new Date(wallRef);
  const lastDayOfMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  if (d.getUTCDate() < Math.min(startDayOfMonth, lastDayOfMonth)) {
    d.setUTCDate(1); // avoid month-length rollover surprises
    d.setUTCMonth(d.getUTCMonth() - 1);
  }
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(startDayOfMonth, lastDayOfTargetMonth));
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** EXCLUSIVE period end (= next period's start) in wall space. */
function wallPeriodEndExclusive(
  wallStart: Date,
  frequency: 'WEEKLY' | 'BIWEEKLY' | 'SEMIMONTHLY' | 'MONTHLY',
): Date {
  const d = new Date(wallStart);
  switch (frequency) {
    case 'WEEKLY':
      d.setUTCDate(d.getUTCDate() + 7);
      break;
    case 'BIWEEKLY':
      d.setUTCDate(d.getUTCDate() + 14);
      break;
    case 'SEMIMONTHLY':
      if (wallStart.getUTCDate() === 1) {
        d.setUTCDate(16);
      } else {
        d.setUTCDate(1);
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
      break;
    case 'MONTHLY':
      d.setUTCMonth(d.getUTCMonth() + 1);
      break;
  }
  return d;
}

/**
 * Calculate the current period for a pay plan. Boundaries land at midnight
 * in `timezone` (defaults to the plan's own override, then America/New_York
 * — callers with ctx should pass the org-resolved zone).
 */
export function calculateCurrentPeriod(
  plan: Doc<'payPlans'>,
  referenceDate: Date = new Date(),
  timezone?: string,
): { periodStart: Date; periodEnd: Date; payDate: Date } {
  const tz = timezone ?? plan.timezone ?? 'America/New_York';
  const wallRef = wallFromInstant(referenceDate.getTime(), tz);

  let wallStart: Date;
  switch (plan.frequency) {
    case 'WEEKLY':
      if (!plan.periodStartDayOfWeek) {
        throw new Error('WEEKLY frequency requires periodStartDayOfWeek');
      }
      wallStart = weeklyWallStart(wallRef, getDayOfWeekNumber(plan.periodStartDayOfWeek));
      break;
    case 'BIWEEKLY':
      if (!plan.periodStartDayOfWeek && !plan.biweeklyAnchor) {
        throw new Error('BIWEEKLY frequency requires periodStartDayOfWeek or biweeklyAnchor');
      }
      wallStart = biweeklyWallStart(
        wallRef,
        plan.periodStartDayOfWeek ? getDayOfWeekNumber(plan.periodStartDayOfWeek) : 0,
        plan.biweeklyAnchor,
      );
      break;
    case 'SEMIMONTHLY':
      wallStart = semimonthlyWallStart(wallRef);
      break;
    case 'MONTHLY':
      wallStart = monthlyWallStart(wallRef, plan.periodStartDayOfMonth || 1);
      break;
    default:
      throw new Error(`Unknown frequency: ${plan.frequency}`);
  }

  const wallEndExclusive = wallPeriodEndExclusive(wallStart, plan.frequency);
  const wallPay = new Date(wallEndExclusive);
  wallPay.setUTCDate(wallPay.getUTCDate() + plan.paymentLagDays);

  return {
    periodStart: new Date(instantFromWall(wallStart, tz)),
    // 23:59:59.999 local on the period's last day.
    periodEnd: new Date(instantFromWall(wallEndExclusive, tz) - 1),
    payDate: new Date(instantFromWall(wallPay, tz)),
  };
}

/**
 * Calculate next N periods for preview.
 */
export function calculateNextPeriods(
  plan: Doc<'payPlans'>,
  count: number = 3,
  timezone?: string,
): Array<{ periodStart: Date; periodEnd: Date; payDate: Date; label: string }> {
  const tz = timezone ?? plan.timezone ?? 'America/New_York';
  const periods: Array<{ periodStart: Date; periodEnd: Date; payDate: Date; label: string }> = [];
  let referenceDate = new Date();

  for (let i = 0; i < count; i++) {
    const period = calculateCurrentPeriod(plan, referenceDate, tz);

    const formatDate = (d: Date) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
    const label = `${formatDate(period.periodStart)} - ${formatDate(period.periodEnd)}`;

    periods.push({ ...period, label });

    // Move reference to after this period for next iteration
    referenceDate = new Date(period.periodEnd.getTime() + 1);
  }

  return periods;
}

// Doc-shaped return fields for queries that spread a payPlans document
// (list / get). ONE source of truth — when a field is added to the payPlans
// schema, add it here once and every doc-spreading validator picks it up;
// hand-duplicated copies drifted from the schema before (currency /
// amendmentPolicy were saved by mutations but rejected by the validators).
const PAY_PLAN_DOC_FIELDS = {
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
  biweeklyAnchor: v.optional(v.string()),
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
  currency: v.optional(v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))),
  amendmentPolicy: v.optional(v.union(
    v.literal('REJECT_LATE_CHANGES'),
    v.literal('CASCADE_TO_NEXT'),
    v.literal('REOPEN_ALLOWED'),
  )),
  isActive: v.boolean(),
  isDefault: v.optional(v.boolean()),
  createdAt: v.float64(),
  createdBy: v.string(),
  updatedAt: v.optional(v.float64()),
};

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
      ...PAY_PLAN_DOC_FIELDS,
      driverCount: v.number(),
    })
  ),
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

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
          .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
          .filter((q) =>
            q.and(
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
      ...PAY_PLAN_DOC_FIELDS,
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
    const callerOrgId = await requireCallerOrgId(ctx);

    const plan = await ctx.db.get(args.planId);
    if (!plan) return null;
    if (plan.workosOrgId !== callerOrgId) return null;

    const resolvedTimezone = await resolveTimezone(ctx, plan);
    const currentPeriod = calculateCurrentPeriod(plan, new Date(), resolvedTimezone);
    const nextPeriods = calculateNextPeriods(plan, 3, resolvedTimezone);

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
    const callerOrgId = await requireCallerOrgId(ctx);

    const driver = await ctx.db.get(args.driverId);
    if (!driver) return null;
    if (driver.organizationId !== callerOrgId) return null;
    if (!driver.payPlanId) return null;

    const plan = await ctx.db.get(driver.payPlanId);
    if (!plan) return null;

    const currentPeriod = calculateCurrentPeriod(plan, new Date(), await resolveTimezone(ctx, plan));

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
    const callerOrgId = await requireCallerOrgId(ctx);

    const plan = await ctx.db.get(args.planId);
    if (!plan || !plan.isActive) return null;
    if (plan.workosOrgId !== callerOrgId) return null;

    const currentPeriod = calculateCurrentPeriod(plan, new Date(), await resolveTimezone(ctx, plan));

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
    await assertCallerOwnsOrg(ctx, args.workosOrgId);

    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', args.workosOrgId))
      .filter((q) =>
        q.and(
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
    biweeklyAnchor: v.optional(v.string()),
    paymentLagDays: v.number(),
    // Plan-level timezone override being edited; org default when absent.
    timezone: v.optional(v.string()),
  },
  returns: v.object({
    // The zone the boundaries were computed in — the client formats dates in
    // this same zone so what the user picks is what they read back.
    timezone: v.string(),
    periods: v.array(
      v.object({
        periodStart: v.float64(),
        periodEnd: v.float64(),
        payDate: v.float64(),
        label: v.string(),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const callerOrgId = await requireCallerOrgId(ctx);

    // Resolve like a saved plan would: override > org default > system default.
    let timezone = args.timezone;
    if (!timezone) {
      const org = await ctx.db
        .query('organizations')
        .withIndex('by_organization', (q) => q.eq('workosOrgId', callerOrgId))
        .first();
      timezone = org?.defaultTimezone || 'America/New_York';
    }

    // Draft plan shape — same math as saved plans, no doc required.
    const draftPlan = {
      frequency: args.frequency,
      periodStartDayOfWeek: args.periodStartDayOfWeek,
      periodStartDayOfMonth: args.periodStartDayOfMonth,
      biweeklyAnchor: args.biweeklyAnchor,
      paymentLagDays: args.paymentLagDays,
      timezone,
    } as Doc<'payPlans'>;

    const periods = calculateNextPeriods(draftPlan, 3, timezone);
    return {
      timezone,
      periods: periods.map((p) => ({
        periodStart: p.periodStart.getTime(),
        periodEnd: p.periodEnd.getTime(),
        payDate: p.payDate.getTime(),
        label: p.label,
      })),
    };
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
    biweeklyAnchor: v.optional(v.string()),
    currency: v.optional(v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))),
    amendmentPolicy: v.optional(v.union(
      v.literal('REJECT_LATE_CHANGES'),
      v.literal('CASCADE_TO_NEXT'),
      v.literal('REOPEN_ALLOWED'),
    )),
    isDefault: v.optional(v.boolean()),
    userId: v.string(),
  },
  returns: v.id('payPlans'),
  handler: async (ctx, args) => {
    const { userId, userName, userEmail } = await assertCallerOwnsOrg(ctx, args.workosOrgId);

    // BIWEEKLY can derive its weekday from the anchor date; the anchor is the
    // authoritative control for which week is the "on" week.
    let periodStartDayOfWeek = args.periodStartDayOfWeek;
    if (args.frequency === 'BIWEEKLY' && !periodStartDayOfWeek && args.biweeklyAnchor) {
      periodStartDayOfWeek = dayOfWeekFromAnchor(args.biweeklyAnchor) ?? undefined;
    }
    if (args.biweeklyAnchor && !parseAnchorDate(args.biweeklyAnchor)) {
      throw new Error('biweeklyAnchor must be a YYYY-MM-DD date');
    }

    // Validate frequency-specific fields
    if ((args.frequency === 'WEEKLY' || args.frequency === 'BIWEEKLY') && !periodStartDayOfWeek) {
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

    // Single default per org: making this plan the default unsets any other.
    if (args.isDefault) {
      const siblings = await ctx.db
        .query('payPlans')
        .withIndex('by_org', (q) => q.eq('workosOrgId', args.workosOrgId))
        .collect();
      for (const s of siblings) {
        if (s.isDefault) await ctx.db.patch(s._id, { isDefault: false, updatedAt: now });
      }
    }

    const planId = await ctx.db.insert('payPlans', {
      workosOrgId: args.workosOrgId,
      name: args.name,
      description: args.description,
      frequency: args.frequency,
      periodStartDayOfWeek,
      periodStartDayOfMonth: args.periodStartDayOfMonth,
      biweeklyAnchor: args.biweeklyAnchor,
      timezone: args.timezone,
      cutoffTime: args.cutoffTime,
      paymentLagDays: args.paymentLagDays,
      payableTrigger: args.payableTrigger,
      autoCarryover: args.autoCarryover,
      includeStandaloneAdjustments: args.includeStandaloneAdjustments,
      currency: args.currency,
      amendmentPolicy: args.amendmentPolicy,
      isActive: true,
      isDefault: args.isDefault,
      createdAt: now,
      createdBy: userId,
    });

    // Log the creation
    await logAudit(ctx, {
      organizationId: args.workosOrgId,
      entityType: 'payPlan',
      entityId: planId,
      entityName: args.name,
      action: 'created',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Created pay plan "${args.name}"`,
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
    biweeklyAnchor: v.optional(v.string()),
    currency: v.optional(v.union(v.literal('USD'), v.literal('CAD'), v.literal('MXN'))),
    amendmentPolicy: v.optional(v.union(
      v.literal('REJECT_LATE_CHANGES'),
      v.literal('CASCADE_TO_NEXT'),
      v.literal('REOPEN_ALLOWED'),
    )),
    isDefault: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');
    if (plan.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    const now = Date.now();
    const updates: Partial<Doc<'payPlans'>> = {
      updatedAt: now,
    };

    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (args.frequency !== undefined) updates.frequency = args.frequency;
    if (args.periodStartDayOfWeek !== undefined) updates.periodStartDayOfWeek = args.periodStartDayOfWeek;
    if (args.periodStartDayOfMonth !== undefined) updates.periodStartDayOfMonth = args.periodStartDayOfMonth;
    if (args.biweeklyAnchor !== undefined) updates.biweeklyAnchor = args.biweeklyAnchor;
    if (args.timezone !== undefined) updates.timezone = args.timezone;
    if (args.cutoffTime !== undefined) updates.cutoffTime = args.cutoffTime;
    if (args.paymentLagDays !== undefined) updates.paymentLagDays = args.paymentLagDays;
    if (args.payableTrigger !== undefined) updates.payableTrigger = args.payableTrigger;
    if (args.autoCarryover !== undefined) updates.autoCarryover = args.autoCarryover;
    if (args.includeStandaloneAdjustments !== undefined) updates.includeStandaloneAdjustments = args.includeStandaloneAdjustments;
    if (args.currency !== undefined) updates.currency = args.currency;
    if (args.amendmentPolicy !== undefined) updates.amendmentPolicy = args.amendmentPolicy;
    if (args.isDefault !== undefined) updates.isDefault = args.isDefault;

    if (args.biweeklyAnchor && !parseAnchorDate(args.biweeklyAnchor)) {
      throw new Error('biweeklyAnchor must be a YYYY-MM-DD date');
    }

    // Validate frequency-specific fields with the final values
    const finalFrequency = args.frequency ?? plan.frequency;
    const finalDayOfMonth = args.periodStartDayOfMonth ?? plan.periodStartDayOfMonth;
    const finalAnchor = args.biweeklyAnchor ?? plan.biweeklyAnchor;
    let finalDayOfWeek = args.periodStartDayOfWeek ?? plan.periodStartDayOfWeek;

    // BIWEEKLY keeps its weekday in lockstep with the anchor date.
    if (finalFrequency === 'BIWEEKLY' && finalAnchor) {
      const derived = dayOfWeekFromAnchor(finalAnchor);
      if (derived) {
        finalDayOfWeek = derived;
        updates.periodStartDayOfWeek = derived;
      }
    }

    if ((finalFrequency === 'WEEKLY' || finalFrequency === 'BIWEEKLY') && !finalDayOfWeek) {
      throw new Error('WEEKLY and BIWEEKLY frequencies require periodStartDayOfWeek');
    }

    if (finalFrequency === 'MONTHLY' && !finalDayOfMonth) {
      throw new Error('MONTHLY frequency requires periodStartDayOfMonth');
    }

    // Single default per org: promoting this plan demotes any other default.
    if (args.isDefault === true && !plan.isDefault) {
      const siblings = await ctx.db
        .query('payPlans')
        .withIndex('by_org', (q) => q.eq('workosOrgId', plan.workosOrgId))
        .collect();
      for (const s of siblings) {
        if (s._id !== plan._id && s.isDefault) {
          await ctx.db.patch(s._id, { isDefault: false, updatedAt: now });
        }
      }
    }

    await ctx.db.patch(args.planId, updates);

    // Log the update
    {
      const changedFields = Object.keys(updates).filter((key) => key !== 'updatedAt');
      await logAudit(ctx, {
        organizationId: plan.workosOrgId,
        entityType: 'payPlan',
        entityId: args.planId,
        entityName: args.name ?? plan.name,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Updated pay plan "${args.name ?? plan.name}"`,
        changedFields,
      });
    }

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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');
    if (plan.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    if (plan.isDefault) {
      throw new Error('Cannot archive the default pay plan. Set another plan as default first.');
    }

    // Check if any drivers are using this plan
    const driversUsingPlan = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', callerOrgId))
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

    // Log the archival
    await logAudit(ctx, {
      organizationId: plan.workosOrgId,
      entityType: 'payPlan',
      entityId: args.planId,
      entityName: plan.name,
      action: 'archived',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Archived pay plan "${plan.name}"`,
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');
    if (plan.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');

    await ctx.db.patch(args.planId, {
      isActive: true,
      updatedAt: Date.now(),
    });

    // Log the restoration
    await logAudit(ctx, {
      organizationId: plan.workosOrgId,
      entityType: 'payPlan',
      entityId: args.planId,
      entityName: plan.name,
      action: 'restored',
      performedBy: userId,
      performedByName: userName,
      performedByEmail: userEmail,
      description: `Restored pay plan "${plan.name}"`,
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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const driver = await ctx.db.get(args.driverId);
    if (!driver) throw new Error('Driver not found');
    if (driver.organizationId !== callerOrgId) throw new Error('Not authorized for this organization');

    let plan: Doc<'payPlans'> | null = null;
    if (args.planId) {
      plan = await ctx.db.get(args.planId);
      if (!plan) throw new Error('Pay plan not found');
      if (!plan.isActive) throw new Error('Cannot assign inactive pay plan');
    }

    const previousPlanId = driver.payPlanId;

    await ctx.db.patch(args.driverId, {
      payPlanId: args.planId,
      updatedAt: Date.now(),
    });

    // Log the assignment (or unassignment against the previous plan)
    const auditPlanId = args.planId ?? previousPlanId;
    if (auditPlanId) {
      await logAudit(ctx, {
        organizationId: driver.organizationId,
        entityType: 'payPlan',
        entityId: auditPlanId,
        entityName: plan?.name,
        action: 'updated',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: plan
          ? `Assigned pay plan "${plan.name}" to driver ${driver.firstName} ${driver.lastName}`
          : `Unassigned pay plan from driver ${driver.firstName} ${driver.lastName}`,
        metadata: JSON.stringify({ driverId: args.driverId }),
      });
    }

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
    const { orgId: callerOrgId, userId, userName, userEmail } = await requireCallerIdentity(ctx);

    const plan = await ctx.db.get(args.planId);
    if (!plan) throw new Error('Pay plan not found');
    if (plan.workosOrgId !== callerOrgId) throw new Error('Not authorized for this organization');
    if (!plan.isActive) throw new Error('Cannot assign inactive pay plan');

    let success = 0;
    let failed = 0;

    for (const driverId of args.driverIds) {
      try {
        const driver = await ctx.db.get(driverId);
        if (driver && driver.organizationId === callerOrgId) {
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

    // Log the bulk assignment
    if (success > 0) {
      await logAudit(ctx, {
        organizationId: plan.workosOrgId,
        entityType: 'payPlan',
        entityId: args.planId,
        entityName: plan.name,
        action: 'bulk_assigned',
        performedBy: userId,
        performedByName: userName,
        performedByEmail: userEmail,
        description: `Assigned pay plan "${plan.name}" to ${success} driver(s)`,
        metadata: JSON.stringify({ success, failed }),
      });
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
    const callerOrgId = await requireCallerOrgId(ctx);

    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.workosOrgId !== callerOrgId) return [];

    const drivers = await ctx.db
      .query('drivers')
      .withIndex('by_organization', (q) => q.eq('organizationId', callerOrgId))
      .filter((q) => q.eq(q.field('payPlanId'), args.planId))
      .collect();

    return drivers
      .filter((d) => d.organizationId === callerOrgId)
      .map((d) => ({
        _id: d._id,
        firstName: d.firstName,
        lastName: d.lastName,
        email: d.email,
      }));
  },
});
