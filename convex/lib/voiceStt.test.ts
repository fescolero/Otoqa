import { describe, it, expect } from 'vitest';
import { buildDeepgramUrl, coerceIntent, MAX_KEYTERMS } from './voiceStt';

describe('buildDeepgramUrl', () => {
  it('pins nova-3 + numerals and carries keyterms', () => {
    const url = new URL(buildDeepgramUrl(['Marcus Vega', 'Acme Shippers']));
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('numerals')).toBe('true');
    expect(url.searchParams.getAll('keyterm')).toEqual(['Marcus Vega', 'Acme Shippers']);
  });

  it('dedupes case-insensitively, drops blanks, caps the list', () => {
    const terms = ['Sam Ortiz', 'sam ortiz', '  ', ...Array.from({ length: 300 }, (_, i) => `Driver ${i}`)];
    const url = new URL(buildDeepgramUrl(terms));
    const keyterms = url.searchParams.getAll('keyterm');
    expect(keyterms[0]).toBe('Sam Ortiz');
    expect(keyterms.filter((k) => k.toLowerCase() === 'sam ortiz')).toHaveLength(1);
    expect(keyterms.length).toBe(MAX_KEYTERMS);
  });
});

describe('coerceIntent', () => {
  it('accepts well-formed intents', () => {
    expect(coerceIntent({ kind: 'assign', loadRef: '1001', driverQuery: 'Marcus Vega' })).toEqual({
      kind: 'assign',
      loadRef: '1001',
      driverQuery: 'Marcus Vega',
    });
    expect(coerceIntent({ kind: 'move_window', loadRef: 'HCR75960', hour: 15, minute: 30 })).toEqual({
      kind: 'move_window',
      loadRef: 'HCR75960',
      time: { hour: 15, minute: 30 },
    });
    expect(coerceIntent({ kind: 'move_window', loadRef: '7', hour: 9 })).toEqual({
      kind: 'move_window',
      loadRef: '7',
      time: { hour: 9, minute: 0 },
    });
    expect(coerceIntent({ kind: 'accept_offer' })).toEqual({ kind: 'accept_offer', loadRef: null });
    expect(coerceIntent({ kind: 'decline_offer', loadRef: '88' })).toEqual({
      kind: 'decline_offer',
      loadRef: '88',
    });
    expect(coerceIntent({ kind: 'board_summary' })).toEqual({ kind: 'board_summary' });
  });

  it('rejects malformed or unknown → null (caller falls back to the on-device parser)', () => {
    expect(coerceIntent({ kind: 'unknown' })).toBeNull();
    expect(coerceIntent({ kind: 'assign', loadRef: '1001' })).toBeNull(); // no driver
    expect(coerceIntent({ kind: 'assign', loadRef: ' ', driverQuery: 'Sam' })).toBeNull();
    expect(coerceIntent({ kind: 'move_window', loadRef: '1', hour: 25 })).toBeNull();
    expect(coerceIntent({ kind: 'move_window', hour: 9 })).toBeNull(); // no load
    expect(coerceIntent('assign')).toBeNull();
    expect(coerceIntent(null)).toBeNull();
  });
});
