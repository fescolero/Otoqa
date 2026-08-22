/**
 * Notification presentation rules (§5.2, design `lib-dispatch/notifications.jsx`).
 *
 * Pure and react-native-free so the node vitest project can cover them.
 *
 * The design sketches eight alert kinds; the sweep raises five
 * (TRACKING_LOST, MISSED_APPOINTMENT, POD_MISSING, LOAD_CANCELED,
 * OFFER_DECLINED). Filters and actions are written against the five that
 * actually exist rather than the design's labels — a "Check-in / out" chip
 * that can never match anything is worse than no chip.
 */

export type AlertKind =
  | 'TRACKING_LOST'
  | 'MISSED_APPOINTMENT'
  | 'POD_MISSING'
  | 'LOAD_CANCELED'
  | 'OFFER_DECLINED';

export type Severity = 'high' | 'med';

/** Ionicons name + the label the card titles itself with. */
export const ALERT_KINDS: Record<AlertKind, { label: string; icon: string }> = {
  MISSED_APPOINTMENT: { label: 'Appointment missed', icon: 'time-outline' },
  LOAD_CANCELED: { label: 'Load canceled', icon: 'close-circle-outline' },
  TRACKING_LOST: { label: 'Tracking lost', icon: 'warning-outline' },
  POD_MISSING: { label: 'POD missing', icon: 'document-text-outline' },
  OFFER_DECLINED: { label: 'Offer declined', icon: 'person-remove-outline' },
};

export function alertLabel(kind: string): string {
  return ALERT_KINDS[kind as AlertKind]?.label ?? kind;
}

export function alertIcon(kind: string): string {
  return ALERT_KINDS[kind as AlertKind]?.icon ?? 'alert-circle-outline';
}

// ── Filters ────────────────────────────────────────────────────────────────

export type AlertFilter = 'all' | 'appointments' | 'tracking' | 'paperwork' | 'cancelled';

export const ALERT_FILTERS: { k: AlertFilter; label: string }[] = [
  { k: 'all', label: 'All' },
  { k: 'appointments', label: 'Appointments' },
  { k: 'tracking', label: 'Tracking' },
  { k: 'paperwork', label: 'Paperwork' },
  { k: 'cancelled', label: 'Cancelled' },
];

const FILTER_KINDS: Record<Exclude<AlertFilter, 'all'>, AlertKind[]> = {
  appointments: ['MISSED_APPOINTMENT'],
  tracking: ['TRACKING_LOST'],
  paperwork: ['POD_MISSING'],
  // Both mean "this load lost its driver and needs a decision".
  cancelled: ['LOAD_CANCELED', 'OFFER_DECLINED'],
};

export function matchesAlertFilter(kind: string, filter: AlertFilter): boolean {
  if (filter === 'all') return true;
  return FILTER_KINDS[filter].includes(kind as AlertKind);
}

// ── Actions ────────────────────────────────────────────────────────────────

/**
 * What a button does, not how. Returning descriptors rather than callbacks
 * keeps this module free of the router and Linking, so the routing rules can
 * be asserted directly.
 */
export type AlertActionKind = 'call' | 'load' | 'map' | 'assign' | 'adjust';

export interface AlertAction {
  kind: AlertActionKind;
  label: string;
}

export interface AlertLike {
  kind: string;
  driver?: { firstName?: string | null; phone?: string | null } | null;
  loadId?: string | null;
  assignmentId?: string | null;
}

/**
 * The primary action is the one that resolves the alert; the secondary is
 * the one that explains it.
 *
 * Every action is dropped when the data it needs is absent — a "Call driver"
 * button on an alert with no phone number is a dead end, and a dispatcher
 * discovering that mid-incident is worse than never offering it.
 */
export function alertActions(alert: AlertLike): {
  primary: AlertAction | null;
  secondary: AlertAction | null;
} {
  const canCall = !!alert.driver?.phone;
  const canLoad = !!alert.loadId;
  const canAssignment = !!alert.assignmentId;

  const call: AlertAction | null = canCall
    ? { kind: 'call', label: alert.driver?.firstName ? `Call ${alert.driver.firstName}` : 'Call driver' }
    : null;
  const load: AlertAction | null = canLoad ? { kind: 'load', label: 'View load' } : null;
  const map: AlertAction = { kind: 'map', label: 'View on map' };

  switch (alert.kind as AlertKind) {
    case 'MISSED_APPOINTMENT':
      // The window is the thing that's wrong — re-time it first.
      return {
        primary: canAssignment ? { kind: 'adjust', label: 'Move window' } : call,
        secondary: canAssignment ? call ?? load : load,
      };

    case 'OFFER_DECLINED':
      // Nobody is on this load; the only fix is another driver.
      return {
        primary: canAssignment ? { kind: 'assign', label: 'Assign someone else' } : load,
        secondary: canAssignment ? load : null,
      };

    case 'TRACKING_LOST':
      // Reaching the driver is the fix; the map shows the last known fix.
      return { primary: call ?? map, secondary: call ? map : load };

    case 'POD_MISSING':
      return { primary: call ?? load, secondary: call ? load : null };

    case 'LOAD_CANCELED':
      // Nothing to re-time or re-assign — the load is gone. Read it, tell
      // the driver.
      return { primary: load ?? call, secondary: load ? call : null };

    default:
      return { primary: load, secondary: call };
  }
}

// ── Age ────────────────────────────────────────────────────────────────────

/**
 * Compact age for the card header. Whole minutes under an hour, then
 * "1h 11m" — the design's format, because how stale an alert is changes how
 * urgently a dispatcher treats it.
 */
export function formatAge(createdAt: number, now: number): string {
  const ms = Math.max(0, now - createdAt);
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem === 0 ? `${hours}h ago` : `${hours}h ${rem}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
