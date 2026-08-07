import { describe, it, expect } from 'vitest';
import {
  convexHull,
  expandPolygon,
  pointInPolygon,
  buildFencePolygon,
  POLYGON_MIN_FIXES,
} from './polygonGeo';

// ~0.001° lat ≈ 111m. A rectangle ~222m (lat) × ~170m (lng) at this latitude.
const RECT = [
  { lat: 40.0, lng: -111.0 },
  { lat: 40.002, lng: -111.0 },
  { lat: 40.002, lng: -111.002 },
  { lat: 40.0, lng: -111.002 },
];
const CENTER = { lat: 40.001, lng: -111.001 };

describe('convexHull', () => {
  it('hulls a point cloud down to its corners', () => {
    const interior = Array.from({ length: 20 }, (_, i) => ({
      lat: 40.0005 + (i % 5) * 0.0002,
      lng: -111.0015 + (i % 4) * 0.0003,
    }));
    const hull = convexHull([...RECT, ...interior]);
    expect(hull.length).toBeGreaterThanOrEqual(4);
    // Every rectangle corner survives as a hull vertex.
    for (const corner of RECT) {
      expect(
        hull.some((v) => Math.abs(v.lat - corner.lat) < 1e-9 && Math.abs(v.lng - corner.lng) < 1e-9),
      ).toBe(true);
    }
    // No interior point survives.
    expect(hull.length).toBeLessThanOrEqual(8);
  });
});

describe('pointInPolygon', () => {
  it('classifies inside, outside, and respects the shape (not a circle)', () => {
    expect(pointInPolygon(CENTER, RECT)).toBe(true);
    expect(pointInPolygon({ lat: 40.0019, lng: -111.0001 }, RECT)).toBe(true); // near a corner
    expect(pointInPolygon({ lat: 40.003, lng: -111.001 }, RECT)).toBe(false); // beyond the top edge
    // A point diagonal to the corner: inside a circumscribing circle,
    // outside the rectangle — the polygon must say OUTSIDE.
    expect(pointInPolygon({ lat: 40.0025, lng: -111.0025 }, RECT)).toBe(false);
  });

  it('returns false for degenerate polygons', () => {
    expect(pointInPolygon(CENTER, RECT.slice(0, 2))).toBe(false);
  });
});

describe('expandPolygon', () => {
  it('pushes every vertex outward by ~the margin', () => {
    const expanded = expandPolygon(RECT, 100);
    // Top edge moves north: max lat grows by roughly 100m ≈ 0.0009°.
    const maxLat = Math.max(...expanded.map((v) => v.lat));
    expect(maxLat).toBeGreaterThan(40.0025);
    expect(maxLat).toBeLessThan(40.0035);
    // Everything inside the original stays inside the expansion.
    expect(pointInPolygon(CENTER, expanded)).toBe(true);
    expect(pointInPolygon({ lat: 40.002, lng: -111.0 }, expanded)).toBe(true);
  });
});

describe('buildFencePolygon', () => {
  const spread = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      lat: 40.0 + (i % 4) * 0.0007,
      lng: -111.0 - (i % 3) * 0.0007,
    }));

  it('builds a buffered hull from enough spread fixes', () => {
    const fixes = spread(16);
    const polygon = buildFencePolygon(fixes, { lat: 40.001, lng: -111.0007 }, 500, 100)!;
    expect(polygon).not.toBeNull();
    expect(polygon.length).toBeGreaterThanOrEqual(3);
    expect(polygon.length).toBeLessThanOrEqual(16);
    // Every original fix ends up inside the buffered fence.
    for (const f of fixes) {
      expect(pointInPolygon(f, polygon)).toBe(true);
    }
  });

  it('refuses thin data, collinear clusters, and tight clusters', () => {
    expect(buildFencePolygon(spread(POLYGON_MIN_FIXES - 1), CENTER, 500, 100)).toBeNull();
    const collinear = Array.from({ length: 12 }, (_, i) => ({
      lat: 40.0 + i * 0.0004,
      lng: -111.0,
    }));
    expect(buildFencePolygon(collinear, { lat: 40.002, lng: -111.0 }, 800, 100)).toBeNull();
    // Tight cluster (< POLYGON_MIN_EXTENT): a circle serves — no polygon.
    const tight = Array.from({ length: 12 }, (_, i) => ({
      lat: 40.0 + (i % 3) * 0.0002,
      lng: -111.0 + ((i + 1) % 3) * 0.0002,
    }));
    expect(buildFencePolygon(tight, { lat: 40.0002, lng: -110.9998 }, 500, 100)).toBeNull();
  });

  it('drops outliers beyond the trim distance before hulling', () => {
    const fixes = [...spread(14), { lat: 40.05, lng: -111.0 }]; // ~5.5km outlier
    const polygon = buildFencePolygon(fixes, { lat: 40.001, lng: -111.0007 }, 500, 100)!;
    expect(polygon).not.toBeNull();
    expect(pointInPolygon({ lat: 40.05, lng: -111.0 }, polygon)).toBe(false);
  });
});
