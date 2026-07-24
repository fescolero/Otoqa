/**
 * Facility verification evidence — pure math over the ground-truth
 * coordinates drivers already produce: every successful check-in/checkout
 * stamps its GPS fix onto the stop (checkinLatitude/…, checkoutLatitude/…).
 *
 * The cluster of those fixes at a facility is where trucks actually stop —
 * better than any geocode. This module reduces the points to a suggested
 * pin (component-wise median — a single bad fix can't drag it) and a
 * spread, and decides whether the evidence is strong enough to SUGGEST
 * verification. Humans still click Verify — see the manual-only decision
 * in docs/fourkites-address-quality-plan.md.
 *
 * Callers must pre-filter the points: overridden (checkinOverride) and
 * redirected (isRedirected) stops are excluded upstream so a wrong pin's
 * own workaround check-ins can't re-verify the wrong location.
 */
import { calculateDistanceMeters, INNER_RING_METERS } from './geo';

// Evidence bar for suggesting verification (plan §6, tunable).
export const EVIDENCE_MIN_CHECKINS = 5;
export const EVIDENCE_MIN_DISTINCT_DAYS = 3;
export const EVIDENCE_MAX_SPREAD_METERS = 150;

// Auto-demotion: this many driver overrides within the window flags the
// facility needsReview — its pin stops hard-blocking until a human
// re-verifies it. Overrides are themselves the signal a verified pin is
// wrong, so the system stops trusting it from exactly the data the
// failure produces.
export const OVERRIDE_DEMOTION_THRESHOLD = 3;
export const OVERRIDE_DEMOTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Suggested radius = observed spread + margin, floored so a tight cluster
// doesn't produce an unusably small fence, capped at the arrival ring.
const SUGGESTED_RADIUS_MARGIN_METERS = 100;
const SUGGESTED_RADIUS_MIN_METERS = 150;

export interface EvidencePoint {
  latitude: number;
  longitude: number;
  /** Calendar day of the fix (e.g. "2026-07-23") for distinct-day counting. */
  dayKey?: string;
}

export interface FacilityEvidence {
  count: number;
  distinctDays: number;
  medianLatitude: number;
  medianLongitude: number;
  /** Max distance from the median point across all points (meters). */
  spreadMeters: number;
  qualifies: boolean;
  suggestedRadiusMeters: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeFacilityEvidence(points: EvidencePoint[]): FacilityEvidence | null {
  const valid = points.filter(
    (p) =>
      typeof p.latitude === 'number' &&
      Number.isFinite(p.latitude) &&
      typeof p.longitude === 'number' &&
      Number.isFinite(p.longitude),
  );
  if (valid.length === 0) return null;

  const medianLatitude = median(valid.map((p) => p.latitude));
  const medianLongitude = median(valid.map((p) => p.longitude));

  let spreadMeters = 0;
  for (const p of valid) {
    const d = calculateDistanceMeters(p.latitude, p.longitude, medianLatitude, medianLongitude);
    if (d > spreadMeters) spreadMeters = d;
  }
  spreadMeters = Math.round(spreadMeters);

  const distinctDays = new Set(valid.map((p) => p.dayKey).filter(Boolean)).size;

  const qualifies =
    valid.length >= EVIDENCE_MIN_CHECKINS &&
    distinctDays >= EVIDENCE_MIN_DISTINCT_DAYS &&
    spreadMeters <= EVIDENCE_MAX_SPREAD_METERS;

  const suggestedRadiusMeters = Math.min(
    INNER_RING_METERS,
    Math.max(SUGGESTED_RADIUS_MIN_METERS, spreadMeters + SUGGESTED_RADIUS_MARGIN_METERS),
  );

  return {
    count: valid.length,
    distinctDays,
    medianLatitude,
    medianLongitude,
    spreadMeters,
    qualifies,
    suggestedRadiusMeters,
  };
}
