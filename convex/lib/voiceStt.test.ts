import { describe, it, expect } from 'vitest';
import {
  buildDeepgramUrl,
  buildNluInput,
  coerceIntent,
  coerceLoadDraft,
  MAX_HISTORY_TURNS,
  MAX_KEYTERMS,
  MAX_TURN_CHARS,
} from './voiceStt';

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
      hcr: null,
      trip: null,
      dates: null,
      driverQuery: 'Marcus Vega',
    });
    // Facet form: route (trip/hcr) + dates instead of a load number.
    expect(
      coerceIntent({
        kind: 'assign',
        trip: '5',
        hcr: '96036',
        dates: ['2026-08-01', '2026-08-01', 'saturday', '2026-08-02'],
        driverQuery: 'Jorge Romero',
      }),
    ).toEqual({
      kind: 'assign',
      loadRef: null,
      hcr: '96036',
      trip: '5',
      dates: ['2026-08-01', '2026-08-02'], // deduped, malformed dropped
      driverQuery: 'Jorge Romero',
    });
    expect(coerceIntent({ kind: 'assign', trip: '5', driverQuery: 'Jorge' })).toEqual({
      kind: 'assign',
      loadRef: null,
      hcr: null,
      trip: '5',
      dates: null,
      driverQuery: 'Jorge',
    });
    // No load ref AND no facets → unusable.
    expect(coerceIntent({ kind: 'assign', driverQuery: 'Jorge' })).toBeNull();
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
    expect(coerceIntent({ kind: 'driver_loads', driverQuery: 'Jorge Romero', date: '2026-07-26' })).toEqual({
      kind: 'driver_history',
      driverQuery: 'Jorge Romero',
      date: '2026-07-26',
      dateEnd: null,
    });
    expect(coerceIntent({ kind: 'driver_loads', driverQuery: 'Jorge', date: 'yesterday' })).toEqual({
      kind: 'driver_history',
      driverQuery: 'Jorge',
      date: null, // malformed date dropped, driver kept
      dateEnd: null,
    });
    expect(coerceIntent({ kind: 'driver_loads', date: '2026-07-26' })).toBeNull(); // no driver
  });

  it('driver_loads ranges: valid, inverted swapped, end-only promoted, collapsed', () => {
    expect(
      coerceIntent({ kind: 'driver_loads', driverQuery: 'J', date: '2026-07-20', dateEnd: '2026-07-26' }),
    ).toEqual({ kind: 'driver_history', driverQuery: 'J', date: '2026-07-20', dateEnd: '2026-07-26' });
    expect(
      coerceIntent({ kind: 'driver_loads', driverQuery: 'J', date: '2026-07-26', dateEnd: '2026-07-20' }),
    ).toEqual({ kind: 'driver_history', driverQuery: 'J', date: '2026-07-20', dateEnd: '2026-07-26' });
    expect(coerceIntent({ kind: 'driver_loads', driverQuery: 'J', dateEnd: '2026-07-26' })).toEqual({
      kind: 'driver_history',
      driverQuery: 'J',
      date: '2026-07-26',
      dateEnd: null,
    });
    expect(
      coerceIntent({ kind: 'driver_loads', driverQuery: 'J', date: '2026-07-26', dateEnd: '2026-07-26' }),
    ).toEqual({ kind: 'driver_history', driverQuery: 'J', date: '2026-07-26', dateEnd: null });
  });

  it('buildNluInput: bare transcript with no context (v3-identical single-shot)', () => {
    expect(buildNluInput('assign load 1001 to Marcus')).toBe('assign load 1001 to Marcus');
    expect(buildNluInput('assign load 1001 to Marcus', [], null)).toBe('assign load 1001 to Marcus');
  });

  it('buildNluInput: renders roles oldest-first with the new utterance labeled', () => {
    const out = buildNluInput(
      'what about Sam',
      [
        { role: 'you', text: 'what loads did Jorge have yesterday' },
        { role: 'agent', text: 'Jorge Romero — 2 loads yesterday: #1001; #1002.' },
      ],
      null,
    );
    expect(out).toBe(
      [
        'Recent conversation (oldest first):',
        'Dispatcher: what loads did Jorge have yesterday',
        'Assistant: Jorge Romero — 2 loads yesterday: #1001; #1002.',
        'New dispatcher utterance: "what about Sam"',
      ].join('\n'),
    );
  });

  it('buildNluInput: caps turns, truncates long text, includes the clarify bridge', () => {
    const turns = Array.from({ length: 20 }, (_, i) => ({
      role: 'you' as const,
      text: `turn ${i}`,
    }));
    const out = buildNluInput('3 pm', turns, 'move load 1001');
    const lines = out.split('\n');
    // header + MAX turns + bridge + new utterance
    expect(lines).toHaveLength(1 + MAX_HISTORY_TURNS + 2);
    expect(lines[1]).toBe(`Dispatcher: turn ${20 - MAX_HISTORY_TURNS}`); // oldest kept
    expect(out).toContain('Earlier command awaiting completion: "move load 1001"');

    const long = buildNluInput('x', [{ role: 'agent', text: 'a'.repeat(500) }], null);
    expect(long).toContain(`${'a'.repeat(MAX_TURN_CHARS)}…`);
    expect(long).not.toContain('a'.repeat(MAX_TURN_CHARS + 1));
  });

  it('clarify: question required', () => {
    expect(coerceIntent({ kind: 'clarify', question: 'What time should load 1001 move to?' })).toEqual({
      kind: 'clarify',
      question: 'What time should load 1001 move to?',
    });
    expect(coerceIntent({ kind: 'clarify' })).toBeNull();
    expect(coerceIntent({ kind: 'clarify', question: '  ' })).toBeNull();
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

describe('coerceLoadDraft', () => {
  it('keeps valid fields, nulls the rest', () => {
    expect(
      coerceLoadDraft({
        customerName: 'Acme Shippers',
        pickupAddress: 'Fresno, CA',
        dropoffAddress: 'Reno, NV',
        pickupDate: '2026-07-28',
        pickupHour: 8,
        dropoffHour: 16,
        commodity: 'Produce',
      }),
    ).toEqual({
      customerName: 'Acme Shippers',
      commodity: 'Produce',
      pickupAddress: 'Fresno, CA',
      dropoffAddress: 'Reno, NV',
      pickupDate: '2026-07-28',
      pickupHour: 8,
      dropoffDate: null,
      dropoffHour: 16,
    });
  });

  it('drops malformed values instead of failing the draft', () => {
    const d = coerceLoadDraft({
      pickupAddress: 'Fresno',
      pickupDate: 'tomorrow', // not YYYY-MM-DD → dropped
      pickupHour: 25, // out of range → dropped
      commodity: '  ',
    });
    expect(d).toEqual({
      customerName: null,
      commodity: null,
      pickupAddress: 'Fresno',
      dropoffAddress: null,
      pickupDate: null,
      pickupHour: null,
      dropoffDate: null,
      dropoffHour: null,
    });
  });

  it('null when nothing usable was said', () => {
    expect(coerceLoadDraft({})).toBeNull();
    expect(coerceLoadDraft({ commodity: ' ' })).toBeNull();
    expect(coerceLoadDraft(null)).toBeNull();
  });
});
