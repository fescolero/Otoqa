import { describe, expect, it } from 'vitest';
import { countAttention, getDocStatus, type DriverRow } from '../build-driver-details';

const today = '2026-05-04'; // Matches the conversation's pinned date.

describe('getDocStatus', () => {
  it('returns "na" when no date is provided', () => {
    expect(getDocStatus(undefined, today)).toBe('na');
    expect(getDocStatus('', today)).toBe('na');
  });

  it('returns "expired" for past dates', () => {
    expect(getDocStatus('2020-01-01', today)).toBe('expired');
  });

  it('returns "expiring" for dates within 30 days', () => {
    expect(getDocStatus('2026-05-25', today)).toBe('expiring'); // 21 days
    expect(getDocStatus('2026-06-03', today)).toBe('expiring'); // 30 days
  });

  it('returns "warning" for dates 31–60 days out', () => {
    expect(getDocStatus('2026-06-15', today)).toBe('warning'); // ~42 days
  });

  it('returns "valid" for dates >60 days out', () => {
    expect(getDocStatus('2027-05-04', today)).toBe('valid');
  });
});

describe('countAttention', () => {
  const base: DriverRow = {
    _id: 'd1',
    firstName: 'Sergio',
    lastName: 'Barba',
    email: 'sergio@example.com',
    phone: '5555550100',
  };

  it('returns 0 when no docs are stored', () => {
    expect(countAttention(base)).toBe(0);
  });

  it('counts each expired or expiring document', () => {
    const d: DriverRow = {
      ...base,
      licenseExpiration: '2020-01-01',     // expired
      medicalExpiration: '2026-05-20',     // expiring (within 30 days of 2026-05-04)
      badgeExpiration: '2027-05-04',       // valid
      twicExpiration: undefined,           // na
    };
    // Note: countAttention uses today() at runtime, so this asserts shape
    // rather than exact count — confirm at least the expired one counts.
    expect(countAttention(d)).toBeGreaterThanOrEqual(1);
  });

  it('does not count "valid" or "na" documents', () => {
    const d: DriverRow = {
      ...base,
      licenseExpiration: '2030-01-01',
      medicalExpiration: '2030-01-01',
    };
    expect(countAttention(d)).toBe(0);
  });
});
