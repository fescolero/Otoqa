/**
 * Assignment horizon — "don't assign a load more than N days before it
 * runs."
 *
 * Auto-assignment used to fire the moment a load existed: a FourKites
 * import carrying next month's schedule committed drivers to every load in
 * it on the spot. That is too many loads and too far ahead — it locks in
 * decisions weeks before anyone knows who is on rotation, and a driver
 * rotation then has to unwind all of them.
 *
 * The horizon is anchored to the LOAD'S SERVICE DATE (`firstStopDate`),
 * not the wall clock. That is the same anchor the route calendar uses
 * (lib/routeMatch.ts) and it is what keeps this different from the
 * org-level "run window" the spec rejected (docs/auto-assignment-
 * scheduling-spec.md §B): a load beyond the horizon is not blocked, it is
 * simply not yet due. Every scheduled sweep re-evaluates it, and the sweep
 * picks it up the day it crosses the line. Nothing sits in Open past its
 * pickup, so R1's six-hour expiry fuse never bites.
 *
 * Which is also why the horizon REQUIRES the scheduled sweep: an org
 * running the on-create trigger alone has no second look, so a deferred
 * load would never be assigned. routeAssignments.updateSettings refuses
 * that combination.
 *
 * The horizon is measured from the load's SCHEDULED PICKUP TIME when the
 * first stop has one: N days means N × 24 hours before that instant, on
 * the clock, in whatever timezone the facility is in (the stop's
 * windowBeginTime carries its own offset). A load picking up at 11 PM
 * tomorrow is due 24 hours before 11 PM tomorrow, not at UTC midnight —
 * dispatch runs overnight trips and a calendar date got that wrong. The
 * calendar-date comparison below is the fallback for a load whose first
 * stop has no parseable time.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar date (YYYY-MM-DD) for a timestamp. */
export function serviceDateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A service date moved by whole days ('2026-09-14', -1 → '2026-09-13'). */
export function shiftServiceDate(ymd: string, days: number): string {
  return serviceDateOf(Date.parse(`${ymd}T00:00:00.000Z`) + days * DAY_MS);
}

/** Last service date inside the horizon, inclusive. */
export function horizonEndDate(assignAheadDays: number, nowMs = Date.now()): string {
  return serviceDateOf(nowMs + assignAheadDays * DAY_MS);
}

/**
 * Is this load too far out to assign yet?
 *
 * No horizon configured → never. No service date → never: an undated load
 * cannot be placed on the calendar, so it is left to the route rules
 * (which decline it when they are day-restricted) rather than deferred
 * indefinitely here.
 */
export function isBeyondHorizon(
  firstStopDate: string | undefined,
  assignAheadDays: number | undefined,
  nowMs = Date.now(),
): boolean {
  if (assignAheadDays === undefined) return false;
  if (!firstStopDate) return false;
  return firstStopDate > horizonEndDate(assignAheadDays, nowMs);
}

/**
 * Time-based form: is the scheduled pickup further away than the horizon?
 * `dueAtMs` is the first stop's windowBeginTime; N days = N × 24 h before
 * it. A pickup already in the past is never beyond the horizon.
 */
export function isBeyondHorizonAt(
  dueAtMs: number,
  assignAheadDays: number | undefined,
  nowMs = Date.now(),
): boolean {
  if (assignAheadDays === undefined) return false;
  return dueAtMs - nowMs > assignAheadDays * DAY_MS;
}

/**
 * Inclusive upper bound on firstStopDate for the sweep's index range: the
 * calendar date of (now + horizon), plus one day of slack so a load whose
 * local date rolls past the UTC date is still read — the precise
 * time-based check runs on each load afterwards.
 */
export function horizonPrefilterDate(assignAheadDays: number, nowMs = Date.now()): string {
  return serviceDateOf(nowMs + (assignAheadDays + 1) * DAY_MS);
}

export const MAX_ASSIGN_AHEAD_DAYS = 365;

/** Validate a horizon value from the settings form. */
export function assertValidAssignAheadDays(days: number): void {
  if (!Number.isInteger(days) || days < 0 || days > MAX_ASSIGN_AHEAD_DAYS) {
    throw new Error(
      `Assign-ahead days must be a whole number from 0 to ${MAX_ASSIGN_AHEAD_DAYS}`,
    );
  }
}
