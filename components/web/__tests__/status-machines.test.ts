import { describe, expect, it } from 'vitest';
import { resolveStatusId, STATE_MACHINES } from '../status-machines';

describe('resolveStatusId', () => {
  it('matches exact label (case-insensitive)', () => {
    expect(resolveStatusId('driver', 'Active')).toBe('active');
    expect(resolveStatusId('driver', 'on leave')).toBe('on_leave');
    expect(resolveStatusId('driver', 'TERMINATED')).toBe('terminated');
  });

  it('matches state id directly', () => {
    expect(resolveStatusId('driver', 'on_leave')).toBe('on_leave');
    expect(resolveStatusId('driver', 'ooo')).toBe('ooo');
  });

  it('falls back to legacy alias when no label matches', () => {
    // Legacy "Inactive" maps to "Out of service" in the driver machine.
    expect(resolveStatusId('driver', 'Inactive')).toBe('ooo');
  });

  it('returns the machine initial when no match exists', () => {
    expect(resolveStatusId('driver', 'something-bogus')).toBe(STATE_MACHINES.driver.initial);
    expect(resolveStatusId('driver', '')).toBe(STATE_MACHINES.driver.initial);
    expect(resolveStatusId('driver', undefined)).toBe(STATE_MACHINES.driver.initial);
  });

  it('resolves across all entity machines', () => {
    expect(resolveStatusId('truck',    'In service')).toBe('in_service');
    expect(resolveStatusId('trailer',  'Reserved')).toBe('reserved');
    expect(resolveStatusId('customer', 'On credit hold')).toBe('hold');
    expect(resolveStatusId('carrier',  'Approved')).toBe('approved');
  });
});

describe('STATE_MACHINES', () => {
  it('every entity has an initial state that exists in its states map', () => {
    for (const [name, machine] of Object.entries(STATE_MACHINES)) {
      expect(machine.states[machine.initial], `${name}.initial`).toBeDefined();
    }
  });

  it('driver transitions only reference known states', () => {
    const ids = new Set(Object.keys(STATE_MACHINES.driver.states));
    const transitions = STATE_MACHINES.driver.transitions ?? {};
    for (const [from, tos] of Object.entries(transitions)) {
      expect(ids.has(from), `transition source ${from}`).toBe(true);
      for (const to of tos) {
        expect(ids.has(to), `transition ${from} -> ${to}`).toBe(true);
      }
    }
  });

  it('terminal states have transitions: [] (irreversible)', () => {
    const m = STATE_MACHINES.driver;
    for (const s of Object.values(m.states)) {
      if (s.terminal) {
        const next = m.transitions?.[s.id];
        expect(next, `${s.id} should be terminal`).toEqual([]);
      }
    }
  });
});
