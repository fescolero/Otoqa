import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';
import { getHolidaySet } from '../holidays';

/**
 * Route-assignment matching — the single supported way to resolve
 * (org, HCR, trip, service date) to the route rule that should drive
 * auto-assignment.
 *
 * This logic used to exist in four places that had already drifted:
 * autoAssignment.autoAssignLoad (sweep), autoAssignment
 * .triggerAutoAssignmentForLoad (on create), autoAssignment
 * .findRouteAssignment (dead), and routeAssignments.getByRoute (which was
 * missing the third tier, so the UI preview disagreed with the engine).
 * Any new matching rule belongs here and nowhere else.
 *
 * Tiers, most specific first:
 *   1. exact HCR + trip
 *   2. HCR-only rule (a route with no tripNumber — "everything on this HCR")
 *
 * There is deliberately no third "any active route on this HCR" tier. One
 * used to exist, and it silently promoted every trip-specific rule into an
 * HCR-wide catch-all: a rule scoped to Trip 1 would claim a load on Trip
 * 821 purely because no Trip 821 rule existed. With several same-priority
 * rules on an HCR the winner was effectively a tiebreak, so loads landed on
 * a driver nobody had assigned them to and no rule in the UI explained why.
 * The legitimate catch-all is tier 2, which says so explicitly by omitting
 * the trip. A trip with no rule is now a NO_MATCH that stays Open for a
 * dispatcher — visible in the run breakdown rather than silently absorbed.
 *
 * Within a tier, lowest `priority` wins. That sort is the point: every
 * previous copy used `.first()`, which returns index order, so `priority`
 * was stored, edited, and displayed but never actually consulted.
 */

/** Every weekday index, in order. */
export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

/**
 * The days a route can actually serve.
 *
 * Absent or empty `activeDays` means every day — that is the stored
 * representation of "unrestricted" (a full seven-day selection normalizes
 * back to absent), so it must expand rather than read as "no days".
 *
 * Federal-holiday and custom-date exclusions are deliberately NOT
 * subtracted here. They are refinements within a day the route otherwise
 * serves, and letting them create apparent disjointness would mean two
 * rules could both claim Monday as long as one skipped a holiday.
 */
export function routeDaySet(route: { activeDays?: number[] }): number[] {
  return route.activeDays !== undefined && route.activeDays.length > 0
    ? [...new Set(route.activeDays)].sort((a, b) => a - b)
    : ALL_WEEKDAYS;
}

/** Days two routes would both claim. Empty means they never compete. */
export function overlappingDays(
  a: { activeDays?: number[] },
  b: { activeDays?: number[] },
): number[] {
  const bDays = new Set(routeDaySet(b));
  return routeDaySet(a).filter((d) => bDays.has(d));
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Why no route matched, when routes did exist on the HCR. */
export type RouteDeclineReason = 'CALENDAR' | 'NO_SERVICE_DATE';

export type RouteMatch = {
  route: Doc<'routeAssignments'> | null;
  /** Set only when `route` is null AND at least one active route on this
   *  HCR was rejected by its service calendar rather than simply not
   *  existing. Lets callers report "declined for Tuesday" separately from
   *  "no rule configured". */
  declinedBecause?: RouteDeclineReason;
};

/**
 * Does this route run on `serviceDate` (a business-local YYYY-MM-DD)?
 *
 * A route with no calendar fields runs every day, which is every row that
 * existed before this feature — the absent case must stay permissive.
 *
 * The weekday is a pure string operation, deliberately. `firstStopDate` is
 * sliced off the stop's `windowBeginDate`, an ISO string carrying the
 * facility's own UTC offset, so the date is already local to the pickup.
 * Parsing it as a bare calendar date and reading getUTCDay() gives the
 * weekday a dispatcher would name. Do NOT reach for Intl/timezones here —
 * that would re-interpret an already-local date and shift it.
 * Same approach as recurringLoads.generateLoadsForOrg.
 */
export function routeServesDate(
  route: Doc<'routeAssignments'>,
  serviceDate: string | undefined,
): { serves: true } | { serves: false; reason: RouteDeclineReason } {
  const restricted =
    (route.activeDays !== undefined && route.activeDays.length > 0) ||
    route.excludeFederalHolidays === true ||
    (route.customExclusions !== undefined && route.customExclusions.length > 0);

  if (!restricted) return { serves: true };

  // A restricted route will not take a load whose service date is unknown.
  // Guessing puts a Mon/Wed/Fri driver on an undated load; declining leaves
  // it Open in front of a dispatcher, which is the safer failure.
  if (!serviceDate) return { serves: false, reason: 'NO_SERVICE_DATE' };

  if (route.activeDays !== undefined && route.activeDays.length > 0) {
    const dayOfWeek = new Date(`${serviceDate}T00:00:00.000Z`).getUTCDay();
    if (!route.activeDays.includes(dayOfWeek)) {
      return { serves: false, reason: 'CALENDAR' };
    }
  }

  if (route.customExclusions?.includes(serviceDate)) {
    return { serves: false, reason: 'CALENDAR' };
  }

  if (route.excludeFederalHolidays) {
    const year = Number(serviceDate.slice(0, 4));
    if (Number.isFinite(year) && getHolidaySet(year).has(serviceDate)) {
      return { serves: false, reason: 'CALENDAR' };
    }
  }

  return { serves: true };
}

/** Candidates are collected and filtered in JS rather than via `.filter()`
 *  on the query: array-valued rules (activeDays, customExclusions) can't be
 *  expressed in a Convex index or filter, and per-(org, HCR) row counts are
 *  small. */
function pick(
  candidates: Doc<'routeAssignments'>[],
  serviceDate: string | undefined,
  declines: Set<RouteDeclineReason>,
): Doc<'routeAssignments'> | null {
  const serving = [...candidates]
    .sort((a, b) => a.priority - b.priority)
    .filter((r) => {
      const verdict = routeServesDate(r, serviceDate);
      // A route that declines the date is PASSED OVER, not fatal — a
      // Mon-Fri driver rule at priority 1 must let an all-days carrier rule
      // at priority 2 take the Saturday load.
      if (!verdict.serves) declines.add(verdict.reason);
      return verdict.serves;
    });

  return serving[0] ?? null;
}

export async function matchRouteAssignment(
  ctx: QueryCtx | MutationCtx,
  args: { workosOrgId: string; hcr: string; trip?: string; serviceDate?: string },
): Promise<RouteMatch> {
  const declines = new Set<RouteDeclineReason>();

  // Tier 1 — exact HCR + trip.
  if (args.trip) {
    const exact = await ctx.db
      .query('routeAssignments')
      .withIndex('by_org_hcr_trip', (q) =>
        q.eq('workosOrgId', args.workosOrgId).eq('hcr', args.hcr).eq('tripNumber', args.trip),
      )
      .collect();

    const hit = pick(exact.filter((r) => r.isActive), args.serviceDate, declines);
    if (hit) return { route: hit };
  }

  // Tier 2 — the HCR-only rule, i.e. one that deliberately omits the trip.
  const hcrOnly = (
    await ctx.db
      .query('routeAssignments')
      .withIndex('by_org_hcr', (q) => q.eq('workosOrgId', args.workosOrgId).eq('hcr', args.hcr))
      .collect()
  ).filter((r) => r.isActive && r.tripNumber === undefined);

  const hit = pick(hcrOnly, args.serviceDate, declines);
  if (hit) return { route: hit };

  // Nothing matched. Report a calendar decline only if one actually
  // happened — otherwise this is a plain "no rule configured".
  if (declines.has('CALENDAR')) return { route: null, declinedBecause: 'CALENDAR' };
  if (declines.has('NO_SERVICE_DATE')) return { route: null, declinedBecause: 'NO_SERVICE_DATE' };
  return { route: null };
}
