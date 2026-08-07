import { calculateDistanceMeters, INNER_RING_METERS } from './geo';

/**
 * Polygon geofences — pure geometry over lat/lng vertex lists.
 *
 * A facility's learned polygon is the convex hull of its trimmed visit
 * fixes, buffered outward — the fence hugs the yard's actual shape instead
 * of circumscribing it with a circle (the Geotab-zone upgrade path). All
 * math happens in a local equirectangular projection around the shape's
 * centroid: at facility scale (≤ ~1 mile) the distortion is negligible.
 *
 * Vertices are stored in order (closed implicitly: last connects to first).
 * Shared by the evaluator (point-in-polygon), the refinement cron (hull
 * building), and the web map (rendering) — keep it dependency-free.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const METERS_PER_DEG_LAT = 111_320;

function project(points: LatLng[], ref: LatLng): { x: number; y: number }[] {
  const mLng = METERS_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
  return points.map((p) => ({
    x: (p.lng - ref.lng) * mLng,
    y: (p.lat - ref.lat) * METERS_PER_DEG_LAT,
  }));
}

function unproject(points: { x: number; y: number }[], ref: LatLng): LatLng[] {
  const mLng = METERS_PER_DEG_LAT * Math.cos((ref.lat * Math.PI) / 180);
  return points.map((p) => ({
    lat: ref.lat + p.y / METERS_PER_DEG_LAT,
    lng: ref.lng + p.x / mLng,
  }));
}

function centroidOf(points: LatLng[]): LatLng {
  return {
    lat: points.reduce((s, p) => s + p.lat, 0) / points.length,
    lng: points.reduce((s, p) => s + p.lng, 0) / points.length,
  };
}

/** Convex hull (Andrew's monotone chain), returned counter-clockwise. */
export function convexHull(points: LatLng[]): LatLng[] {
  if (points.length < 3) return [...points];
  const ref = centroidOf(points);
  const pts = project(points, ref)
    .map((p, i) => ({ ...p, i }))
    .sort((a, b) => a.x - b.x || a.y - b.y);

  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: typeof pts = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: typeof pts = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return unproject(hull, ref);
}

/**
 * Expand a convex polygon outward by ~`meters`: each vertex moves away
 * from the centroid along its radial. Exact Minkowski buffering is
 * unnecessary at fence scale — the radial push under-buffers flat edges by
 * at most (1 − cos θ/2) of the margin, well inside GPS noise for hulls of
 * our vertex counts.
 */
export function expandPolygon(polygon: LatLng[], meters: number): LatLng[] {
  if (polygon.length < 3 || meters === 0) return [...polygon];
  const ref = centroidOf(polygon);
  const projected = project(polygon, ref);
  const expanded = projected.map((p) => {
    const len = Math.hypot(p.x, p.y);
    if (len === 0) return p;
    const scale = (len + meters) / len;
    return { x: p.x * scale, y: p.y * scale };
  });
  return unproject(expanded, ref);
}

/** Ray-casting point-in-polygon (vertices in order, closed implicitly). */
export function pointInPolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  const ref = centroidOf(polygon);
  const [pt] = project([point], ref);
  const poly = project(polygon, ref);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Facility fence construction ─────────────────────────────────────────

/** Evidence bar for a polygon: needs more signal than a circle. */
export const POLYGON_MIN_FIXES = 10;
export const POLYGON_MIN_DISTINCT_DAYS = 4;
/** Below this hull extent a circle is just as good — don't store a polygon. */
export const POLYGON_MIN_EXTENT_METERS = 60;
const POLYGON_MAX_VERTICES = 16;

/**
 * Build a facility fence polygon from visit fixes: drop outliers beyond
 * `trimDistanceMeters` of the median center, hull the rest, buffer by
 * `marginMeters`, decimate to ≤16 vertices. Returns null when the data
 * doesn't justify a polygon (thin, degenerate/collinear, or so tight a
 * circle serves equally well) — callers fall back to the radius fence.
 */
export function buildFencePolygon(
  fixes: LatLng[],
  center: LatLng,
  trimDistanceMeters: number,
  marginMeters: number,
): LatLng[] | null {
  const trimmed = fixes.filter(
    (p) =>
      calculateDistanceMeters(p.lat, p.lng, center.lat, center.lng) <=
      Math.min(trimDistanceMeters, INNER_RING_METERS),
  );
  if (trimmed.length < POLYGON_MIN_FIXES) return null;

  let hull = convexHull(trimmed);
  if (hull.length < 3) return null; // degenerate/collinear

  const hullCenter = centroidOf(hull);
  const extent = Math.max(
    ...hull.map((p) => calculateDistanceMeters(p.lat, p.lng, hullCenter.lat, hullCenter.lng)),
  );
  if (extent < POLYGON_MIN_EXTENT_METERS) return null;

  if (hull.length > POLYGON_MAX_VERTICES) {
    const step = hull.length / POLYGON_MAX_VERTICES;
    hull = Array.from({ length: POLYGON_MAX_VERTICES }, (_, i) => hull[Math.floor(i * step)]);
  }
  return expandPolygon(hull, marginMeters);
}
