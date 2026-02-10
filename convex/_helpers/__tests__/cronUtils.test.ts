import {
  addDaysToUtcDateString,
  filterLoadsBySource,
  isTimeOnOrAfterUtc,
  shouldRunInterval,
} from '../cronUtils';

describe('cronUtils', () => {
  describe('shouldRunInterval', () => {
    it('returns true when last run is missing', () => {
      const now = Date.UTC(2026, 1, 10, 12, 0, 0);
      expect(
        shouldRunInterval({ nowMs: now, lastRunAtMs: undefined, defaultIntervalMinutes: 60 })
      ).toBe(true);
    });

    it('returns false when within the interval window', () => {
      const now = Date.UTC(2026, 1, 10, 12, 0, 0);
      const lastRunAt = now - 30 * 60 * 1000;
      expect(
        shouldRunInterval({ nowMs: now, lastRunAtMs: lastRunAt, defaultIntervalMinutes: 60 })
      ).toBe(false);
    });

    it('returns true when outside the interval window', () => {
      const now = Date.UTC(2026, 1, 10, 12, 0, 0);
      const lastRunAt = now - 61 * 60 * 1000;
      expect(
        shouldRunInterval({ nowMs: now, lastRunAtMs: lastRunAt, defaultIntervalMinutes: 60 })
      ).toBe(true);
    });

    it('returns true for non-positive intervals', () => {
      const now = Date.UTC(2026, 1, 10, 12, 0, 0);
      expect(
        shouldRunInterval({ nowMs: now, lastRunAtMs: now, intervalMinutes: 0 })
      ).toBe(true);
    });
  });

  describe('addDaysToUtcDateString', () => {
    it('adds days across months', () => {
      expect(addDaysToUtcDateString('2026-01-31', 1)).toBe('2026-02-01');
    });

    it('adds days within the same month', () => {
      expect(addDaysToUtcDateString('2026-02-10', 2)).toBe('2026-02-12');
    });
  });

  describe('isTimeOnOrAfterUtc', () => {
    it('returns true when now is after target time', () => {
      const now = Date.UTC(2026, 1, 10, 6, 30, 0);
      expect(isTimeOnOrAfterUtc(now, '06:00')).toBe(true);
    });

    it('returns false when now is before target time', () => {
      const now = Date.UTC(2026, 1, 10, 5, 59, 0);
      expect(isTimeOnOrAfterUtc(now, '06:00')).toBe(false);
    });

    it('does not block on invalid time strings', () => {
      const now = Date.UTC(2026, 1, 10, 6, 30, 0);
      expect(isTimeOnOrAfterUtc(now, 'invalid')).toBe(true);
    });
  });

  describe('filterLoadsBySource', () => {
    it('filters loads when a source filter is provided', () => {
      const loads = [
        { id: 1, externalSource: 'FOURKITES' },
        { id: 2, externalSource: 'PROJECT44' },
        { id: 3, externalSource: undefined },
      ];

      const filtered = filterLoadsBySource(loads, 'FOURKITES');
      expect(filtered.map((load) => load.id)).toEqual([1]);
    });

    it('returns all loads when no filter is provided', () => {
      const loads = [
        { id: 1, externalSource: 'FOURKITES' },
        { id: 2, externalSource: 'PROJECT44' },
      ];

      expect(filterLoadsBySource(loads).length).toBe(2);
    });
  });
});
