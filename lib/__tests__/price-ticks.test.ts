import { describe, it, expect } from 'vitest';
import { nicePriceTicks } from '@/lib/charts/price-ticks';

describe('nicePriceTicks', () => {
  it('pads a typical diesel band to clean 50¢ steps', () => {
    expect(nicePriceTicks(6.55, 7.46)).toEqual([6, 6.5, 7, 7.5, 8]);
  });

  it('gives a flat price a visible range', () => {
    expect(nicePriceTicks(4, 4)).toEqual([3.75, 4, 4.25]);
  });

  it('never drops below $0', () => {
    const ticks = nicePriceTicks(0.05, 0.4);
    expect(ticks[0]).toBe(0);
  });

  it('caps at five ticks for any range, including absurd ones', () => {
    const ranges: Array<[number, number]> = [
      [2, 8], [2, 16], [2, 40], [2, 700], [1, 5000], [3.999, 4.001], [0, 0],
    ];
    for (const [min, max] of ranges) {
      const ticks = nicePriceTicks(min, max);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(5);
      expect(ticks[0]).toBeLessThanOrEqual(min);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(max);
      // Evenly spaced.
      const step = ticks[1] - ticks[0];
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i] - ticks[i - 1]).toBeCloseTo(step, 6);
      }
    }
  });

  it('tolerates swapped and non-finite input', () => {
    expect(nicePriceTicks(7.46, 6.55)).toEqual([6, 6.5, 7, 7.5, 8]);
    expect(nicePriceTicks(Number.NaN, 5)).toEqual([0, 1]);
  });
});
