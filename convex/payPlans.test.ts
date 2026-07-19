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

describe('calculateCurrentPeriod — BIWEEKLY anchor (UTC)', () => {
  const anchor = '2026-01-03'; // a Saturday
  const anchorMs = Date.UTC(2026, 0, 3);

  it('counts 14-day cycles forward from the explicit anchor', () => {
    const ref = new Date(Date.UTC(2026, 6, 18, 12)); // Jul 18, 2026
    const { periodStart, periodEnd, payDate } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: anchor, paymentLagDays: 5 }),
      ref,
      'UTC',
    );
    // Start is anchor + k×14 days, contains the reference date, and keeps
    // the anchor's weekday (Saturday).
    const offsetDays = Math.round((periodStart.getTime() - anchorMs) / DAY);
    expect(offsetDays % 14).toBe(0);
    expect(periodStart.getTime()).toBeLessThanOrEqual(ref.getTime());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(ref.getTime());
    expect(periodStart.getUTCDay()).toBe(6);
    // 14-day span, pay date lags the close by paymentLagDays.
    expect(Math.round((periodEnd.getTime() + 1 - periodStart.getTime()) / DAY)).toBe(14);
    expect(Math.round((payDate.getTime() - (periodEnd.getTime() + 1)) / DAY)).toBe(5);
  });

  it('moving the anchor by one week flips the on-week', () => {
    const ref = new Date(Date.UTC(2026, 6, 18, 12));
    const a = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-01-03' }), ref, 'UTC',
    ).periodStart.getTime();
    const b = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-01-10' }), ref, 'UTC',
    ).periodStart.getTime();
    expect(Math.abs(Math.round((a - b) / DAY))).toBe(7);
  });

  it('a reference before the anchor resolves to the anchor period itself', () => {
    const { periodStart } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-09-05' }),
      new Date(Date.UTC(2026, 6, 18)),
      'UTC',
    );
    expect(periodStart.getTime()).toBe(Date.UTC(2026, 8, 5));
  });

  it('without an anchor, falls back to the legacy fixed-anchor math (existing plans keep their boundaries)', () => {
    const ref = new Date(Date.UTC(2026, 6, 18, 12));
    const { periodStart, periodEnd } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', periodStartDayOfWeek: 'MONDAY' }),
      ref,
      'UTC',
    );
    expect(periodStart.getUTCDay()).toBe(1); // Monday
    expect(periodStart.getTime()).toBeLessThanOrEqual(ref.getTime());
    expect(periodEnd.getTime()).toBeGreaterThanOrEqual(ref.getTime());
    // Legacy anchor: whole 2-week multiples from Jan 1, 2024 (a Monday).
    const legacyAnchor = Date.UTC(2024, 0, 1);
    const offsetDays = Math.round((periodStart.getTime() - legacyAnchor) / DAY);
    expect(offsetDays % 14).toBe(0);
  });
});

describe('calculateCurrentPeriod — org/plan timezone boundaries', () => {
  it('anchors the period at LOCAL midnight in the plan timezone (America/New_York)', () => {
    const { periodStart, periodEnd } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-07-15', timezone: 'America/New_York' }),
      new Date(Date.UTC(2026, 6, 19, 12)),
    );
    // Midnight Jul 15 EDT = 04:00 UTC — NOT midnight UTC.
    expect(periodStart.getTime()).toBe(Date.UTC(2026, 6, 15, 4));
    // Exactly 14 days (no DST transition in July–August).
    expect(periodEnd.getTime() + 1 - periodStart.getTime()).toBe(14 * DAY);
  });

  it('explicit timezone param overrides the plan field (org-resolved zone wins)', () => {
    const { periodStart } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-07-15' }),
      new Date(Date.UTC(2026, 6, 19, 12)),
      'America/Los_Angeles',
    );
    // Midnight Jul 15 PDT = 07:00 UTC.
    expect(periodStart.getTime()).toBe(Date.UTC(2026, 6, 15, 7));
  });

  it('weekly boundaries land on the configured weekday in the plan timezone', () => {
    const { periodStart, periodEnd } = calculateCurrentPeriod(
      plan({ frequency: 'WEEKLY', periodStartDayOfWeek: 'SUNDAY', timezone: 'America/Los_Angeles' }),
      new Date(Date.UTC(2026, 6, 19, 12)), // Sun Jul 19, 05:00 PDT
    );
    // Sunday Jul 19 midnight PDT = 07:00 UTC.
    expect(periodStart.getTime()).toBe(Date.UTC(2026, 6, 19, 7));
    expect(periodEnd.getTime() + 1 - periodStart.getTime()).toBe(7 * DAY);
  });

  it('stays correct across a DST transition (Nov 1, 2026 fall-back)', () => {
    const { periodStart, periodEnd } = calculateCurrentPeriod(
      plan({ frequency: 'BIWEEKLY', biweeklyAnchor: '2026-10-28', timezone: 'America/New_York' }),
      new Date(Date.UTC(2026, 10, 3, 12)), // Nov 3 — after the Nov 1 fall-back
    );
    // Start: midnight Oct 28 EDT (UTC-4). End boundary: midnight Nov 11
    // EST (UTC-5) — the period is 14 calendar days, 14d + 1h of real time.
    expect(periodStart.getTime()).toBe(Date.UTC(2026, 9, 28, 4));
    expect(periodEnd.getTime() + 1).toBe(Date.UTC(2026, 10, 11, 5));
  });
});

describe('calculateCurrentPeriod — MONTHLY custom start day (UTC)', () => {
  it('day 15 runs the 15th → 14th of the next month', () => {
    const { periodStart, periodEnd } = calculateCurrentPeriod(
      plan({ frequency: 'MONTHLY', periodStartDayOfMonth: 15 }),
      new Date(Date.UTC(2026, 6, 18)), // Jul 18 → period Jul 15 – Aug 14
      'UTC',
    );
    expect(periodStart.getTime()).toBe(Date.UTC(2026, 6, 15));
    expect(periodEnd.getUTCDate()).toBe(14);
    expect(periodEnd.getUTCMonth()).toBe(7); // August
  });
});
