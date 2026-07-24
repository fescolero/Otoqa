import { describe, it, expect } from 'vitest';
import {
  computeFacilityEvidence,
  EVIDENCE_MAX_SPREAD_METERS,
  EVIDENCE_MIN_CHECKINS,
} from './facilityEvidence';
import { INNER_RING_METERS } from './geo';

// ~111km per degree of latitude; 0.0005° ≈ 55m.
const BASE = { latitude: 41.7354, longitude: -122.6345 };

function cluster(count: number, days: number, jitterDeg = 0.0003) {
  // Deterministic tight cluster: alternate small offsets, cycle day keys.
  return Array.from({ length: count }, (_, i) => ({
    latitude: BASE.latitude + ((i % 3) - 1) * jitterDeg,
    longitude: BASE.longitude + (((i + 1) % 3) - 1) * jitterDeg,
    dayKey: `2026-07-${String((i % days) + 1).padStart(2, '0')}`,
  }));
}

describe('computeFacilityEvidence', () => {
  it('returns null with no usable points', () => {
    expect(computeFacilityEvidence([])).toBeNull();
    expect(computeFacilityEvidence([{ latitude: NaN, longitude: 1 }])).toBeNull();
  });

  it('qualifies a tight multi-day cluster and suggests a sane radius', () => {
    const e = computeFacilityEvidence(cluster(8, 4))!;
    expect(e.count).toBe(8);
    expect(e.distinctDays).toBe(4);
    expect(e.spreadMeters).toBeLessThanOrEqual(EVIDENCE_MAX_SPREAD_METERS);
    expect(e.qualifies).toBe(true);
    expect(e.suggestedRadiusMeters).toBeGreaterThanOrEqual(150);
    expect(e.suggestedRadiusMeters).toBeLessThanOrEqual(INNER_RING_METERS);
    // Median lands inside the cluster.
    expect(Math.abs(e.medianLatitude - BASE.latitude)).toBeLessThan(0.001);
  });

  it('does not qualify with too few check-ins', () => {
    const e = computeFacilityEvidence(cluster(EVIDENCE_MIN_CHECKINS - 1, 3))!;
    expect(e.qualifies).toBe(false);
  });

  it('does not qualify with too few distinct days', () => {
    const e = computeFacilityEvidence(cluster(8, 2))!;
    expect(e.distinctDays).toBe(2);
    expect(e.qualifies).toBe(false);
  });

  it('does not qualify a scattered cluster', () => {
    const scattered = cluster(8, 4, 0.01); // ~1.1km jitter
    const e = computeFacilityEvidence(scattered)!;
    expect(e.spreadMeters).toBeGreaterThan(EVIDENCE_MAX_SPREAD_METERS);
    expect(e.qualifies).toBe(false);
  });

  it('median resists a single wild outlier', () => {
    const points = [...cluster(9, 4), { latitude: 45.0, longitude: -110.0, dayKey: '2026-07-09' }];
    const e = computeFacilityEvidence(points)!;
    // The outlier blows the spread (so it can't qualify) but not the pin.
    expect(Math.abs(e.medianLatitude - BASE.latitude)).toBeLessThan(0.001);
    expect(Math.abs(e.medianLongitude - BASE.longitude)).toBeLessThan(0.001);
    expect(e.qualifies).toBe(false);
  });
});
