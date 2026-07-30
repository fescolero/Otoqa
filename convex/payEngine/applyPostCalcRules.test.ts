import { describe, it, expect } from 'vitest';
import {
  applyPostCalcRules,
  CAP_OFFSET_COMPONENT_CODE,
  type ApplyPostCalcInput,
} from './applyPostCalcRules';
import type {
  ChargeComponentLite,
  PayItemSpec,
  PayProfile,
  PostCalcRule,
} from './calculatePay';
import {
  asCents,
  asMicroCents,
  centsFromDecimalString,
  centsToDecimalString,
  microCentsFromDecimalString,
  multiplyRateByQuantity,
} from '../lib/money';

const COMP_WAGE = 'comp_wage';
const COMP_GUARANTEE = 'comp_guarantee_makeup';
const COMP_DEDUCT = 'comp_deduction';
const COMP_HW = 'comp_hw';
const COMP_CAP_OFFSET = 'comp_cap_offset';

function components(): Map<string, ChargeComponentLite> {
  return new Map<string, ChargeComponentLite>([
    [COMP_WAGE,       { _id: COMP_WAGE,       code: 'WAGE_MILEAGE',             bucket: 'BASE_WAGE',   sign: 'CREDIT' }],
    [COMP_GUARANTEE,  { _id: COMP_GUARANTEE,  code: 'MINIMUM_GUARANTEE_MAKEUP', bucket: 'BONUS',       sign: 'CREDIT' }],
    [COMP_DEDUCT,     { _id: COMP_DEDUCT,     code: 'TRUCK_LEASE',              bucket: 'DEDUCTION',   sign: 'DEBIT'  }],
    [COMP_HW,         { _id: COMP_HW,         code: 'HEALTH_WELFARE',           bucket: 'BASE_FRINGE', sign: 'CREDIT' }],
    [COMP_CAP_OFFSET, { _id: COMP_CAP_OFFSET, code: CAP_OFFSET_COMPONENT_CODE,  bucket: 'DEDUCTION',   sign: 'DEBIT'  }],
  ]);
}

function payItem(amount: string, sign: 'CREDIT' | 'DEBIT' = 'CREDIT', componentId = COMP_WAGE): PayItemSpec {
  return {
    payeeType: 'DRIVER',
    payeeId: 'drv1',
    kind: 'EARNING',
    componentId,
    componentCode: 'X',
    componentBucket: 'BASE_WAGE',
    componentSign: sign,
    lifecycleStatus: 'APPLIED',
    description: 'test',
    quantity: 1,
    rateMicroCents: asMicroCents(BigInt(0)),
    amountCents: centsFromDecimalString(amount, 'USD'),
    currency: 'USD',
    periodAnchorAt: 0,
    sourceRef: { kind: 'RATE_RULE', id: 'x', loadId: 'l', legId: 'lg' },
    sourceData: { _variant: 'EARNING', ruleId: 'x', profileIdSnapshot: 'p', triggerSnapshot: '{}' },
    isLocked: false,
    isVoided: false,
  };
}

function profile(postCalcRules: PostCalcRule[]): PayProfile {
  return {
    _id: 'prof_test',
    workosOrgId: 'org_test',
    name: 'Test Profile',
    payeeType: 'DRIVER',
    currency: 'USD',
    postCalcRules,
    isActive: true,
  };
}

function baseInput(over: Partial<ApplyPostCalcInput> = {}): ApplyPostCalcInput {
  return {
    payeeType: 'DRIVER',
    payeeId: 'drv1',
    periodStart: 0,
    periodEnd: 7 * 24 * 60 * 60 * 1000,
    profile: profile([]),
    payItems: [],
    components: components(),
    ...over,
  };
}

describe('applyPostCalcRules: MINIMUM_GUARANTEE_PERIOD', () => {
  it('emits no makeup when net already meets guarantee', () => {
    const rule: PostCalcRule = {
      name: 'Weekly minimum $1,500',
      kind: 'MINIMUM_GUARANTEE_PERIOD',
      componentId: COMP_GUARANTEE,
      thresholdCents: centsFromDecimalString('1500.00', 'USD'),
      sortOrder: 1,
    };
    const result = applyPostCalcRules(baseInput({
      profile: profile([rule]),
      payItems: [payItem('1600.00')],
    }));
    expect(result.emittedPayItems).toEqual([]);
  });

  it('emits a makeup payItem when net falls short', () => {
    const rule: PostCalcRule = {
      name: 'Weekly minimum $1,500',
      kind: 'MINIMUM_GUARANTEE_PERIOD',
      componentId: COMP_GUARANTEE,
      thresholdCents: centsFromDecimalString('1500.00', 'USD'),
      sortOrder: 1,
    };
    const result = applyPostCalcRules(baseInput({
      profile: profile([rule]),
      payItems: [payItem('1200.00')],
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('300.00');
    expect(result.emittedPayItems[0].componentCode).toBe('MINIMUM_GUARANTEE_MAKEUP');
    expect(result.emittedPayItems[0].componentBucket).toBe('BONUS');
  });

  it('accounts for deductions when computing net', () => {
    const rule: PostCalcRule = {
      name: 'Weekly minimum $1,500',
      kind: 'MINIMUM_GUARANTEE_PERIOD',
      componentId: COMP_GUARANTEE,
      thresholdCents: centsFromDecimalString('1500.00', 'USD'),
      sortOrder: 1,
    };
    // Gross 1500, lease deduction 400 → net 1100 → makeup 400
    const result = applyPostCalcRules(baseInput({
      profile: profile([rule]),
      payItems: [
        payItem('1500.00', 'CREDIT'),
        payItem('400.00', 'DEBIT', COMP_DEDUCT),
      ],
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('400.00');
  });

  it('handles zero earnings (full guarantee owed)', () => {
    const rule: PostCalcRule = {
      name: 'Weekly minimum $1,500',
      kind: 'MINIMUM_GUARANTEE_PERIOD',
      componentId: COMP_GUARANTEE,
      thresholdCents: centsFromDecimalString('1500.00', 'USD'),
      sortOrder: 1,
    };
    const result = applyPostCalcRules(baseInput({
      profile: profile([rule]),
      payItems: [],
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('1500.00');
  });

  it('skips when threshold not set', () => {
    const rule: PostCalcRule = {
      name: 'Broken — no threshold',
      kind: 'MINIMUM_GUARANTEE_PERIOD',
      componentId: COMP_GUARANTEE,
      sortOrder: 1,
    };
    const result = applyPostCalcRules(baseInput({
      profile: profile([rule]),
      payItems: [],
    }));
    expect(result.emittedPayItems).toEqual([]);
  });
});

describe('applyPostCalcRules: unimplemented kinds warn loudly', () => {
  it.each([
    'MINIMUM_GUARANTEE_DAILY',
    'MAXIMUM_CAP_PERIOD',
    'OVERTIME_PREMIUM',
    'SHIFT_DIFFERENTIAL',
  ] as const)('%s: emits a WARNING (not silently miscalculates)', (kind) => {
    const rule: PostCalcRule = {
      name: `Test ${kind}`,
      kind,
      componentId: COMP_GUARANTEE,
      sortOrder: 1,
    };
    const result = applyPostCalcRules(baseInput({ profile: profile([rule]) }));
    expect(result.emittedPayItems).toEqual([]);
    expect(result.warnings.some(w => w.code === 'POST_CALC_KIND_UNIMPLEMENTED')).toBe(true);
  });
});

// ── MAXIMUM_CAP_WEEKLY ──────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

/** An hourly EARNING line: `hours` at `$rate/hr`, anchored `day` days into the period. */
function hoursItem(hours: number, rate: string, day: number, componentId = COMP_HW): PayItemSpec {
  const rateMicroCents = microCentsFromDecimalString(rate, 'USD');
  return {
    ...payItem('0.00', 'CREDIT', componentId),
    quantity: hours,
    rateMicroCents,
    amountCents: multiplyRateByQuantity(rateMicroCents, hours),
    periodAnchorAt: day * DAY,
  };
}

function capRule(thresholdQty: number | undefined, componentId = COMP_HW): PostCalcRule {
  return {
    name: 'H&W weekly cap',
    kind: 'MAXIMUM_CAP_WEEKLY',
    componentId,
    thresholdQty,
    sortOrder: 1,
  };
}

describe('applyPostCalcRules: MAXIMUM_CAP_WEEKLY', () => {
  it('emits nothing when weekly hours stay under the cap', () => {
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(40)]),
      payItems: [hoursItem(20, '5.55', 0), hoursItem(19.5, '5.55', 3)],
    }));
    expect(result.emittedPayItems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('offsets the hours over the cap at the lines’ rate', () => {
    // 30 h + 20 h = 50 h in week 1 → 10 h over @ $5.55 = $55.50
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(40)]),
      payItems: [hoursItem(30, '5.55', 0), hoursItem(20, '5.55', 2)],
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    const offset = result.emittedPayItems[0];
    expect(centsToDecimalString(offset.amountCents)).toBe('55.50');
    expect(offset.quantity).toBe(10);
    expect(offset.componentCode).toBe(CAP_OFFSET_COMPONENT_CODE);
    expect(offset.componentBucket).toBe('DEDUCTION');
    expect(offset.componentSign).toBe('DEBIT');
    expect(offset.kind).toBe('POST_CALC_ADJUSTMENT');
    expect(offset.description).toContain('10.00 h over 40 h');
    expect(offset.sourceRef.kind).toBe('POST_CALC_RULE');
    expect(offset.sourceRef.id).toBe('postcalc:prof_test:H&W weekly cap:w0');
  });

  it('attributes overage chronologically — later hours are the capped ones', () => {
    // 30 h @ $5 first, then 20 h @ $6 → the 10 over-cap hours are all from
    // the later $6 line: $60.00 (not blended).
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(40)]),
      payItems: [hoursItem(20, '6.00', 4), hoursItem(30, '5.00', 1)], // order-independent: sorted by anchor
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('60.00');
  });

  it('caps only the portion of a line past the threshold', () => {
    // 38 h @ $5, then 6 h @ $6 — the cumulative total passes 40 two hours into
    // the second line, so 4 of its 6 hours are over-cap @ $6 = $24.00.
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(40)]),
      payItems: [hoursItem(38, '5.00', 1), hoursItem(6, '6.00', 4)],
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    expect(result.emittedPayItems[0].quantity).toBe(4);
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('24.00');
  });

  it('buckets weeks independently from periodStart', () => {
    // Week 1 (days 0–6): 45 h → 5 h over. Week 2 (days 7–13): 38 h → clean.
    const result = applyPostCalcRules(baseInput({
      periodEnd: 14 * DAY,
      profile: profile([capRule(40)]),
      payItems: [
        hoursItem(25, '5.55', 0), hoursItem(20, '5.55', 5),  // wk 1 = 45 h
        hoursItem(20, '5.55', 8), hoursItem(18, '5.55', 12), // wk 2 = 38 h
      ],
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    expect(result.emittedPayItems[0].quantity).toBe(5);
    expect(result.emittedPayItems[0].description).toContain('week 1');
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('27.75');
  });

  it('emits one offset per over-cap week', () => {
    const result = applyPostCalcRules(baseInput({
      periodEnd: 14 * DAY,
      profile: profile([capRule(40)]),
      payItems: [hoursItem(50, '5.00', 1), hoursItem(42, '5.00', 9)],
    }));
    expect(result.emittedPayItems).toHaveLength(2);
    expect(result.emittedPayItems[0].sourceRef.id).toBe('postcalc:prof_test:H&W weekly cap:w0');
    expect(result.emittedPayItems[1].sourceRef.id).toBe('postcalc:prof_test:H&W weekly cap:w1');
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('50.00');
    expect(centsToDecimalString(result.emittedPayItems[1].amountCents)).toBe('10.00');
    // Anchors stay inside the period window so re-aggregation finds the rows.
    expect(result.emittedPayItems[0].periodAnchorAt).toBe(7 * DAY - 1);
    expect(result.emittedPayItems[1].periodAnchorAt).toBe(14 * DAY - 1);
  });

  it('ignores other components and non-EARNING kinds', () => {
    const deduction = { ...payItem('100.00', 'DEBIT', COMP_DEDUCT), quantity: 50 };
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(40)]),
      payItems: [hoursItem(45, '22.00', 1, COMP_WAGE), deduction, hoursItem(10, '5.55', 2)],
    }));
    expect(result.emittedPayItems).toEqual([]); // only 10 H&W hours — under cap
  });

  it('pro-rates zero-rate lines by amount', () => {
    // A 45 h line with no rate but a $90 amount → 5 over-cap hours = 1/9 → $10.
    const flat: PayItemSpec = {
      ...payItem('90.00', 'CREDIT', COMP_HW),
      quantity: 45,
      periodAnchorAt: DAY,
    };
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(40)]),
      payItems: [flat],
    }));
    expect(result.emittedPayItems).toHaveLength(1);
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('10.00');
  });

  it('warns and emits nothing without a positive thresholdQty', () => {
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(undefined)]),
      payItems: [hoursItem(50, '5.55', 1)],
    }));
    expect(result.emittedPayItems).toEqual([]);
    expect(result.warnings.some(w => w.code === 'POST_CALC_RULE_MISCONFIGURED')).toBe(true);
  });

  it('flags loudly when the offset component is missing from the org', () => {
    const comps = components();
    comps.delete(COMP_CAP_OFFSET);
    const result = applyPostCalcRules(baseInput({
      components: comps,
      profile: profile([capRule(40)]),
      payItems: [hoursItem(50, '5.55', 1)],
    }));
    expect(result.emittedPayItems).toEqual([]);
    expect(result.warnings.some(w => w.code === 'POST_CALC_OFFSET_COMPONENT_MISSING')).toBe(true);
  });

  it('a later minimum guarantee sees the cap offset (rule chaining)', () => {
    // 50 h @ $10 = $500 earned; cap offsets 10 h = $100 → net $400.
    // Guarantee of $450 evaluated AFTER the cap must make up $50, not $0.
    const guarantee: PostCalcRule = {
      name: 'Weekly minimum $450',
      kind: 'MINIMUM_GUARANTEE_PERIOD',
      componentId: COMP_GUARANTEE,
      thresholdCents: centsFromDecimalString('450.00', 'USD'),
      sortOrder: 2,
    };
    const result = applyPostCalcRules(baseInput({
      profile: profile([capRule(40), guarantee]),
      payItems: [hoursItem(50, '10.00', 1)],
    }));
    expect(result.emittedPayItems).toHaveLength(2);
    expect(centsToDecimalString(result.emittedPayItems[0].amountCents)).toBe('100.00');
    expect(centsToDecimalString(result.emittedPayItems[1].amountCents)).toBe('50.00');
  });
});

describe('applyPostCalcRules: profile with no postCalcRules', () => {
  it('returns empty result', () => {
    const result = applyPostCalcRules(baseInput());
    expect(result.emittedPayItems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
