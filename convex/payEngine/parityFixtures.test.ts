// Cross-engine PARITY fixtures (Milestone 4).
//
// The 180 unit tests prove the new engine matches its own spec. These prove it
// matches the LEGACY engine's behavior for the rule types real production data
// never exercises (detention, stops, hazmat, percent, flat, caps) — so cutover
// isn't their first real test. We port the legacy per-rule math
// (driverPayCalculation.ts:evaluateRule) faithfully and run it head-to-head
// against the new calculatePay on synthetic scenarios.
import { describe, it, expect } from 'vitest';
import {
  calculatePay,
  type CalculatePayInput,
  type PayRule,
  type PayProfile,
  type ProfileAssignment,
  type ChargeComponentLite,
  type LegInput,
  type LoadInput,
  type StopInput,
} from './calculatePay';
import { microCentsFromDecimalString, centsFromDecimalString, centsToNumber, asCents, percentToMicroPctPoints, asMicroCents } from '../lib/money';

// ── faithful port of legacy driverPayCalculation.ts:evaluateRule ─────────────
type LegacyTrigger =
  | 'MILE_LOADED' | 'MILE_EMPTY' | 'TIME_DURATION' | 'TIME_WAITING'
  | 'COUNT_STOPS' | 'FLAT_LOAD' | 'FLAT_LEG' | 'ATTR_HAZMAT' | 'ATTR_TARP' | 'PCT_OF_LOAD';
interface LegacyCtx {
  legLoadedMiles?: number; legEmptyMiles?: number;
  durationHours?: number; // already rounded to 0.01 by calculateHourlyDuration
  dwellMinutesSum?: number; stopCount?: number;
  isHazmat?: boolean; requiresTarp?: boolean; invoiceTotal?: number;
}
function legacyAmount(trigger: LegacyTrigger, rate: number, ctx: LegacyCtx, opts: { minThreshold?: number; maxCap?: number } = {}): number {
  let qty = 0, amount = 0;
  switch (trigger) {
    case 'MILE_LOADED': qty = ctx.legLoadedMiles ?? 0; amount = qty * rate; break;
    case 'MILE_EMPTY': qty = ctx.legEmptyMiles ?? 0; amount = qty * rate; break;
    case 'TIME_DURATION': qty = ctx.durationHours ?? 0; amount = qty * rate; break; // hours pre-rounded
    case 'TIME_WAITING': qty = (ctx.dwellMinutesSum ?? 0) / 60; amount = qty * rate; break; // NOT rounded
    case 'COUNT_STOPS': qty = ctx.stopCount ?? 0; amount = qty * rate; break;
    case 'FLAT_LOAD': case 'FLAT_LEG': qty = 1; amount = rate; break;
    case 'ATTR_HAZMAT': if (ctx.isHazmat) { qty = 1; amount = rate; } break;
    case 'ATTR_TARP': if (ctx.requiresTarp) { qty = 1; amount = rate; } break;
    case 'PCT_OF_LOAD': if (ctx.invoiceTotal && ctx.invoiceTotal > 0) { qty = ctx.invoiceTotal; amount = qty * (rate / 100); } break;
  }
  if (opts.minThreshold && qty < opts.minThreshold) return 0;
  if (opts.maxCap && amount > opts.maxCap) amount = opts.maxCap; // legacy caps the AMOUNT
  return Math.round(amount * 100) / 100;
}

// ── new-engine harness ───────────────────────────────────────────────────────
const PROF = 'prof', D1 = 'd1', COMP = 'comp';
function components(): Map<string, ChargeComponentLite> {
  return new Map([[COMP, { _id: COMP, code: 'PAY', bucket: 'ACCESSORIAL', sign: 'CREDIT' }]]);
}
type RuleSpec = Pick<PayRule, 'trigger'> &
  Partial<Pick<PayRule, 'rateAmountMicroCents' | 'tieredRate' | 'minThreshold' | 'maxCap' | 'minAmountCents' | 'maxAmountCents' | 'equipmentTypeCondition' | 'customerCondition'>>;
function newAmount(rule: RuleSpec, opts: {
  legLoadedMiles?: number; legEmptyMiles?: number; stops?: StopInput[];
  isHazmat?: boolean; requiresTarp?: boolean; invoiceTotalCents?: ReturnType<typeof centsFromDecimalString>;
}): number {
  const leg: LegInput = { _id: 'leg', legLoadedMiles: opts.legLoadedMiles ?? 0, legEmptyMiles: opts.legEmptyMiles ?? 0, sequence: 1, payeeSplits: [{ payeeId: D1, splitBps: 10000 }] };
  const load: LoadInput = { _id: 'load', isHazmat: opts.isHazmat ?? false, requiresTarp: opts.requiresTarp ?? false, invoiceTotalCents: opts.invoiceTotalCents };
  const input: CalculatePayInput = {
    leg, load, stops: opts.stops ?? [], payeeType: 'DRIVER',
    profileAssignments: [{ payeeType: 'DRIVER', payeeId: D1, profileId: PROF, isDefault: true, selectionStrategy: 'ALWAYS_ACTIVE', isActive: true }],
    profiles: new Map<string, PayProfile>([[PROF, { _id: PROF, workosOrgId: 'o', name: 'p', payeeType: 'DRIVER', currency: 'USD', isActive: true }]]),
    rules: [{ _id: 'r', profileId: PROF, name: 'rule', componentId: COMP, isActive: true, sortOrder: 1, ...rule }],
    components: components(), periodAnchorAt: 0,
  };
  return calculatePay(input).payItems.reduce((s, p) => s + centsToNumber(p.amountCents), 0);
}
const rate = (d: string) => microCentsFromDecimalString(d, 'USD');
// stops carrying dwell minutes (for detention) — durationMinutes derives from check times
const dwellStops = (mins: number[]): StopInput[] => mins.map((m, i) => ({ sequence: i + 1, dwellTimeMinutes: m }));

describe('M4 cross-engine parity — rule types real data does not exercise', () => {
  it('MILE_LOADED: 137 mi @ $0.585 matches legacy', () => {
    const ctx = { legLoadedMiles: 137 };
    const leg = legacyAmount('MILE_LOADED', 0.585, ctx);
    const nw = newAmount({ trigger: { source: 'leg.legLoadedMiles' }, rateAmountMicroCents: rate('0.585') }, { legLoadedMiles: 137 });
    expect(nw).toBeCloseTo(leg, 2);
    expect(nw).toBeCloseTo(80.15, 2);
  });

  it('COUNT_STOPS: 4 stops @ $22.50 matches legacy', () => {
    const ctx = { stopCount: 4 };
    const leg = legacyAmount('COUNT_STOPS', 22.5, ctx);
    const nw = newAmount({ trigger: { source: 'stops.count' }, rateAmountMicroCents: rate('22.50') }, { stops: dwellStops([0, 0, 0, 0]) });
    expect(nw).toBeCloseTo(leg, 2); // $90.00
  });

  it('ATTR_HAZMAT: fires when hazmat, $0 when not — matches legacy', () => {
    const fires = newAmount({ trigger: { source: 'attr.hazmat' }, rateAmountMicroCents: rate('75.00') }, { isHazmat: true });
    expect(fires).toBeCloseTo(legacyAmount('ATTR_HAZMAT', 75, { isHazmat: true }), 2); // $75
    const off = newAmount({ trigger: { source: 'attr.hazmat' }, rateAmountMicroCents: rate('75.00') }, { isHazmat: false });
    expect(off).toBeCloseTo(legacyAmount('ATTR_HAZMAT', 75, { isHazmat: false }), 2); // $0
  });

  it('PCT_OF_LOAD: 28% of $4,612.50 matches legacy', () => {
    const invoice = 4612.5;
    const leg = legacyAmount('PCT_OF_LOAD', 28, { invoiceTotal: invoice });
    const nw = newAmount(
      { trigger: { source: 'load.invoiceTotalCents', transform: 'PERCENT' }, rateAmountMicroCents: asMicroCents(percentToMicroPctPoints(28)) },
      { invoiceTotalCents: centsFromDecimalString('4612.50', 'USD') },
    );
    expect(nw).toBeCloseTo(leg, 2); // $1,291.50
  });

  it('FLAT: $120 flat matches legacy', () => {
    const leg = legacyAmount('FLAT_LOAD', 120, {});
    const nw = newAmount({ trigger: { source: 'constant.1' }, rateAmountMicroCents: rate('120.00') }, {});
    expect(nw).toBeCloseTo(leg, 2);
  });

  it('DETENTION round dwell (90 min @ $40/h) matches legacy', () => {
    // 90/60 = 1.5h exactly — no rounding divergence
    const leg = legacyAmount('TIME_WAITING', 40, { dwellMinutesSum: 90 });
    const nw = newAmount({ trigger: { source: 'stops.dwellMinutesSum', transform: 'HOURS_FROM_MINUTES' }, rateAmountMicroCents: rate('40.00') }, { stops: dwellStops([90]) });
    expect(nw).toBeCloseTo(leg, 2); // $60.00
  });

  it('DOCUMENTED DIVERGENCE — detention non-round dwell: new rounds hours, legacy does not', () => {
    // 100/60 = 1.6667h. Legacy: 1.6667 × $40 = $66.67. New (rounds to 1.67h): 1.67 × $40 = $66.80.
    const leg = legacyAmount('TIME_WAITING', 40, { dwellMinutesSum: 100 });
    const nw = newAmount({ trigger: { source: 'stops.dwellMinutesSum', transform: 'HOURS_FROM_MINUTES' }, rateAmountMicroCents: rate('40.00') }, { stops: dwellStops([100]) });
    expect(leg).toBeCloseTo(66.67, 2);
    expect(nw).toBeCloseTo(66.8, 2);
    // The ~13¢ gap is the HOURS_FROM_MINUTES 0.01h rounding (correct for hourly,
    // matching legacy paySession; legacy detention happens not to round). Both
    // are defensible; flagged so cutover treats detention rounding as a decision.
    expect(Math.abs(nw - leg)).toBeLessThan(0.20);
  });

  it('CAP MAPPING — legacy maxCap (amount cap) maps to new maxAmountCents, NOT maxCap', () => {
    // 300 mi @ $0.55 = $165, legacy maxCap $150 → $150.
    const leg = legacyAmount('MILE_LOADED', 0.55, { legLoadedMiles: 300 }, { maxCap: 150 });
    expect(leg).toBeCloseTo(150, 2);
    // CORRECT mapping: legacy.maxCap → new.maxAmountCents (amount cap).
    const correct = newAmount({ trigger: { source: 'leg.legLoadedMiles' }, rateAmountMicroCents: rate('0.55'), maxAmountCents: centsFromDecimalString('150.00', 'USD') }, { legLoadedMiles: 300 });
    expect(correct).toBeCloseTo(150, 2); // parity ✓
    // WRONG mapping: legacy.maxCap → new.maxCap (quantity cap) would cap qty at
    // 150 mi → 150 × $0.55 = $82.50, diverging badly. Proven here so the rule
    // migrator uses maxAmountCents.
    const wrong = newAmount({ trigger: { source: 'leg.legLoadedMiles' }, rateAmountMicroCents: rate('0.55'), maxCap: 150 }, { legLoadedMiles: 300 });
    expect(wrong).toBeCloseTo(82.5, 2);
    expect(wrong).not.toBeCloseTo(leg, 2);
  });

  it('minThreshold: qty below floor → $0 on both engines', () => {
    const leg = legacyAmount('COUNT_STOPS', 20, { stopCount: 1 }, { minThreshold: 2 });
    expect(leg).toBe(0);
    const nw = newAmount({ trigger: { source: 'stops.count' }, rateAmountMicroCents: rate('20.00'), minThreshold: 2 }, { stops: dwellStops([0]) });
    expect(nw).toBeCloseTo(0, 2);
  });
});
