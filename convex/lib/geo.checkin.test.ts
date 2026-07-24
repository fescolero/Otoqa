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

  describe('hard mode', () => {
    it('allows within the inner ring', () => {
      const v = evaluateCheckInDistance({ mode: 'hard', distanceMeters: INNER_RING_METERS - 1 });
      expect(v.allowed).toBe(true);
      expect(v.outsideGeofence).toBe(false);
    });

    it('refuses past the inner ring', () => {
      const v = evaluateCheckInDistance({ mode: 'hard', distanceMeters: INNER_RING_METERS + 1 });
      expect(v.allowed).toBe(false);
      expect(v.outsideGeofence).toBe(true);
    });

    it('a coarse GPS fix widens the limit', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: INNER_RING_METERS + 50,
        accuracyMeters: 80,
      });
      expect(v.allowed).toBe(true);
      expect(v.limitMeters).toBe(INNER_RING_METERS + 80);
    });

    it('accuracy allowance is capped', () => {
      const v = evaluateCheckInDistance({
        mode: 'hard',
        distanceMeters: INNER_RING_METERS + 500,
        accuracyMeters: 5_000,
      });
      expect(v.allowed).toBe(false);
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
});
