import { describe, expect, it } from 'vitest';
import { filterDotRows, matchDocketRows, parseCensusRecord } from './fmcsaVerification';

// Both helpers are pure parsers over Socrata rows — no Convex runtime needed.

describe('parseCensusRecord', () => {
  it('reports not-found for an empty result set', () => {
    expect(parseCensusRecord([])).toEqual({ found: false });
  });

  it('extracts legal name and active record status', () => {
    const rows = [
      { dot_number: '80321', legal_name: 'FEDEX FREIGHT INC', status_code: 'A' },
    ];
    expect(parseCensusRecord(rows)).toEqual({
      found: true,
      legalName: 'FEDEX FREIGHT INC',
      recordActive: true,
    });
  });

  it('treats non-A status codes as inactive and tolerates missing fields', () => {
    expect(parseCensusRecord([{ status_code: 'I' }])).toEqual({
      found: true,
      legalName: undefined,
      recordActive: false,
    });
    expect(parseCensusRecord([{ legal_name: 'X' }])).toEqual({
      found: true,
      legalName: 'X',
      recordActive: undefined,
    });
  });

  it('accepts "ACTIVE"-style status text', () => {
    expect(parseCensusRecord([{ status_code: 'ACTIVE' }]).recordActive).toBe(true);
  });
});

describe('matchDocketRows', () => {
  it('verifies when any docket-named column matches the wanted digits', () => {
    const rows = [
      { docket_number: '123456', original_action: 'GRANTED' },
      { docket_number: '948217', original_action: 'GRANTED' },
    ];
    expect(matchDocketRows(rows, '948217')).toBe('verified');
  });

  it('matches numeric values and alternative docket column names', () => {
    expect(matchDocketRows([{ docket: 948217 }], '948217')).toBe('verified');
    expect(matchDocketRows([{ docket_num: 'MC948217' }], '948217')).toBe('verified');
  });

  it('returns mismatch when no docket matches or no rows exist', () => {
    expect(matchDocketRows([{ docket_number: '111111' }], '948217')).toBe('mismatch');
    expect(matchDocketRows([], '948217')).toBe('mismatch');
  });

  it('ignores non-docket columns even when their digits collide', () => {
    expect(matchDocketRows([{ dot_number: '948217' }], '948217')).toBe('mismatch');
  });
});

describe('filterDotRows', () => {
  it('keeps rows whose dot-named column matches, across naming variants', () => {
    const rows = [
      { dot_number: '80321', docket_number: '123' },
      { dot_no: 80321, docket_number: '456' },
      { usdot: '80321', docket_number: '789' },
      { dot_number: '99999', docket_number: '000' },
    ];
    expect(filterDotRows(rows, '80321').map((r) => r.docket_number)).toEqual([
      '123',
      '456',
      '789',
    ]);
  });

  it('never matches on docket columns even when digits collide with the DOT', () => {
    const rows = [{ docket_number: '80321' }];
    expect(filterDotRows(rows, '80321')).toEqual([]);
  });

  it('returns empty for rows with no dot-like columns', () => {
    expect(filterDotRows([{ legal_name: 'X' }], '80321')).toEqual([]);
  });
});
