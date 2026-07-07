/**
 * Per-entity status state machines.
 *
 * Each entity (driver / truck / trailer / customer / carrier) has its own
 * set of valid states grouped into Active / Paused / Terminal categories.
 * The StatusPicker chassis primitive consumes these to render the popover
 * + confirmation modal — disallowed transitions render dimmed, terminal
 * states get a red warning callout, and the reason field offers
 * entity-specific options.
 *
 * Allowed transitions are advisory: when present, the popover greys out
 * impossible options. When absent, every non-self state is offered.
 */
import type { ChipStatus } from './chip';

export type StatusEntity = 'driver' | 'truck' | 'trailer' | 'customer' | 'carrier' | 'load';
export type StatusCategory = 'Active' | 'Paused' | 'Terminal';

export interface StatusState {
  id: string;
  label: string;
  /** Maps to a Chip preset (status presets in `chip.tsx`). */
  kind: ChipStatus;
  category: StatusCategory;
  /** Terminal states get a red warning callout in the confirmation modal. */
  terminal?: boolean;
}

export interface StatusMachine {
  states: Record<string, StatusState>;
  initial: string;
  /** Optional. `from -> [to, ...]`. If absent, every non-self state is allowed. */
  transitions?: Record<string, string[]>;
}

export const STATE_MACHINES: Record<StatusEntity, StatusMachine> = {
  driver: {
    states: {
      active:     { id: 'active',     label: 'Active',          kind: 'active',   category: 'Active'   },
      onboarding: { id: 'onboarding', label: 'Onboarding',      kind: 'pending',  category: 'Active'   },
      on_leave:   { id: 'on_leave',   label: 'On leave',        kind: 'warning',  category: 'Paused'   },
      suspended:  { id: 'suspended',  label: 'Suspended',       kind: 'expired',  category: 'Paused'   },
      ooo:        { id: 'ooo',        label: 'Out of service',  kind: 'inactive', category: 'Paused'   },
      terminated: { id: 'terminated', label: 'Terminated',      kind: 'cancelled',category: 'Terminal', terminal: true },
      retired:    { id: 'retired',    label: 'Retired',         kind: 'inactive', category: 'Terminal', terminal: true },
    },
    initial: 'active',
    transitions: {
      onboarding: ['active', 'terminated'],
      active:     ['on_leave', 'suspended', 'ooo', 'terminated', 'retired'],
      on_leave:   ['active', 'suspended', 'terminated'],
      suspended:  ['active', 'terminated'],
      ooo:        ['active', 'terminated'],
      terminated: [],
      retired:    [],
    },
  },
  truck: {
    states: {
      in_service:  { id: 'in_service',  label: 'In service',      kind: 'active',   category: 'Active'   },
      idle:        { id: 'idle',        label: 'Idle (in yard)',  kind: 'inactive', category: 'Active'   },
      maintenance: { id: 'maintenance', label: 'In maintenance',  kind: 'warning',  category: 'Paused'   },
      ooo:         { id: 'ooo',         label: 'Out of service',  kind: 'expired',  category: 'Paused'   },
      sold:        { id: 'sold',        label: 'Sold',            kind: 'inactive', category: 'Terminal', terminal: true },
      totaled:     { id: 'totaled',     label: 'Totaled',         kind: 'cancelled',category: 'Terminal', terminal: true },
      retired:     { id: 'retired',     label: 'Retired',         kind: 'inactive', category: 'Terminal', terminal: true },
    },
    initial: 'in_service',
  },
  trailer: {
    states: {
      in_service:  { id: 'in_service',  label: 'In service',      kind: 'active',   category: 'Active'   },
      idle:        { id: 'idle',        label: 'Idle (in yard)',  kind: 'inactive', category: 'Active'   },
      reserved:    { id: 'reserved',    label: 'Reserved',        kind: 'pending',  category: 'Active'   },
      maintenance: { id: 'maintenance', label: 'In maintenance',  kind: 'warning',  category: 'Paused'   },
      ooo:         { id: 'ooo',         label: 'Out of service',  kind: 'expired',  category: 'Paused'   },
      sold:        { id: 'sold',        label: 'Sold',            kind: 'inactive', category: 'Terminal', terminal: true },
      retired:     { id: 'retired',     label: 'Retired',         kind: 'inactive', category: 'Terminal', terminal: true },
    },
    initial: 'in_service',
  },
  customer: {
    states: {
      active:    { id: 'active',    label: 'Active',         kind: 'active',   category: 'Active'   },
      prospect:  { id: 'prospect',  label: 'Prospect',       kind: 'pending',  category: 'Active'   },
      hold:      { id: 'hold',      label: 'On credit hold', kind: 'warning',  category: 'Paused'   },
      dormant:   { id: 'dormant',   label: 'Dormant',        kind: 'inactive', category: 'Paused'   },
      do_not_use:{ id: 'do_not_use',label: 'Do-not-use',     kind: 'cancelled',category: 'Terminal', terminal: true },
      churned:   { id: 'churned',   label: 'Churned',        kind: 'inactive', category: 'Terminal', terminal: true },
    },
    initial: 'active',
  },
  carrier: {
    states: {
      approved:    { id: 'approved',    label: 'Approved',          kind: 'active',   category: 'Active'   },
      onboarding:  { id: 'onboarding',  label: 'Onboarding',        kind: 'pending',  category: 'Active'   },
      review:      { id: 'review',      label: 'Under review',      kind: 'warning',  category: 'Paused'   },
      packet_exp:  { id: 'packet_exp',  label: 'Packet expired',    kind: 'expired',  category: 'Paused'   },
      blocked:     { id: 'blocked',     label: 'Blocked',           kind: 'cancelled',category: 'Terminal', terminal: true },
      offboarded:  { id: 'offboarded',  label: 'Offboarded',        kind: 'inactive', category: 'Terminal', terminal: true },
    },
    initial: 'approved',
  },
  // Load lifecycle. The friendlier labels match the design's status chip
  // ("Open · waiting for assignment", etc.); the chip kind drives the
  // colour. Database stores the state ID capitalised (Open / Assigned /
  // Completed / Canceled / Expired) — `resolveStatusId` lowercases on
  // ingest so existing rows match a state.
  load: {
    states: {
      open:      { id: 'open',      label: 'Open',       kind: 'open',      category: 'Active'                    },
      assigned:  { id: 'assigned',  label: 'Assigned',   kind: 'assigned',  category: 'Active'                    },
      completed: { id: 'completed', label: 'Delivered',  kind: 'delivered', category: 'Terminal', terminal: true  },
      canceled:  { id: 'canceled',  label: 'Cancelled',  kind: 'cancelled', category: 'Terminal', terminal: true  },
      expired:   { id: 'expired',   label: 'Expired',    kind: 'expired',   category: 'Terminal', terminal: true  },
    },
    initial: 'open',
    transitions: {
      open:      ['assigned', 'canceled', 'expired'],
      assigned:  ['open', 'completed', 'canceled'],
      completed: [],
      canceled:  ['open'],
      expired:   ['open'],
    },
  },
};

/** Reason chips offered in the confirmation modal, keyed by *target* state. */
export const REASONS_BY_TARGET: Record<string, string[]> = {
  // Driver
  on_leave:   ['Medical', 'Personal / family', 'PTO', 'FMLA', 'Other'],
  suspended:  ['Safety violation', 'Compliance issue', 'Investigation pending', 'Other'],
  terminated: ['Voluntary resignation', 'Terminated for cause', 'End of contract', 'No-show / abandoned', 'Other'],
  retired:    ['Standard retirement', 'Medical retirement', 'Other'],
  // Truck / trailer
  maintenance:['Scheduled service', 'Repair — driveable', 'Repair — non-driveable', 'Inspection', 'Other'],
  ooo:        ['Major mechanical', 'Awaiting parts', 'Accident damage', 'DOT hold', 'Other'],
  sold:       ['Trade-in', 'Auction', 'Direct sale', 'Other'],
  totaled:    ['Accident — total loss', 'Insurance write-off', 'Other'],
  // Customer
  hold:       ['Past due > 30 days', 'Past due > 60 days', 'Credit limit exceeded', 'Disputed invoice', 'Other'],
  dormant:    ['No activity 90 days', 'No activity 180 days', 'Other'],
  do_not_use: ['Repeat non-payment', 'Fraud / chargeback', 'Hostile / unsafe', 'Other'],
  churned:    ['Lost to competitor', 'Out of business', 'Service not needed', 'Other'],
  // Carrier
  review:     ['Insurance verification', 'Annual recertification', 'Performance review', 'Other'],
  packet_exp: ['Insurance lapsed', 'W9 missing', 'MC authority lapsed', 'Other'],
  blocked:    ['Cargo damage / loss', 'Repeated late delivery', 'Fraud suspected', 'Other'],
  offboarded: ['Mutual termination', 'No longer needed', 'Other'],
  // Catch-all (re-activations, idle, reserved, etc.)
  idle:        ['Returned to yard', 'Awaiting next assignment', 'Other'],
  reserved:    ['Pre-booked load', 'Customer dedicated', 'Other'],
  in_service:  ['Returned from service', 'Repair complete', 'Cleared to operate', 'Other'],
  active:      ['Returned from leave', 'Reinstated', 'Reactivated', 'Other'],
  approved:    ['Cleared review', 'Packet renewed', 'Other'],
  prospect:    ['New lead', 'Referral', 'Other'],
  onboarding:  ['New hire', 'Re-hire', 'Other'],
};

/** Tone tokens for category headings and the confirmation-modal header band. */
export const CATEGORY_TONES: Record<StatusCategory, { fg: string; bg: string }> = {
  Active:   { fg: '#0F8C5F', bg: 'rgba(16,185,129,0.10)' },
  Paused:   { fg: '#A66800', bg: 'rgba(245,158,11,0.12)' },
  Terminal: { fg: '#B43030', bg: 'rgba(239,68,68,0.10)' },
};

/**
 * Legacy free-form values that don't directly match a machine label.
 * Resolved alongside label/id matching in `resolveStatusId`.
 */
const LEGACY_ALIASES: Record<StatusEntity, Record<string, string>> = {
  driver: {
    inactive: 'ooo', // legacy "Inactive" maps to Out of service
  },
  truck: {},
  trailer: {},
  customer: {},
  carrier: {},
  load: {
    delivered: 'completed', // design label maps to DB state
    cancelled: 'canceled',
  },
};

/**
 * Map a free-form `employmentStatus`/`status` string from the data layer
 * onto a state-machine ID. Returns the machine's `initial` if no match.
 */
export function resolveStatusId(entity: StatusEntity, raw: string | undefined | null): string {
  const machine = STATE_MACHINES[entity];
  if (!raw) return machine.initial;
  const trimmed = raw.trim().toLowerCase();
  for (const s of Object.values(machine.states)) {
    if (s.label.toLowerCase() === trimmed) return s.id;
    if (s.id.toLowerCase() === trimmed) return s.id;
  }
  const alias = LEGACY_ALIASES[entity][trimmed];
  if (alias) return alias;
  return machine.initial;
}
