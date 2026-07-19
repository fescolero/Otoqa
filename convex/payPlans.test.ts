import { describe, it, expect } from 'vitest';
import { calculateCurrentPeriod } from './payPlans';
import type { Doc } from './_generated/dataModel';

// calculateCurrentPeriod is pure — a partial plan doc is enough.
function plan(o: Partial<Doc<'payPlans'>>): Doc<'payPlans'> {
  return {
    workosOrgId: 'org_test',
    name: 'Test',
    frequency: 'WEEKLY',
    cutoffTime: '17:00',
    paymentLagDays: 5,
    payableTrigger: 'DELIVERY_DATE',
    autoCarryover: true,
    includeStandaloneAdjustments: true,
    isActive: true,
    createdAt: 0,
    createdBy: 'test',
    ...o,
  } as Doc<'payPlans'>;
}

const DAY = 24 * 60 * 60 * 1000;

describe('calculateCurrentPeriod — BIWEEKLY anchor', () => {
  const anchor = '2026-01-03'; // a Saturday
  const anchorMs = new Date(2026, 0, 3).getTime();

  it('counts 14-day cycles forward from the explicit anchor', () => {
    const ref = new Date(2026, 6, 18); // Jul 18, 2026
    const { periodStart, periodEnd, payDate } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: anchor, paymentLagDays: 5 }),
      ref,
    );
    // Start is anchor + k×14 days, contains the reference date, and keeps
    // the anchor's weekday (Saturday).
    const offsetDays = Math.round((periodStart.getTime() - anchorMs) / DAY);
    expect(offsetDays % 14).toBe(0);
    expect(periodStart.getTime()).toBeLessThanOrEqual(ref.getTime());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(ref.getTime());
    expect(periodStart.getDay()).toBe(6);
    // 14-day span, pay date lags the close by paymentLagDays.
    expect(Math.round((periodEnd.getTime() + 1 - periodStart.getTime()) / DAY)).toBe(14);
    expect(Math.round((payDate.getTime() - (periodEnd.getTime() + 1)) / DAY)).toBe(5);
  });

  it('moving the anchor by one week flips the on-week', () => {
    const ref = new Date(2026, 6, 18);
    const a = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-01-03' }), ref,
    ).periodStart.getTime();
    const b = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-01-10' }), ref,
    ).periodStart.getTime();
    expect(Math.abs(Math.round((a - b) / DAY))).toBe(7);
  });

  it('a reference before the anchor resolves to the anchor period itself', () => {
    const { periodStart } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-09-05' }),
      new Date(2026, 6, 18),
    );
    expect(periodStart.getTime()).toBe(new Date(2026, 8, 5).getTime());
  });

  it('without an anchor, falls back to the legacy fixed-anchor math (existing plans keep their boundaries)', () => {
    const ref = new Date(2026, 6, 18);
    const { periodStart, periodEnd } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', periodStartDayOfWeek: 'MONDAY' }),
      ref,
    );
    expect(periodStart.getDay()).toBe(1); // Monday
    expect(periodStart.getTime()).toBeLessThanOrEqual(ref.getTime());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(ref.getTime());
    // Legacy anchor: whole 2-week multiples from Jan 1, 2024 (a Monday).
    const legacyAnchor = new Date(2024, 0, 1).getTime();
    const offsetDays = Math.round((periodStart.getTime() - legacyAnchor) / DAY);
    expect(offsetDays % 14).toBe(0);
  });
});

describe('calculateCurrentPeriod — MONTHLY custom start day', () => {
  it('day 15 runs the 15th → 14th of the next month', () => {
    const { periodStart, periodEnd } = calculateCurrentPeriod(
      plan({ frequency: 'MONTHLY', periodStartDayOfMonth: 15 }),
      new Date(2026, 6, 18), // Jul 18 → period Jul 15 – Aug 14
    );
    expect(periodStart.getTime()).toBe(new Date(2026, 6, 15).getTime());
    expect(periodEnd.getDate()).toBe(14);
    expect(periodEnd.getMonth()).toBe(7); // August
  });
});
