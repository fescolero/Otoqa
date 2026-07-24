/**
 * Geospatial utilities shared across Convex modules.
 *
 * Extracted from driverMobile.ts so geofence evaluation, leg eligibility
 * checks, and check-in distance validation can all share the same math.
 */

/**
 * Great-circle distance between two GPS coordinates using the Haversine
 * formula. Returns meters.
 */
export function calculateDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Geofence ring thresholds for the driver-session geofence evaluator.
// OUTER_RING_METERS — first "approaching" event, ~5 miles.
// INNER_RING_METERS — arrival event, ~0.5 miles.
// DEPARTURE_RING_METERS — departure event, ~0.75 miles (1.5× the arrival
// ring). The exit fence is deliberately larger than the entry fence
// (hysteresis) so yard loops and GPS jitter near the boundary can't flap
// arrival/departure state — the standard pattern in freight-visibility
// platforms.
export const OUTER_RING_METERS = 8047;
export const INNER_RING_METERS = 804;
export const DEPARTURE_RING_METERS = 1207;

// Pings with horizontal accuracy worse than this are ignored for departure
// decisions. Mobile already drops fixes over 50 m before syncing; this is
// server-side defense in depth (rows without accuracy still count).
export const GEOFENCE_MAX_ACCURACY_METERS = 100;

// ---------------------------------------------------------------------------
// Check-in geofence decision
// ---------------------------------------------------------------------------

// Per-org behavior for the manual check-in distance validation, read from the
// `checkin_geofence_mode` feature flag. Values map as:
//   off  — no distance validation at all
//   soft — allow past the inner limit (recorded as an exception for dispatch),
//          refuse only beyond the outer ring
//   hard — refuse past the inner limit (legacy behavior)
export type CheckInGeofenceMode = 'off' | 'soft' | 'hard';

export const CHECKIN_GEOFENCE_FLAG_KEY = 'checkin_geofence_mode';
export const DEFAULT_CHECKIN_GEOFENCE_MODE: CheckInGeofenceMode = 'soft';

// The reported GPS fix accuracy widens the inner limit, but never by more
// than this — a wildly inaccurate fix shouldn't buy unlimited slack.
export const CHECKIN_ACCURACY_ALLOWANCE_CAP_METERS = 100;

export function parseCheckInGeofenceMode(raw: unknown): CheckInGeofenceMode {
  return raw === 'off' || raw === 'hard' || raw === 'soft'
    ? raw
    : DEFAULT_CHECKIN_GEOFENCE_MODE;
}

export interface CheckInDistanceVerdict {
  allowed: boolean;
  // True when the driver is past the inner limit but still allowed (soft
  // behavior) — persisted on the stop as a dispatch-visible exception.
  outsideGeofence: boolean;
  // The inner limit that applied (facility radius or arrival ring, plus
  // capped accuracy allowance).
  limitMeters: number;
  // True when the rejection is override-eligible: the anchor is a VERIFIED
  // facility pin, so the driver may consciously check in anyway (recorded
  // as an override that feeds the facility's demotion counter).
  canOverride: boolean;
}

export interface CheckInFacilityContext {
  verified: boolean;
  radiusMeters?: number;
  // Auto-demotion flag: too many recent overrides. A needs-review facility
  // is treated as soft until a human re-verifies the pin.
  needsReview?: boolean;
}

/**
 * Decide whether a manual check-in at `distanceMeters` from the stop pin is
 * allowed. Pure so tests can sweep the mode × distance × accuracy ×
 * facility matrix.
 *
 * The inner limit is the facility's radius when the stop is anchored to a
 * facility pin, else the arrival ring (INNER_RING_METERS, ~0.5 mi — the
 * same threshold the passive geofence evaluator uses to fire ARRIVED),
 * plus a capped allowance for the fix's reported accuracy.
 *
 * Hard blocking applies ONLY when the org opted in (`mode === 'hard'`) AND
 * the anchor is a VERIFIED, non-needs-review facility — a pin nobody
 * verified is exactly the thing that blocked drivers at real stops, so it
 * never hard-blocks. Every other validated case behaves softly: allowed
 * with an exception flag past the inner limit, refused only beyond
 * OUTER_RING_METERS (~5 mi), because check-in timestamps feed dwell and
 * duration pay and "checked in from another town" must stay impossible.
 */
export function evaluateCheckInDistance(params: {
  mode: CheckInGeofenceMode;
  distanceMeters: number;
  accuracyMeters?: number;
  facility?: CheckInFacilityContext;
}): CheckInDistanceVerdict {
  const { mode, distanceMeters, facility } = params;
  const accuracy =
    typeof params.accuracyMeters === 'number' && params.accuracyMeters > 0
      ? Math.min(params.accuracyMeters, CHECKIN_ACCURACY_ALLOWANCE_CAP_METERS)
      : 0;
  const baseLimit =
    facility?.radiusMeters && facility.radiusMeters > 0
      ? facility.radiusMeters
      : INNER_RING_METERS;
  const limitMeters = baseLimit + accuracy;

  if (mode === 'off') {
    return { allowed: true, outsideGeofence: false, limitMeters, canOverride: false };
  }

  const outside = distanceMeters > limitMeters;
  const hardEligible = facility?.verified === true && facility.needsReview !== true;

  if (mode === 'hard' && hardEligible) {
    return {
      allowed: !outside,
      outsideGeofence: outside,
      limitMeters,
      canOverride: outside,
    };
  }

  // Soft behavior (mode 'soft', or 'hard' without a verified anchor).
  return {
    allowed: distanceMeters <= OUTER_RING_METERS,
    outsideGeofence: outside,
    limitMeters,
    canOverride: false,
  };
}
