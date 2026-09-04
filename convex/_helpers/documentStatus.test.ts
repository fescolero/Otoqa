/**
 * documentStatus — the one status computation every surface shares.
 * Covers each row of docs/documents-storage-spec.md §3, the threshold
 * boundaries, the missing summary, and list-row attention counting.
 */
import { describe, expect, it } from 'vitest';
import {
  computeDocumentStatus,
  computeMissingTypeKeys,
  countDriverAttention,
  dateExpiryStatus,
  driverMissingKeys,
  needsAttention,
  DEFAULT_REQUIRED_DRIVER_TYPE_KEYS,
} from './documentStatus';

const today = '2026-05-04';

const expiringUpload = { expires: true, uploadRequired: true };
const nonExpiringUpload = { expires: false, uploadRequired: true };
const dateOnly = { expires: true, uploadRequired: false };

describe('dateExpiryStatus', () => {
  it('treats an absent or unparseable date as missing, never valid', () => {
    expect(dateExpiryStatus(undefined, today)).toBe('missing');
    expect(dateExpiryStatus('', today)).toBe('missing');
    expect(dateExpiryStatus('not-a-date', today)).toBe('missing');
  });

  it('classifies by calendar-day thresholds (30 expiring, 60 warning)', () => {
    expect(dateExpiryStatus('2026-05-03', today)).toBe('expired');
    expect(dateExpiryStatus('2026-05-04', today)).toBe('expiring'); // today counts as expiring, not expired
    expect(dateExpiryStatus('2026-06-03', today)).toBe('expiring'); // +30
    expect(dateExpiryStatus('2026-06-04', today)).toBe('warning'); // +31
    expect(dateExpiryStatus('2026-07-03', today)).toBe('warning'); // +60
    expect(dateExpiryStatus('2026-07-04', today)).toBe('valid'); // +61
  });
});

describe('computeDocumentStatus (spec §3 table)', () => {
  it('no active row → missing', () => {
    expect(computeDocumentStatus(expiringUpload, null, today)).toBe('missing');
    expect(computeDocumentStatus(expiringUpload, undefined, today)).toBe('missing');
  });

  it('active row without a file on an upload-required type → missing', () => {
    expect(computeDocumentStatus(expiringUpload, { hasFile: false, expirationDate: '2030-01-01' }, today)).toBe('missing');
  });

  it('active row without a file on a date-only type is fine', () => {
    expect(computeDocumentStatus(dateOnly, { hasFile: false, expirationDate: '2030-01-01' }, today)).toBe('valid');
  });

  it('expiring type without a date → needs_date', () => {
    expect(computeDocumentStatus(expiringUpload, { hasFile: true }, today)).toBe('needs_date');
  });

  it('expiring type with a date → expired / expiring / warning / valid', () => {
    expect(computeDocumentStatus(expiringUpload, { hasFile: true, expirationDate: '2020-01-01' }, today)).toBe('expired');
    expect(computeDocumentStatus(expiringUpload, { hasFile: true, expirationDate: '2026-05-20' }, today)).toBe('expiring');
    expect(computeDocumentStatus(expiringUpload, { hasFile: true, expirationDate: '2026-06-20' }, today)).toBe('warning');
    expect(computeDocumentStatus(expiringUpload, { hasFile: true, expirationDate: '2030-01-01' }, today)).toBe('valid');
  });

  it('non-expiring type with a file → on_file regardless of dates', () => {
    expect(computeDocumentStatus(nonExpiringUpload, { hasFile: true }, today)).toBe('on_file');
    expect(computeDocumentStatus(nonExpiringUpload, { hasFile: true, expirationDate: '2020-01-01' }, today)).toBe('on_file');
  });
});

describe('needsAttention', () => {
  it('flags missing, needs_date, expired, expiring — not warning/valid/on_file', () => {
    expect(needsAttention('missing')).toBe(true);
    expect(needsAttention('needs_date')).toBe(true);
    expect(needsAttention('expired')).toBe(true);
    expect(needsAttention('expiring')).toBe(true);
    expect(needsAttention('warning')).toBe(false);
    expect(needsAttention('valid')).toBe(false);
    expect(needsAttention('on_file')).toBe(false);
  });
});

describe('computeMissingTypeKeys', () => {
  const types = [
    { key: 'cdl', uploadRequired: true, hidden: false },
    { key: 'medical', uploadRequired: true, hidden: false },
    { key: 'note_only', uploadRequired: false, hidden: false },
    { key: 'hidden_one', uploadRequired: true, hidden: true },
  ];

  it('is time-independent and lists every visible type without a qualifying active row', () => {
    expect(computeMissingTypeKeys(types, [])).toEqual(['cdl', 'medical', 'note_only']);
  });

  it('requires a FILE for upload-required types but accepts a dated entry for date-only types', () => {
    const active = [
      { typeKey: 'cdl', hasFile: true },
      { typeKey: 'medical', hasFile: false }, // file-less row does not satisfy an upload-required type
      { typeKey: 'note_only', hasFile: false },
    ];
    expect(computeMissingTypeKeys(types, active)).toEqual(['medical']);
  });

  it('ignores hidden types entirely', () => {
    expect(computeMissingTypeKeys(types, [])).not.toContain('hidden_one');
  });
});

describe('driverMissingKeys / countDriverAttention', () => {
  it('an undefined summary means every required system driver type is missing (day-one rule)', () => {
    expect(driverMissingKeys({ missingDocTypeKeys: undefined })).toEqual([...DEFAULT_REQUIRED_DRIVER_TYPE_KEYS]);
    expect(driverMissingKeys({ missingDocTypeKeys: null })).toEqual([...DEFAULT_REQUIRED_DRIVER_TYPE_KEYS]);
    expect(driverMissingKeys({ missingDocTypeKeys: [] })).toEqual([]);
  });

  it('counts missing types once and expired/expiring mirrors once', () => {
    expect(
      countDriverAttention(
        {
          missingDocTypeKeys: ['i9'],
          licenseExpiration: '2020-01-01', // expired
          medicalExpiration: '2026-05-10', // expiring
          badgeExpiration: '2026-06-20', // warning → not counted
          twicExpiration: '2030-01-01', // valid
        },
        today,
      ),
    ).toBe(3);
  });

  it('never double counts a Missing type via its stale mirror (spec §5.3)', () => {
    expect(
      countDriverAttention(
        { missingDocTypeKeys: ['cdl'], licenseExpiration: '2020-01-01' },
        today,
      ),
    ).toBe(1);
  });

  it('an empty summary with no mirrors is zero attention', () => {
    expect(countDriverAttention({ missingDocTypeKeys: [] }, today)).toBe(0);
  });

  it('a "Needs date" type counts once, never when it is also missing or hidden', () => {
    expect(countDriverAttention({ missingDocTypeKeys: [], needsDateTypeKeys: ['medical'] }, today)).toBe(1);
    expect(countDriverAttention({ missingDocTypeKeys: ['medical'], needsDateTypeKeys: ['medical'] }, today)).toBe(1);
    expect(countDriverAttention({ missingDocTypeKeys: [], needsDateTypeKeys: ['medical'] }, today, new Set(['medical']))).toBe(0);
  });

  it('the unstamped-row fallback drops hidden types like a stamped summary would', () => {
    expect(countDriverAttention({ missingDocTypeKeys: undefined }, today, new Set(['twic', 'hazmat']))).toBe(6);
  });

  it('non-mirrored expiring types count through docExpirations (and a mirror is not double counted)', () => {
    const row = { missingDocTypeKeys: [], licenseExpiration: '2020-01-01', docExpirations: { hazmat: '2020-06-01', cdl: '2020-01-01' } };
    expect(countDriverAttention(row, today)).toBe(2);
  });

  it("a hidden type's stale mirror is not attention (the Documents tab shows nothing for it)", () => {
    const row = { missingDocTypeKeys: [], twicExpiration: '2020-01-01' };
    expect(countDriverAttention(row, today)).toBe(1);
    expect(countDriverAttention(row, today, new Set(['twic']))).toBe(0);
  });
});
