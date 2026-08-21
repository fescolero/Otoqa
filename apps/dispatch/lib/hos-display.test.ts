/**
 * The empty-data case is the reason this module exists.
 *
 * Shipped once without it: 17 idle drivers with no session history each drew
 * a full green "70h" bar, because `estimateHos` reports an untouched 70h
 * cycle when it has nothing to go on. The screen looked confident and knew
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import { hasHosSignal, hosBarValue, hosTone, type HosLike } from './hos-display';

/** What `estimateHos` returns for a driver with no sessions at all. */
const NO_DATA: HosLike = {
  onShift: false,
  onDutyHours: null,
  windowRemainingHours: null,
  cycleUsedHours: 0,
  cycleRemainingHours: 70,
  offDutyHours: null,
};

const ON_SHIFT: HosLike = {
  onShift: true,
  onDutyHours: 8,
  windowRemainingHours: 6,
  cycleUsedHours: 32,
  cycleRemainingHours: 38,
  offDutyHours: null,
};

const RESTED: HosLike = {
  onShift: false,
  onDutyHours: null,
  windowRemainingHours: null,
  cycleUsedHours: 10,
  cycleRemainingHours: 60,
  offDutyHours: 12,
};

describe('hasHosSignal', () => {
  it('is false when nothing is known — a full cycle is not evidence of rest', () => {
    expect(hasHosSignal(NO_DATA)).toBe(false);
  });

  it('is true on shift', () => {
    expect(hasHosSignal(ON_SHIFT)).toBe(true);
  });

  it('is true off shift once a shift has actually ended', () => {
    expect(hasHosSignal(RESTED)).toBe(true);
  });

  it('is true when cycle hours were used but no shift end was recorded', () => {
    expect(hasHosSignal({ ...NO_DATA, cycleUsedHours: 4, cycleRemainingHours: 66 })).toBe(true);
  });
});

describe('hosBarValue', () => {
  it('measures the 14h window on shift — the take-another-load number', () => {
    expect(hosBarValue(ON_SHIFT)).toEqual({ remaining: 6, max: 14, label: '6h left' });
  });

  it('falls back to the 70h cycle off shift, and labels it as such', () => {
    // "6h" and "70h" must not read as the same kind of fact.
    expect(hosBarValue(RESTED)).toEqual({ remaining: 60, max: 70, label: '60h cycle' });
  });

  it('treats a null window on shift as nothing left, never as unlimited', () => {
    expect(hosBarValue({ ...ON_SHIFT, windowRemainingHours: null }).remaining).toBe(0);
  });
});

describe('hosTone', () => {
  it('grades on hours remaining, not on fraction of the ceiling', () => {
    // 2h of a 70h cycle is 3% — but the driver is nearly out either way.
    expect(hosTone(1.5)).toBe('danger');
    expect(hosTone(3)).toBe('warning');
    expect(hosTone(6)).toBe('ok');
    expect(hosTone(60)).toBe('ok');
  });
});
