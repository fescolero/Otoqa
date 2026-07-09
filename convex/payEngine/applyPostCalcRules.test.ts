import { describe, it, expect } from 'vitest';
import { applyPostCalcRules, type ApplyPostCalcInput } from './applyPostCalcRules';
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
} from '../lib/money';

const COMP_WAGE = 'comp_wage';
const COMP_GUARANTEE = 'comp_guarantee_makeup';
const COMP_DEDUCT = 'comp_deduction';

function components(): Map<string, ChargeComponentLite> {
  return new Map<string, ChargeComponentLite>([
    [COMP_WAGE,      { _id: COMP_WAGE,      code: 'WAGE_MILEAGE',             bucket: 'BASE_WAGE',  sign: 'CREDIT' }],
    [COMP_GUARANTEE, { _id: COMP_GUARANTEE, code: 'MINIMUM_GUARANTEE_MAKEUP', bucket: 'BONUS',      sign: 'CREDIT' }],
    [COMP_DEDUCT,    { _id: COMP_DEDUCT,    code: 'TRUCK_LEASE',              bucket: 'DEDUCTION',  sign: 'DEBIT'  }],
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

describe('applyPostCalcRules: profile with no postCalcRules', () => {
  it('returns empty result', () => {
    const result = applyPostCalcRules(baseInput());
    expect(result.emittedPayItems).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});
