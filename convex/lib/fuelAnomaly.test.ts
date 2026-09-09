import { describe, it, expect } from 'vitest';
import { assessPrices, isTotalMismatch, PRICE_ANOMALY, type AnomalyInput } from './fuelAnomaly';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

function fill(
  id: string,
  day: number,
  ppg: number,
  extra: Partial<AnomalyInput> = {},
): AnomalyInput {
  return {
    id,
    product: 'DIESEL',
    entryDate: T0 + day * DAY,
    pricePerGallon: ppg,
    gallons: 100,
    totalCost: ppg * 100,
    ...extra,
  };
}

describe('assessPrices', () => {
  it('does not flag a rising market: each fill is judged against nearby fills', () => {
    // Diesel climbs 10¢ a day for a month. The old whole-range rule would
    // flag the entire back half; the rolling window flags nothing.
    const rows = Array.from({ length: 30 }, (_, d) => fill(`d${d}`, d, 6.0 + d * 0.1));
    const out = assessPrices(rows);
    expect([...out.values()].filter((a) => a.flagged)).toHaveLength(0);
    expect(out.get('d15')?.tier).toBe('fleet');
  });

  it('flags a fill well above its nearby peers and reports the delta', () => {
    const rows = [
      fill('a', 0, 4.0), fill('b', 1, 4.02), fill('c', 2, 3.98), fill('d', 3, 4.01),
      fill('x', 2, 4.6), // 60¢ over the ~$4.00 median
    ];
    const out = assessPrices(rows);
    const x = out.get('x')!;
    expect(x.flagged).toBe(true);
    expect(x.tier).toBe('fleet');
    expect(x.benchmark).toBeCloseTo(4.005, 3);
    expect(x.delta).toBeCloseTo(0.595, 3);
    expect(out.get('a')?.flagged).toBe(false);
  });

  it('uses the larger of the floor and the percentage', () => {
    // At $4, 5% = 20¢ < 25¢ floor → floor rules: +24¢ passes, +26¢ flags.
    const cheap = [fill('a', 0, 4), fill('b', 0, 4), fill('c', 0, 4), fill('p', 1, 4.24), fill('q', 1, 4.26)];
    const o1 = assessPrices(cheap);
    expect(o1.get('p')?.flagged).toBe(false);
    expect(o1.get('q')?.flagged).toBe(true);
    // At $8, 5% = 40¢ > floor → pct rules: +39¢ passes, +41¢ flags.
    const dear = [fill('a', 0, 8), fill('b', 0, 8), fill('c', 0, 8), fill('p', 1, 8.39), fill('q', 1, 8.41)];
    const o2 = assessPrices(dear);
    expect(o2.get('p')?.flagged).toBe(false);
    expect(o2.get('q')?.flagged).toBe(true);
  });

  it('prefers same-state peers when there are enough, else the fleet', () => {
    const ca = (id: string, day: number, ppg: number) => fill(id, day, ppg, { state: 'CA' });
    const tx = (id: string, day: number, ppg: number) => fill(id, day, ppg, { state: 'tx ' });
    const rows = [
      ca('c1', 0, 7.0), ca('c2', 1, 7.05), ca('c3', 2, 6.95),
      tx('t1', 0, 5.5), tx('t2', 1, 5.55), tx('t3', 2, 5.45),
      ca('probe', 1, 7.1),  // normal for CA; would look wild vs TX
      tx('lone', 1, 5.6),   // normal for TX
    ];
    const out = assessPrices(rows);
    expect(out.get('probe')?.tier).toBe('state');
    expect(out.get('probe')?.flagged).toBe(false);
    expect(out.get('lone')?.tier).toBe('state');
    expect(out.get('lone')?.flagged).toBe(false);

    // Only two CA peers → fall back to the fleet.
    const sparse = [ca('c1', 0, 7.0), ca('c2', 1, 7.05), tx('t1', 0, 7.0), tx('t2', 1, 7.0), ca('probe', 1, 7.1)];
    expect(assessPrices(sparse).get('probe')?.tier).toBe('fleet');
  });

  it('falls back to the whole range when the window is too thin, and to none when alone', () => {
    const rows = [fill('a', 0, 4), fill('b', 20, 4), fill('c', 40, 4), fill('x', 60, 4.5)];
    const out = assessPrices(rows);
    expect(out.get('x')?.tier).toBe('range');
    expect(out.get('x')?.flagged).toBe(true);
    const alone = assessPrices([fill('only', 0, 9.99)]);
    expect(alone.get('only')).toMatchObject({ tier: 'none', benchmark: null, flagged: false });
  });

  it('ignores a single wild entry when benchmarking its neighbours', () => {
    const rows = [fill('a', 0, 4), fill('b', 0, 4.02), fill('c', 1, 3.99), fill('bad', 1, 70), fill('p', 1, 4.1)];
    const out = assessPrices(rows);
    expect(out.get('p')?.flagged).toBe(false);
    expect(out.get('p')?.benchmark).toBeCloseTo(4.01, 2);
    expect(out.get('bad')?.flagged).toBe(true);
  });

  it('never compares across products', () => {
    const rows = [
      fill('d1', 0, 7), fill('d2', 0, 7), fill('d3', 0, 7),
      fill('def', 0, 3.2, { product: 'DEF' }),
    ];
    const out = assessPrices(rows);
    expect(out.get('def')?.tier).toBe('none');
    expect(out.get('def')?.flagged).toBe(false);
  });

  it('exposes its defaults', () => {
    expect(PRICE_ANOMALY.windowDays).toBe(3);
    expect(PRICE_ANOMALY.minPeers).toBe(3);
  });
});

describe('isTotalMismatch', () => {
  it('accepts rounding noise and rejects real disagreement', () => {
    expect(isTotalMismatch({ pricePerGallon: 4.129, gallons: 100.3, totalCost: 414.14 })).toBe(false);
    expect(isTotalMismatch({ pricePerGallon: 4.129, gallons: 100.3, totalCost: 419.14 })).toBe(true);
    // Large totals get a proportional tolerance.
    expect(isTotalMismatch({ pricePerGallon: 4, gallons: 5000, totalCost: 20_060 })).toBe(false);
  });
});
