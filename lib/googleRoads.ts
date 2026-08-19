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

/**
 * A snapped point tagged with the index of the INPUT point it belongs to.
 * `interpolate=true` returns extra densified points that have no
 * `originalIndex` of their own; those inherit the index of the last real
 * point before them, so every returned point can be attributed back to a
 * span of the input path. Callers use this to slice one snapped path back
 * into the several display segments it covers.
 */
export type IndexedSnapPoint = RawPoint & { originalIndex: number };

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
const CACHE = new Map<string, IndexedSnapPoint[]>();

// ── Circuit breaker ──────────────────────────────────────────────────
// Roads bills per REQUEST, including requests that come back unusable.
// A misconfigured endpoint once burned 4,380 billable calls across three
// days precisely because every failure fell back to the raw polyline and
// the map still looked fine. After a few consecutive failures we stop
// calling for the rest of the page session — the fallback render is
// identical, so the only thing lost is money.
const MAX_CONSECUTIVE_FAILURES = 3;
let consecutiveFailures = 0;
let trippedOut = false;

function noteFailure(reason: string): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !trippedOut) {
    trippedOut = true;
    console.warn(
      `[snapToRoads] disabled for this page session after ` +
        `${consecutiveFailures} consecutive failures (last: ${reason}). ` +
        `Polylines will render unsnapped.`,
    );
  }
}

/** Whether the breaker has tripped. Exposed for diagnostics/tests. */
export function isRoadsSnappingDisabled(): boolean {
  return trippedOut;
}

/** Test seam — resets breaker + cache. */
export function resetRoadsSnappingState(): void {
  consecutiveFailures = 0;
  trippedOut = false;
  CACHE.clear();
}

// A path that never leaves a ~25 m box is a parked truck, not a route.
// Snapping it returns a single road-centre dot: visually identical to the
// raw pings, one billable request each time. Skip those.
const MIN_SPAN_METERS = 25;

function spanMeters(points: RawPoint[]): number {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.latitude < minLat) minLat = p.latitude;
    if (p.latitude > maxLat) maxLat = p.latitude;
    if (p.longitude < minLng) minLng = p.longitude;
    if (p.longitude > maxLng) maxLng = p.longitude;
  }
  const latM = (maxLat - minLat) * 111_320;
  const lngM =
    (maxLng - minLng) *
    111_320 *
    Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  return Math.hypot(latM, lngM);
}

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
  const snapped = await snapPathToRoadsIndexed(points, apiKey);
  return snapped ?? points;
}

/**
 * Same call as `snapPathToRoads`, but every returned point carries the
 * index of the input point it belongs to. Returns `null` — rather than
 * echoing the input — when nothing was snapped, so callers can tell
 * "unchanged because it failed" from "this really is the road geometry".
 *
 * Snap the LONGEST continuous path you can in one go. Roads bills per
 * request (100 points max), so one 100-point call costs exactly what a
 * 2-point call costs. Splitting a continuous route into one call per
 * colour change is the single most expensive thing you can do with this
 * API — a 5,555-ping shift split that way costs 1,269 requests instead
 * of 57. The `originalIndex` on the result is what lets the caller paint
 * per-leg colours without paying per leg.
 *
 * Do NOT concatenate across a genuine positional break (an outlier jump):
 * Roads would happily route through the gap and draw a fabricated
 * highway across it.
 */
export async function snapPathToRoadsIndexed(
  points: RawPoint[],
  apiKey: string | undefined
): Promise<IndexedSnapPoint[] | null> {
  if (trippedOut) return null;
  if (!apiKey) return null;
  if (points.length < 2) return null;

  const cacheKey = fingerprint(points);
  const cached = CACHE.get(cacheKey);
  if (cached) return cached;

  // Parked truck — nothing to snap, don't pay for the answer.
  if (spanMeters(points) < MIN_SPAN_METERS) return null;

  try {
    // Chunks overlap by one point: each chunk starts on the previous
    // chunk's last point so the road geometry is continuous across the
    // boundary. The stitch below drops the duplicated point when joining.
    const chunks: RawPoint[][] = [];
    for (let i = 0; i < points.length - 1; i += MAX_POINTS_PER_CALL - 1) {
      chunks.push(points.slice(i, i + MAX_POINTS_PER_CALL));
    }

    const snapped: IndexedSnapPoint[] = [];
    for (let c = 0; c < chunks.length; c++) {
      const chunk = chunks[c];
      // Where this chunk starts within `points`, so the per-chunk
      // originalIndex values Roads returns can be rebased to the caller's
      // own indices.
      const chunkStart = c * (MAX_POINTS_PER_CALL - 1);
      const pathParam = chunk
        .map((p) => `${p.latitude},${p.longitude}`)
        .join('|');
      const url =
        `${SNAP_TO_ROADS_URL}?interpolate=true` +
        `&path=${encodeURIComponent(pathParam)}` +
        `&key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url);
      if (!resp.ok) {
        // 403 = API not enabled. 400 = malformed path. 404 = wrong
        // endpoint. Either way, bail out and let the caller fall back to
        // the raw polyline — and count it against the breaker so a
        // systematic misconfiguration can't bill indefinitely.
        noteFailure(`HTTP ${resp.status}`);
        console.warn(
          `[snapToRoads] HTTP ${resp.status} — falling back to raw path`,
        );
        return null;
      }
      const data: SnapResponse = await resp.json();
      if (data.error) {
        noteFailure(data.error.message ?? 'unknown');
        console.warn(
          `[snapToRoads] error: ${data.error.message ?? 'unknown'}`,
        );
        return null;
      }
      consecutiveFailures = 0;

      // Interpolated points carry no originalIndex — they belong to the
      // span following the last real point, so we carry `owner` forward.
      let owner = chunkStart;
      const segment = data.snappedPoints ?? [];
      for (let k = 0; k < segment.length; k++) {
        const s = segment[k];
        if (s.originalIndex !== undefined) owner = chunkStart + s.originalIndex;
        // Chunks overlap by one input point; drop the duplicate that the
        // previous chunk already contributed.
        if (c > 0 && k === 0) continue;
        snapped.push({
          latitude: s.location.latitude,
          longitude: s.location.longitude,
          originalIndex: owner,
        });
      }
    }

    if (snapped.length < 2) return null;
    CACHE.set(cacheKey, snapped);
    return snapped;
  } catch (err) {
    noteFailure('network/parse');
    console.warn('[snapToRoads] network/parse error — falling back', err);
    return null;
  }
}
