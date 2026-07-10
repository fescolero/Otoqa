/**
 * Lightweight client for the Google Maps Roads API `snapToRoads` endpoint.
 *
 * The Active Sessions live ops page uses this to turn sparse GPS pings
 * into polylines that follow the road network instead of cutting straight
 * lines through hills/water. Without it the polyline is "geodesic chords
 * between consecutive pings", which at the 4-minute ping cadence reads
 * as starbursts radiating from depots.
 *
 * Notes / caveats:
 *   • The Roads API is a SEPARATE Google Maps SKU from Maps JavaScript.
 *     It must be enabled in the same GCP project as `GOOGLE_MAPS_API_KEY`.
 *     If not enabled, the REST call returns 403 — `snapPathToRoads`
 *     catches that and returns the raw input (caller falls back to the
 *     unsnapped polyline).
 *   • Hard limit: 100 points per call. We chunk longer paths and stitch
 *     the responses back together.
 *   • `interpolate=true` returns extra densified points along snapped
 *     road geometry, which gives the smooth curving line that makes the
 *     polyline read as a real route instead of stair-stepped chords.
 */

const SNAP_TO_ROADS_URL = 'https://roads.googleapis.com/v1/snapToRoads';
const MAX_POINTS_PER_CALL = 100;

interface RawPoint {
  latitude: number;
  longitude: number;
}

type SnapResponse = {
  snappedPoints?: Array<{
    location: { latitude: number; longitude: number };
    originalIndex?: number;
    placeId?: string;
  }>;
  error?: { code?: number; message?: string };
};

// Module-level cache keyed on a stable fingerprint of the input path.
// Roads API charges per call; a session that re-renders the map should
// not re-pay. Cleared implicitly when the user reloads the page.
const CACHE = new Map<string, RawPoint[]>();

function fingerprint(points: RawPoint[]): string {
  // Coarse fingerprint: 4-decimal lat/lon (≈11m precision). Two paths
  // that differ only by sub-meter GPS jitter share a cache entry.
  return points
    .map((p) => `${p.latitude.toFixed(4)},${p.longitude.toFixed(4)}`)
    .join('|');
}

/**
 * Snap a chronological GPS path to the road network. Returns a path
 * with the same start/end semantics but more (interpolated) points and
 * coordinates that ride the road centerlines. Returns the input path
 * verbatim if the API call fails or the key is missing.
 *
 * The `apiKey` arg is the same one used by `useGoogleMapsKey()` — we
 * read it from the caller so this module doesn't need a React context.
 */
export async function snapPathToRoads(
  points: RawPoint[],
  apiKey: string | undefined
): Promise<RawPoint[]> {
  if (!apiKey) return points;
  if (points.length < 2) return points;

  const cacheKey = fingerprint(points);
  const cached = CACHE.get(cacheKey);
  if (cached) return cached;

  try {
    const chunks: RawPoint[][] = [];
    for (let i = 0; i < points.length; i += MAX_POINTS_PER_CALL) {
      chunks.push(points.slice(i, i + MAX_POINTS_PER_CALL));
    }

    const snapped: RawPoint[] = [];
    for (const chunk of chunks) {
      const pathParam = chunk
        .map((p) => `${p.latitude},${p.longitude}`)
        .join('|');
      const url =
        `${SNAP_TO_ROADS_URL}?interpolate=true` +
        `&path=${encodeURIComponent(pathParam)}` +
        `&key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        // 403 = API not enabled. 400 = malformed path. Either way, bail
        // out and let the caller fall back to the raw polyline.
        console.warn(
          `[snapToRoads] HTTP ${resp.status} — falling back to raw path`,
        );
        return points;
      }
      const data: SnapResponse = await resp.json();
      if (data.error) {
        console.warn(
          `[snapToRoads] error: ${data.error.message ?? 'unknown'}`,
        );
        return points;
      }
      const segment = (data.snappedPoints ?? []).map((s) => ({
        latitude: s.location.latitude,
        longitude: s.location.longitude,
      }));
      // Stitch chunk results: drop the chunk's first snapped point if
      // it's adjacent to the previous chunk's last (the input chunks
      // overlap by one to keep continuity at chunk boundaries).
      if (snapped.length > 0 && segment.length > 0) {
        snapped.push(...segment.slice(1));
      } else {
        snapped.push(...segment);
      }
    }

    if (snapped.length < 2) return points;
    CACHE.set(cacheKey, snapped);
    return snapped;
  } catch (err) {
    console.warn('[snapToRoads] network/parse error — falling back', err);
    return points;
  }
}
