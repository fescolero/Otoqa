import { formatCurrency, formatDate, formatTimestamp } from '../invoice';

describe('Invoice Utilities', () => {
  describe('formatCurrency', () => {
    it('formats USD correctly', () => {
      expect(formatCurrency(1234.56, 'USD')).toBe('$1,234.56');
    });

    it('formats CAD correctly', () => {
      expect(formatCurrency(1234.56, 'CAD')).toBe('CA$1,234.56');
    });

    it('defaults to USD', () => {
      expect(formatCurrency(1234.56)).toBe('$1,234.56');
    });

    it('handles zero', () => {
      expect(formatCurrency(0)).toBe('$0.00');
    });

    it('handles negative numbers', () => {
      expect(formatCurrency(-1234.56)).toBe('-$1,234.56');
    });
  });

  describe('formatDate', () => {
    it('formats ISO date string', () => {
      const result = formatDate('2024-01-15');
      expect(result).toContain('Jan');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });

    it('returns empty string for undefined', () => {
      expect(formatDate(undefined)).toBe('');
    });
  });

  describe('formatTimestamp', () => {
    it('formats Unix timestamp', () => {
      // Built in LOCAL time on purpose. `new Date('2024-01-15')` parses
      // a date-only ISO string as UTC midnight, while formatTimestamp
      // renders in the viewer's zone — so that form of the test asserts
      // "Jan 15" but gets "Jan 14" anywhere west of UTC, and only
      // passed because CI happens to run UTC. Nothing pins TZ here.
      const timestamp = new Date(2024, 0, 15, 12, 0, 0).getTime();
      const result = formatTimestamp(timestamp);
      expect(result).toContain('Jan');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });

    it('renders the instant in local time, whatever the zone', () => {
      // The contract: a timestamp is a moment, not a calendar date, so
      // it is shown in the viewer's zone. Noon keeps this clear of DST
      // boundaries in every timezone.
      const local = new Date(2024, 5, 30, 12, 0, 0);
      const result = formatTimestamp(local.getTime());
      expect(result).toBe(
        local.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        }),
      );
    });

    it('handles Unix epoch (0) without returning empty string', () => {
      expect(formatTimestamp(0)).not.toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(formatTimestamp(undefined)).toBe('');
    });
  });
});
