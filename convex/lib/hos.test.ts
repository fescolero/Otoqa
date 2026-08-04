import { describe, expect, it } from 'vitest';
import { estimateHos, hosChipLabel } from './hos';

const H = 3_600_000;
const NOW = 1_800_000_000_000;

describe('estimateHos', () => {
  it('active shift: on-duty hours + window remaining + live cycle', () => {
    const h = estimateHos([{ startedAt: NOW - 6 * H, status: 'active' }], NOW);
    expect(h.onShift).toBe(true);
    expect(h.onDutyHours).toBe(6);
    expect(h.windowRemainingHours).toBe(8);
    expect(h.cycleUsedHours).toBe(6);
    expect(h.cycleRemainingHours).toBe(64);
    expect(hosChipLabel(h)).toBe('On shift 6h · ~8h window left (est)');
  });

  it('window clamps at zero past 14 hours', () => {
    const h = estimateHos([{ startedAt: NOW - 16 * H, status: 'active' }], NOW);
    expect(h.windowRemainingHours).toBe(0);
  });

  it('cycle sums completed sessions in the 8-day window, prefers totalActiveMinutes', () => {
    const h = estimateHos(
      [
        // 10h wall clock but 9h active — active minutes win.
        { startedAt: NOW - 2 * 24 * H, endedAt: NOW - 2 * 24 * H + 10 * H, totalActiveMinutes: 9 * 60, status: 'completed' },
        // Ended before the 8-day cutoff — excluded.
        { startedAt: NOW - 10 * 24 * H, endedAt: NOW - 9 * 24 * H, totalActiveMinutes: 8 * 60, status: 'completed' },
        // No totalActiveMinutes — wall time fallback (5h).
        { startedAt: NOW - 24 * H, endedAt: NOW - 24 * H + 5 * H, status: 'completed' },
        { startedAt: NOW - 2 * H, status: 'active' },
      ],
      NOW,
    );
    expect(h.cycleUsedHours).toBe(16); // 9 + 5 + 2
    expect(h.cycleRemainingHours).toBe(54);
  });

  it('off duty: reset detection at 10 hours', () => {
    const resting = estimateHos(
      [{ startedAt: NOW - 20 * H, endedAt: NOW - 8 * H, totalActiveMinutes: 12 * 60, status: 'completed' }],
      NOW,
    );
    expect(resting.onShift).toBe(false);
    expect(resting.offDutyHours).toBe(8);
    expect(resting.restReset).toBe(false);
    expect(hosChipLabel(resting)).toBe('Off duty 8h · reset at 10h (est)');

    const rested = estimateHos(
      [{ startedAt: NOW - 30 * H, endedAt: NOW - 12 * H, totalActiveMinutes: 11 * 60, status: 'completed' }],
      NOW,
    );
    expect(rested.restReset).toBe(true);
    expect(hosChipLabel(rested)).toBe('Off duty 12h · rested (est)');
  });

  it('no sessions at all', () => {
    const h = estimateHos([], NOW);
    expect(h.onShift).toBe(false);
    expect(h.offDutyHours).toBeNull();
    expect(h.cycleUsedHours).toBe(0);
    expect(hosChipLabel(h)).toBe('No recent shifts');
  });
});
