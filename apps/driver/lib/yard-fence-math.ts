/**
 * yard-fence-math.ts — the geometry half of the yard fence cache, kept free
 * of React Native and Convex imports so it can be unit-tested in node.
 *
 * Deliberately dumb: no I/O, no storage, no clock. Everything that can be
 * wrong about a fence decision — the hysteresis band, which fence wins when
 * two overlap — is in here where a test can reach it.
 *
 * See docs/end-shift-reminder-spec.md.
 */

export type YardFence = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** Crossing inward past this is "inside the yard". */
  entryRadiusMeters: number;
  /** Crossing outward past this is "left the yard". Wider — hysteresis. */
  exitRadiusMeters: number;
};

/**
 * Where a fix sits relative to a fence.
 *
 *   inside  — past the entry ring
 *   outside — past the (wider) exit ring
 *   between — in the hysteresis band, which means "unchanged, whatever it
 *             was". Yard loops and GPS jitter live here, and treating the
 *             band as a state of its own is what stops them flapping.
 *
 * Mirrors convex/yardGeofence.ts exactly. If one side changes, both do.
 */
export type FenceZone = 'inside' | 'between' | 'outside';

/** Great-circle distance in meters. */
export function distanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Which zone a fix falls in for one fence. */
export function zoneFor(
  fence: YardFence,
  latitude: number,
  longitude: number,
): FenceZone {
  const d = distanceMeters(latitude, longitude, fence.latitude, fence.longitude);
  if (d < fence.entryRadiusMeters) return 'inside';
  if (d > fence.exitRadiusMeters) return 'outside';
  return 'between';
}

/**
 * The fence a point sits inside, or null.
 *
 * Nearest wins when fences overlap, so the answer doesn't depend on row
 * order the way the server evaluator's does. That matters here because this
 * decides which yard an entire shift is anchored to — the same fix must
 * resolve to the same yard on every call, including after a refresh
 * reorders the list.
 */
export function findEnclosingFence(
  fences: YardFence[],
  latitude: number,
  longitude: number,
): YardFence | null {
  let best: YardFence | null = null;
  let bestDistance = Infinity;
  for (const fence of fences) {
    const d = distanceMeters(latitude, longitude, fence.latitude, fence.longitude);
    if (d < fence.entryRadiusMeters && d < bestDistance) {
      best = fence;
      bestDistance = d;
    }
  }
  return best;
}
