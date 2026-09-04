/**
 * Human labels for routeRotation's hold reasons (convex/routeRotation.ts).
 * Unknown codes fall through to the raw string rather than vanishing — a
 * new reason showing up as "OVERLAP_CONFLICT" beats it silently dropping
 * out of the breakdown.
 */
export const ROTATION_REASON_LABELS: Record<string, string> = {
  // Not released — left where it is.
  IN_MOTION: 'already in progress',
  PAST: 'pickup date has passed',
  NO_SERVICE_DATE: 'no pickup date',
  MOVED_BY_HUMAN: 'moved by a dispatcher',
  IN_SYNC: 'already in sync',
  // Released, then not re-placed — left Open for dispatch, with the
  // assignment decision's own reason.
  BEYOND_HORIZON: 'released — will be assigned when due',
  NO_MATCH: 'released — no rule claims it now',
  DAY_RESTRICTED: 'released — no rule runs that day',
  OVERLAP_CONFLICT: 'released — assignee already booked, left open',
  DRIVER_INACTIVE: 'released — driver inactive, left open',
  CARRIER_INACTIVE: 'released — carrier inactive, left open',
  UNCLAIMED_RELEASED: 'released — assigned before rules had days, no rule claims it now',
  OPTED_OUT: 'excluded from auto-assignment',
  ALREADY_ASSIGNED: 'already assigned',
  ERROR: 'error',
};

export function describeHolds(byReason: Array<{ reason: string; count: number }>): string {
  return byReason
    .map((r) => `${r.count} ${ROTATION_REASON_LABELS[r.reason] ?? r.reason}`)
    .join(', ');
}

/** "just now" / "12 min ago" / "3h ago" / a date. */
export function formatAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(ms).toLocaleDateString();
}
