/**
 * Shared types for the Active Sessions live ops page.
 *
 * `LiveSessionRow` mirrors the row shape returned by
 * `convex/sessionsLiveOps.ts::listLiveSessions`. Kept in this client-side
 * file so components don't need to import from Convex internals.
 */

import type { Id } from '@/convex/_generated/dataModel';

export type DerivedStatus = 'driving' | 'idle' | 'break' | 'off-duty';

export type TripLegStatus = 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';

/**
 * One dispatch leg within a session — the "trip card" unit in the panel.
 * Mirrors `TripInfo` from `convex/sessionsLiveOps.ts`. Stops carry just
 * enough denormalized labels (reference name / city / state) to render
 * the card without an extra client query.
 */
export interface TripInfo {
  legId: Id<'dispatchLegs'>;
  loadId: Id<'loadInformation'>;
  loadInternalId: string;
  /** Customer-facing order number — preferred display id over internalId
   *  (which carries source prefixes like "FK-"). */
  orderNumber: string | null;
  /** HCR + Trip facet tags — same loadTags source the schedule Gantt uses. */
  hcr: string | null;
  tripNumber: string | null;
  sequence: number;
  status: TripLegStatus;

  startedAt: number | null;
  endedAt: number | null;
  plannedStartAt: number | null;

  startStop: TripStop | null;
  endStop: TripStop | null;
}

export interface TripStop {
  sequence: number;
  type: 'PICKUP' | 'DELIVERY' | 'DETOUR';
  referenceName: string | null;
  city: string | null;
  state: string | null;
}

export interface LiveSessionRow {
  sessionId: Id<'driverSessions'>;
  driverId: Id<'drivers'>;
  driverName: string;
  truckId: Id<'trucks'>;
  truckUnitId: string | null;
  truckMakeModel: string | null;
  truckPlate: string | null;

  startedAt: number;
  softCap10hAt?: number;
  softCap14hAt?: number;

  status: DerivedStatus;
  statusLoc: string;

  latestLocation: {
    latitude: number;
    longitude: number;
    speed?: number;
    heading?: number;
    recordedAt: number;
  } | null;

  /** First GPS ping of the shift — the "shift start" anchor. The map
   *  renders a green pin here when the driver is selected. */
  startLocation: {
    latitude: number;
    longitude: number;
    recordedAt: number;
  } | null;

  trips: TripInfo[];
  incidents: number;
}

/**
 * Past-day session row — same shape ideas as `LiveSessionRow` but skewed
 * toward "what was this shift" instead of "where is this driver right now".
 * Matches `PastSessionRow` from `convex/sessionsLiveOps.ts`.
 */
export interface PastSessionRow {
  sessionId: Id<'driverSessions'>;
  driverId: Id<'drivers'>;
  driverName: string;
  truckId: Id<'trucks'>;
  truckUnitId: string | null;
  truckMakeModel: string | null;
  truckPlate: string | null;

  startedAt: number;
  endedAt: number | null;
  activeMs: number;

  startLocation: { latitude: number; longitude: number } | null;
  endLocation: { latitude: number; longitude: number } | null;

  distanceKm: number;
  pingCount: number;
  incidents: number;
  trips: TripInfo[];
}

export interface RecentPing {
  id: Id<'driverLocations'>;
  recordedAt: number;
  latitude: number;
  longitude: number;
  speed: number;
  heading?: number;
  loadId: Id<'loadInformation'> | null;
  trackingType: string;
}

/** Map a `DerivedStatus` to the tone used across pins, chips, and dots. */
export const STATUS_TONE: Record<DerivedStatus, { color: string; label: string }> = {
  driving:    { color: '#22B07D', label: 'Driving' },
  idle:       { color: '#A47BD0', label: 'Idle' },
  break:      { color: '#F59E0B', label: 'On break' },
  'off-duty': { color: '#9BA3B4', label: 'Off-duty' },
};

/**
 * Trip palette — distinct colors for each leg of a shift, mirroring the
 * design's `tr-1: blue, tr-2: green, tr-3: orange, ...` palette. Used by
 * both the panel's trip cards and the map polyline so a dispatcher can
 * eye-trace "the orange segment is Trip 3".
 */
export const TRIP_PALETTE = [
  '#2E5CFF', // blue
  '#22B07D', // green
  '#F59E0B', // amber
  '#A47BD0', // purple
  '#EF4444', // red
  '#06B6D4', // cyan
  '#EC4899', // pink
  '#8B5CF6', // violet
];

/** Color for one trip card / polyline segment. Canceled legs render
 *  neutral so the active palette stays meaningful. */
export function toneForTrip(trip: TripInfo, index: number): string {
  if (trip.status === 'CANCELED') return '#9BA3B4';
  return TRIP_PALETTE[index % TRIP_PALETTE.length];
}

/** Deterministic palette for driver avatars — keyed off driverId so the same
 * driver gets the same color across renders, even before we have a stored
 * `avatarColor` column. Mirrors the design's FLEET_PALETTE. */
const AVATAR_PALETTE = [
  '#2E5CFF', '#22B07D', '#F59E0B', '#A47BD0', '#EF4444',
  '#FB923C', '#06B6D4', '#EC4899', '#8B5CF6', '#10B981',
];

export function avatarColorForId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function initialsForName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((n) => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}
