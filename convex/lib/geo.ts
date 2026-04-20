/**
 * Geospatial utilities for distance calculations and geofence evaluation.
 * Shared across driverMobile, geofenceEvaluator, and other modules.
 */

// ============================================
// GEOFENCE RING DISTANCES
// ============================================

/** Outer ring distance in meters (5 miles) — triggers APPROACHING events */
export const OUTER_RING_METERS = 8047;

/** Inner ring distance in meters (0.5 miles) — triggers ARRIVED events */
export const INNER_RING_METERS = 804;

// ============================================
// DEFAULT RADIUS BY LOCATION TYPE
// ============================================

export const DEFAULT_RADIUS_BY_TYPE: Record<string, number> = {
  Yard: 500,
  'Paid Parking': 300,
  Terminal: 800,
  Warehouse: 500,
  'Distribution Center': 800,
  'Customer Site': 500,
};

/** Min/max radius for user-adjustable slider */
export const MIN_RADIUS_METERS = 300;
export const MAX_RADIUS_METERS = 2000;

// ============================================
// HAVERSINE DISTANCE
// ============================================

/**
 * Calculate distance between two GPS coordinates using Haversine formula.
 * Returns distance in meters.
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

/**
 * Quick bounding-box pre-filter to avoid expensive Haversine calculations.
 * Returns true if the point is within roughly `radiusMeters` of the center.
 * False positives are possible (corners of the box), false negatives are not.
 */
export function isWithinBoundingBox(
  pointLat: number,
  pointLng: number,
  centerLat: number,
  centerLng: number,
  radiusMeters: number
): boolean {
  // ~111,320 meters per degree of latitude
  const latDelta = radiusMeters / 111320;
  // Longitude degrees vary by latitude
  const lngDelta = radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180));

  return (
    pointLat >= centerLat - latDelta &&
    pointLat <= centerLat + latDelta &&
    pointLng >= centerLng - lngDelta &&
    pointLng <= centerLng + lngDelta
  );
}
