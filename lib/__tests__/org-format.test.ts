import { afterEach, describe, expect, it } from 'vitest';
import {
  orgFormatCurrency,
  orgFormatDate,
  orgFormatDistance,
  orgFormatNumber,
  orgDateFnsFormat,
  orgWeekStartsOn,
  setOrgFormatPrefs,
} from '../org-format';

// Module-level prefs persist between tests — always reset.
afterEach(() => setOrgFormatPrefs({}));

const JUL_15_2026 = Date.UTC(2026, 6, 15, 12);

describe('orgFormatNumber', () => {
  it('defaults to en-US separators', () => {
    expect(orgFormatNumber(1234.56, 2)).toBe('1,234.56');
    expect(orgFormatNumber(1234567)).toBe('1,234,567');
  });

  it('applies the 1.234,56 pattern', () => {
    setOrgFormatPrefs({ numberFormat: '1.234,56' });
    expect(orgFormatNumber(1234.56, 2)).toBe('1.234,56');
    expect(orgFormatNumber(1234567)).toBe('1.234.567');
  });

  it('applies the 1 234.56 pattern', () => {
    setOrgFormatPrefs({ numberFormat: '1 234.56' });
    expect(orgFormatNumber(1234.56, 2)).toBe('1 234.56');
  });
});

describe('orgFormatCurrency', () => {
  it('uses the workspace currency by default and swaps separators', () => {
    setOrgFormatPrefs({ currency: 'CAD', numberFormat: '1.234,56' });
    expect(orgFormatCurrency(1234.5)).toBe('CA$1.234,50');
  });

  it('lets an explicit currency argument win', () => {
    setOrgFormatPrefs({ currency: 'CAD' });
    expect(orgFormatCurrency(10, 'USD')).toBe('$10.00');
  });
});

describe('orgFormatDistance', () => {
  it('renders miles as stored by default', () => {
    expect(orgFormatDistance(128)).toBe('128 mi');
  });

  it('converts to kilometers when the workspace uses km', () => {
    setOrgFormatPrefs({ distanceUnit: 'km' });
    expect(orgFormatDistance(100)).toBe('161 km');
  });
});

describe('orgFormatDate', () => {
  it('keeps the pretty US style for the default format', () => {
    expect(orgFormatDate(JUL_15_2026)).toBe('Jul 15, 2026');
    expect(orgFormatDate(JUL_15_2026, 'short')).toBe('Jul 15');
  });

  it('renders DD/MM/YYYY literally', () => {
    setOrgFormatPrefs({ dateFormat: 'DD/MM/YYYY' });
    expect(orgFormatDate(JUL_15_2026)).toBe('15/07/2026');
    expect(orgFormatDate(JUL_15_2026, 'short')).toBe('15/07');
  });

  it('renders YYYY-MM-DD literally', () => {
    setOrgFormatPrefs({ dateFormat: 'YYYY-MM-DD' });
    expect(orgFormatDate(JUL_15_2026)).toBe('2026-07-15');
  });
});

describe('calendar helpers', () => {
  it('maps week start to react-day-picker values', () => {
    expect(orgWeekStartsOn()).toBe(1);
    setOrgFormatPrefs({ weekStart: 'sunday' });
    expect(orgWeekStartsOn()).toBe(0);
  });

  it('maps date format to date-fns patterns', () => {
    expect(orgDateFnsFormat()).toBe('MMM d, yyyy');
    setOrgFormatPrefs({ dateFormat: 'YYYY-MM-DD' });
    expect(orgDateFnsFormat()).toBe('yyyy-MM-dd');
  });

  it('ignores null/empty prefs and falls back to defaults', () => {
    setOrgFormatPrefs({ dateFormat: '', numberFormat: undefined });
    expect(orgFormatDate(JUL_15_2026)).toBe('Jul 15, 2026');
    expect(orgFormatNumber(1234)).toBe('1,234');
  });
});
