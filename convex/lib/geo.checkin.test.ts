import { describe, it, expect } from 'vitest';
import {
  evaluateCheckInDistance,
  parseCheckInGeofenceMode,
  INNER_RING_METERS,
  OUTER_RING_METERS,
  CHECKIN_ACCURACY_ALLOWANCE_CAP_METERS,
} from './geo';

describe('parseCheckInGeofenceMode', () => {
  it('accepts the three valid modes', () => {
    expect(parseCheckInGeofenceMode('off')).toBe('off');
    expect(parseCheckInGeofenceMode('soft')).toBe('soft');
    expect(parseCheckInGeofenceMode('hard')).toBe('hard');
  });

  it('defaults to soft for unset or junk values', () => {
    expect(parseCheckInGeofenceMode(undefined)).toBe('soft');
    expect(parseCheckInGeofenceMode('')).toBe('soft');
    expect(parseCheckInGeofenceMode('HARD')).toBe('soft');
    expect(parseCheckInGeofenceMode(42)).toBe('soft');
  });
});

describe('evaluateCheckInDistance', () => {
  it('off mode always allows and never flags', () => {
    const v = evaluateCheckInDistance({ mode: 'off', distanceMeters: 50_000 });
    expect(v.allowed).toBe(true);
    expect(v.outsideGeofence).toBe(false);
  });

  describe('hard mode (no facility anchor → soft behavior; see facility suite for blocking)', () => {
    it('allows within the inner ring', () => {
      const v = evaluateCheckInDistance({ mode: 'hard', distanceMeters: INNER_RING_METERS - 1 });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(false);
    });

    it('flags but does not block past the inner ring without a verified facility', () => {
      const v = evaluateCheckInDistance({ mode: 'hard', distanceMeters: INNER_RING_METERS + 1 });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(true);
    });

    it('a coarse GPS fix widens the limit', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: INNER_RING_METERS + 50,
        accuracyMeters: 80,
      });
      expect(v.outsideGeofence).toBe(false);
      expect(v.limitMeters).toBe(INNER_RING_METERS + 80);
    });

    it('accuracy allowance is capped', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: INNER_RING_METERS + 500,
        accuracyMeters: 5_000,
      });
      expect(v.outsideGeofence).toBe(true);
      expect(v.limitMeters).toBe(INNER_RING_METERS + CHECKIN_ACCURACY_ALLOWANCE_CAP_METERS);
    });

    it('ignores non-positive accuracy', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: 100,
        accuracyMeters: -5,
      });
      expect(v.limitMeters).toBe(INNER_RING_METERS);
    });
  });

  describe('soft mode', () => {
    it('allows within the inner ring without flagging', () => {
      const v = evaluateCheckInDistance({ mode: 'soft', distanceMeters: 200 });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(false);
    });

    it('allows but flags between the inner ring and the outer ring', () => {
      const v = evaluateCheckInDistance({ mode: 'soft', distanceMeters: 2_000 });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(true);
      expect(v.canOverride).toBe(false);
    });

    it('still refuses beyond the outer ring (dwell/duration pay protection)', () => {
      const v = evaluateCheckInDistance({
        mode: 'soft',
        distanceMeters: OUTER_RING_METERS + 1,
      });
      expect(v.allowed).toBe(false);
      expect(v.outsideGeofence).toBe(true);
    });
  });

  describe('facility-anchored stops', () => {
    const verified = { verified: true, radiusMeters: 300 };

    it('hard mode enforces the facility radius on a verified facility', () => {
      const inside = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: 250,
        facility: verified,
      });
      expect(inside.allowed).toBe(true);

      const outside = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: 400,
        facility: verified,
      });
      expect(outside.allowed).toBe(false);
      expect(outside.limitMeters).toBe(300);
      expect(outside.canOverride).toBe(true);
    });

    it('hard mode NEVER hard-blocks an unverified facility (soft behavior)', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: 2_000,
        facility: { verified: false },
      });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(true);
      expect(v.canOverride).toBe(false);
    });

    it('hard mode never hard-blocks without a facility anchor', () => {
      const v = evaluateCheckInDistance({ mode: 'hard', distanceMeters: 2_000 });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(true);
    });

    it('needs-review demotes a verified facility to soft behavior', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: 2_000,
        facility: { ...verified, needsReview: true },
      });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(true);
      expect(v.canOverride).toBe(false);
    });

    it('facility radius defaults to the arrival ring when unset', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: 100,
        facility: { verified: true },
      });
      expect(v.limitMeters).toBe(INNER_RING_METERS);
    });

    it('accuracy allowance stacks on the facility radius, capped', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: 380,
        accuracyMeters: 5_000,
        facility: verified,
      });
      expect(v.limitMeters).toBe(300 + 100);
      expect(v.allowed).toBe(true);
    });

    it('soft mode ignores verification for blocking but honors the radius for flagging', () => {
      const v = evaluateCheckInDistance({
        mode: 'soft',
        distanceMeters: 400,
        facility: verified,
      });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(true);
      expect(v.limitMeters).toBe(300);
    });
  });
});
