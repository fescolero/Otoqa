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

  it('treats a row without a summary as every required document missing (day-one rule)', () => {
    // No documents can exist before the backfill, so an undefined summary
    // means all upload-required driver types are missing.
    expect(countAttention(base, today)).toBeGreaterThan(0);
  });

  it('returns 0 when nothing is missing and every mirror is current', () => {
    const d: DriverRow = {
      ...base,
      missingDocTypeKeys: [],
      licenseExpiration: '2030-01-01',
      medicalExpiration: '2030-01-01',
      badgeExpiration: '2030-01-01',
      twicExpiration: '2030-01-01',
    };
    expect(countAttention(d, today)).toBe(0);
  });

  it('counts each missing type once and each expired/expiring mirror once', () => {
    const d: DriverRow = {
      ...base,
      missingDocTypeKeys: ['hazmat', 'i9'],   // 2 missing
      licenseExpiration: '2020-01-01',        // expired
      medicalExpiration: '2026-05-20',        // expiring (within 30 days)
      badgeExpiration: '2027-05-04',          // valid
      twicExpiration: '2030-01-01',           // valid
    };
    expect(countAttention(d, today)).toBe(4);
  });

  it('does not double count a Missing type whose stale mirror is expired', () => {
    const d: DriverRow = {
      ...base,
      missingDocTypeKeys: ['cdl'],
      licenseExpiration: '2020-01-01', // stale mirror kept on archive (spec §5.3)
      medicalExpiration: '2030-01-01',
      badgeExpiration: '2030-01-01',
      twicExpiration: '2030-01-01',
    };
    expect(countAttention(d, today)).toBe(1);
  });

  it('does not count "warning" (31–60 days) mirrors', () => {
    const d: DriverRow = {
      ...base,
      missingDocTypeKeys: [],
      licenseExpiration: '2026-06-15',
    };
    expect(countAttention(d, today)).toBe(0);
  });
});
