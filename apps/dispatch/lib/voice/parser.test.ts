import { describe, it, expect } from 'vitest';
import {
  matchByRef,
  matchDriver,
  nextOccurrence,
  parseCommand,
  parseSpokenTime,
} from './parser';

describe('parseCommand', () => {
  it('assign variants', () => {
    expect(parseCommand('Assign load 1001 to Marcus Vega')).toEqual({
      kind: 'assign',
      loadRef: '1001',
      driverQuery: 'Marcus Vega',
    });
    expect(parseCommand('give L-1001 to marcus')).toEqual({
      kind: 'assign',
      loadRef: 'L-1001',
      driverQuery: 'marcus',
    });
    expect(parseCommand('assign load number 42 to Sam.')).toEqual({
      kind: 'assign',
      loadRef: '42',
      driverQuery: 'Sam',
    });
  });

  it('move variants', () => {
    expect(parseCommand('move load 1001 to 3 pm')).toEqual({
      kind: 'move_window',
      loadRef: '1001',
      time: { hour: 15, minute: 0 },
    });
    expect(parseCommand("push 1001's appointment to 15:45")).toEqual({
      kind: 'move_window',
      loadRef: '1001',
      time: { hour: 15, minute: 45 },
    });
    expect(parseCommand('reschedule load 7 pickup to noon')).toEqual({
      kind: 'move_window',
      loadRef: '7',
      time: { hour: 12, minute: 0 },
    });
  });

  it('offer variants, with and without a ref', () => {
    expect(parseCommand('accept the offer for load 1001')).toEqual({
      kind: 'accept_offer',
      loadRef: '1001',
    });
    expect(parseCommand('accept offer')).toEqual({ kind: 'accept_offer', loadRef: null });
    expect(parseCommand('decline offer 88')).toEqual({ kind: 'decline_offer', loadRef: '88' });
    expect(parseCommand('reject the offer')).toEqual({ kind: 'decline_offer', loadRef: null });
  });

  it('summaries and unknown', () => {
    expect(parseCommand("what's on the board?")).toEqual({ kind: 'board_summary' });
    expect(parseCommand("what's rolling right now")).toEqual({ kind: 'board_summary' });
    expect(parseCommand('any alerts')).toEqual({ kind: 'alerts_summary' });
    expect(parseCommand('what needs attention')).toEqual({ kind: 'alerts_summary' });
    expect(parseCommand('sing me a song')).toEqual({ kind: 'unknown', text: 'sing me a song' });
  });
});

describe('parseSpokenTime', () => {
  it('parses meridiem, 24h, and words', () => {
    expect(parseSpokenTime('3 pm')).toEqual({ hour: 15, minute: 0 });
    expect(parseSpokenTime('3:30pm')).toEqual({ hour: 15, minute: 30 });
    expect(parseSpokenTime('9 a.m.')).toEqual({ hour: 9, minute: 0 });
    expect(parseSpokenTime('12 am')).toEqual({ hour: 0, minute: 0 });
    expect(parseSpokenTime('15:45')).toEqual({ hour: 15, minute: 45 });
    expect(parseSpokenTime('noon')).toEqual({ hour: 12, minute: 0 });
    expect(parseSpokenTime('midnight')).toEqual({ hour: 0, minute: 0 });
  });
  it('daytime assumption: bare 1-7 reads as PM, 8+ as-is', () => {
    expect(parseSpokenTime('3')).toEqual({ hour: 15, minute: 0 });
    expect(parseSpokenTime('7:15')).toEqual({ hour: 19, minute: 15 });
    expect(parseSpokenTime('8')).toEqual({ hour: 8, minute: 0 });
    expect(parseSpokenTime('14')).toEqual({ hour: 14, minute: 0 });
  });
  it('rejects garbage', () => {
    expect(parseSpokenTime('sometime later')).toBeNull();
    expect(parseSpokenTime('25:99')).toBeNull();
  });
});

describe('matchByRef', () => {
  const rows = [{ id: 'L-1001' }, { id: 'L-2001' }, { id: 'HCR-77' }];
  const get = (r: { id: string }) => r.id;
  it('exact, suffix, substring in that order', () => {
    expect(matchByRef(rows, get, 'l1001')).toEqual({ match: rows[0] });
    expect(matchByRef(rows, get, '2001')).toEqual({ match: rows[1] });
    expect(matchByRef(rows, get, '77')).toEqual({ match: rows[2] });
  });
  it('ambiguous when several match, null when none', () => {
    expect(matchByRef(rows, get, '001')).toEqual({ ambiguous: [rows[0], rows[1]] });
    expect(matchByRef(rows, get, '9999')).toBeNull();
  });
});

describe('matchDriver', () => {
  const drivers = [
    { firstName: 'Marcus', lastName: 'Vega' },
    { firstName: 'Sam', lastName: 'Ortiz' },
    { firstName: 'Sam', lastName: 'Lee' },
  ];
  it('full name, prefix, then single-name equality', () => {
    expect(matchDriver(drivers, 'marcus vega')).toEqual({ match: drivers[0] });
    expect(matchDriver(drivers, 'Marcus V')).toEqual({ match: drivers[0] });
    expect(matchDriver(drivers, 'ortiz')).toEqual({ match: drivers[1] });
  });
  it('two Sams are ambiguous, unknown is null', () => {
    expect(matchDriver(drivers, 'sam')).toEqual({ ambiguous: [drivers[1], drivers[2]] });
    expect(matchDriver(drivers, 'taylor')).toBeNull();
  });
});

describe('nextOccurrence', () => {
  it('today when still ahead, tomorrow when past', () => {
    const now = new Date('2026-07-26T10:00:00');
    expect(nextOccurrence({ hour: 15, minute: 0 }, now).getDate()).toBe(26);
    expect(nextOccurrence({ hour: 9, minute: 0 }, now).getDate()).toBe(27);
    expect(nextOccurrence({ hour: 15, minute: 0 }, now).getHours()).toBe(15);
  });
});
