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
export function calculateDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Geofence ring thresholds for the driver-session geofence evaluator.
// OUTER_RING_METERS — first "approaching" event, ~5 miles.
// INNER_RING_METERS — arrival event, ~0.5 miles.
export const OUTER_RING_METERS = 8047;
export const INNER_RING_METERS = 804;
