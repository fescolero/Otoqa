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
      const timestamp = new Date('2024-01-15').getTime();
      const result = formatTimestamp(timestamp);
      expect(result).toContain('Jan');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });

    it('handles Unix epoch (0) without returning empty string', () => {
      expect(formatTimestamp(0)).not.toBe('');
    });

    it('returns empty string for undefined', () => {
      expect(formatTimestamp(undefined)).toBe('');
    });
  });
});
