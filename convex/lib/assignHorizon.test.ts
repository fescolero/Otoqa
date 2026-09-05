import { describe, it, expect } from 'vitest';
import {
  assertValidAssignAheadDays,
  horizonEndDate,
  horizonPrefilterDate,
  isBeyondHorizon,
  isBeyondHorizonAt,
  serviceDateOf,
} from './assignHorizon';

// 2026-09-04T12:00Z — a fixed "now" so the expectations are literal dates.
const NOW = Date.UTC(2026, 8, 4, 12, 0, 0);

describe('assignHorizon', () => {
  it('serviceDateOf slices the UTC calendar date', () => {
    expect(serviceDateOf(NOW)).toBe('2026-09-04');
    // Just before midnight UTC is still the same day; just after is the next.
    expect(serviceDateOf(Date.UTC(2026, 8, 4, 23, 59, 59))).toBe('2026-09-04');
    expect(serviceDateOf(Date.UTC(2026, 8, 5, 0, 0, 1))).toBe('2026-09-05');
  });

  it('horizonEndDate is inclusive and crosses month boundaries', () => {
    expect(horizonEndDate(0, NOW)).toBe('2026-09-04');
    expect(horizonEndDate(7, NOW)).toBe('2026-09-11');
    expect(horizonEndDate(30, NOW)).toBe('2026-10-04');
  });

  it('no horizon configured → nothing is ever beyond it', () => {
    expect(isBeyondHorizon('2099-01-01', undefined, NOW)).toBe(false);
  });

  it('undated loads are never deferred — they are left to the route rules', () => {
    expect(isBeyondHorizon(undefined, 7, NOW)).toBe(false);
  });

  it('a load on the last day inside the horizon is due; the day after is not', () => {
    expect(isBeyondHorizon('2026-09-11', 7, NOW)).toBe(false);
    expect(isBeyondHorizon('2026-09-12', 7, NOW)).toBe(true);
  });

  it('horizon 0 means "only loads picking up today"', () => {
    expect(isBeyondHorizon('2026-09-04', 0, NOW)).toBe(false);
    expect(isBeyondHorizon('2026-09-05', 0, NOW)).toBe(true);
  });

  it('past-dated loads are never beyond the horizon', () => {
    expect(isBeyondHorizon('2026-08-01', 0, NOW)).toBe(false);
  });

  it('validates the settings value', () => {
    expect(() => assertValidAssignAheadDays(14)).not.toThrow();
    expect(() => assertValidAssignAheadDays(0)).not.toThrow();
    expect(() => assertValidAssignAheadDays(-1)).toThrow();
    expect(() => assertValidAssignAheadDays(1.5)).toThrow();
    expect(() => assertValidAssignAheadDays(366)).toThrow();
  });

  describe('time-based (scheduled pickup instant)', () => {
    const H = 60 * 60 * 1000;
    it('one day means 24 hours before the pickup, whatever the calendar says', () => {
      // 23 h out: due. 25 h out: not yet — even though it is "tomorrow".
      expect(isBeyondHorizonAt(NOW + 23 * H, 1, NOW)).toBe(false);
      expect(isBeyondHorizonAt(NOW + 25 * H, 1, NOW)).toBe(true);
      // An overnight trip picking up at 11 PM tomorrow is due at 11 PM tonight.
      expect(isBeyondHorizonAt(NOW + 35 * H, 1, NOW)).toBe(true);
      expect(isBeyondHorizonAt(NOW + 35 * H, 1, NOW + 11 * H)).toBe(false);
    });
    it('no horizon, or a pickup already past, is never beyond', () => {
      expect(isBeyondHorizonAt(NOW + 1000 * H, undefined, NOW)).toBe(false);
      expect(isBeyondHorizonAt(NOW - 5 * H, 0, NOW)).toBe(false);
    });
    it('the sweep prefilter date carries a day of slack', () => {
      expect(horizonPrefilterDate(1, NOW)).toBe('2026-09-06');
    });
  });
});
