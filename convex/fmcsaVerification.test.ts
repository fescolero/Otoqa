import { describe, expect, it } from 'vitest';
import {
  authorityActiveFromRows,
  matchDocketRows,
  parseCensusRecord,
} from './fmcsaVerification';

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

  it('ignores leading zeros — MCMIS extracts zero-pad docket numbers', () => {
    expect(matchDocketRows([{ docket_number: '00838202' }], '838202')).toBe('verified');
  });

  it('returns mismatch when no docket matches or no rows exist', () => {
    expect(matchDocketRows([{ docket_number: '111111' }], '948217')).toBe('mismatch');
    expect(matchDocketRows([], '948217')).toBe('mismatch');
  });

  it('ignores non-docket columns even when their digits collide', () => {
    expect(matchDocketRows([{ dot_number: '948217' }], '948217')).toBe('mismatch');
  });
});

describe('authorityActiveFromRows', () => {
  it('is active when any docket row has an active status', () => {
    const rows = [
      { docket_number: '111', op_auth_status: 'Inactive' },
      { docket_number: '222', op_auth_status: 'ACTIVE' },
    ];
    expect(authorityActiveFromRows(rows)).toBe(true);
  });

  it('never reads "Inactive" as active, and handles missing status', () => {
    expect(authorityActiveFromRows([{ op_auth_status: 'INACTIVE' }])).toBe(false);
    expect(authorityActiveFromRows([{ docket_number: '111' }])).toBe(false);
    expect(authorityActiveFromRows([])).toBe(false);
  });
});
