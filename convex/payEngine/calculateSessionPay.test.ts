import { describe, it, expect } from 'vitest';
import {
  calculateSessionPay,
  calculatePay,
  type CalculateSessionPayInput,
  type CalculatePayInput,
  type PayRule,
  type PayProfile,
  type ProfileAssignment,
  type ChargeComponentLite,
} from './calculatePay';
import { microCentsFromDecimalString, centsFromDecimalString, centsToNumber } from '../lib/money';

const PROF = 'prof_std';
const D1 = 'driver_1';
const COMP_HR = 'comp_hr';
const COMP_MI = 'comp_mi';
const T = Date.UTC(2026, 0, 15, 6, 0); // shift start

function components(): Map<string, ChargeComponentLite> {
  return new Map<string, ChargeComponentLite>([
    [COMP_HR, { _id: COMP_HR, code: 'WAGE_HOURLY', bucket: 'BASE_WAGE', sign: 'CREDIT' }],
    [COMP_MI, { _id: COMP_MI, code: 'WAGE_MILEAGE', bucket: 'BASE_WAGE', sign: 'CREDIT' }],
  ]);
}
function profile(): PayProfile {
  return { _id: PROF, workosOrgId: 'org_test', name: 'Std', payeeType: 'DRIVER', currency: 'USD', isActive: true };
}
function assignment(o: Partial<ProfileAssignment> = {}): ProfileAssignment {
  return { payeeType: 'DRIVER', payeeId: D1, profileId: PROF, isDefault: true, selectionStrategy: 'ALWAYS_ACTIVE', isActive: true, ...o };
}
function rule(o: Partial<PayRule> & Pick<PayRule, '_id' | 'profileId' | 'name' | 'componentId' | 'trigger'>): PayRule {
  return { isActive: true, sortOrder: 1, ...o };
}
const sessionHourly = rule({
  _id: 'r_session', profileId: PROF, name: 'Hourly (shift)', componentId: COMP_HR,
  trigger: { source: 'session.activeMinutes', transform: 'HOURS_FROM_MINUTES' },
  rateAmountMicroCents: microCentsFromDecimalString('28.50', 'USD'),
});
const legMileage = rule({
  _id: 'r_miles', profileId: PROF, name: 'Mileage', componentId: COMP_MI,
  trigger: { source: 'leg.legLoadedMiles' },
  rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
});

function sessionInput(o: Partial<CalculateSessionPayInput> = {}): CalculateSessionPayInput {
  return {
    driverId: D1, sessionId: 'sess_1',
    session: { activeMinutes: 600, startedAt: T }, // 10h
    profileAssignments: [assignment()],
    profiles: new Map([[PROF, profile()]]),
    rules: [sessionHourly],
    components: components(),
    ...o,
  };
}

describe('calculateSessionPay', () => {
  it('pays one item per shift: 600 active min × $28.50/h = $285.00', () => {
    const r = calculateSessionPay(sessionInput());
    expect(r.payItems).toHaveLength(1);
    const pi = r.payItems[0];
    expect(pi.payeeType).toBe('DRIVER');
    expect(pi.payeeId).toBe(D1);
    expect(pi.quantity).toBeCloseTo(10, 6);
    expect(centsToNumber(pi.amountCents)).toBeCloseTo(285.0, 6);
    expect(pi.sourceRef.sessionId).toBe('sess_1');
    expect(pi.sourceRef.legId).toBeUndefined();
    expect(pi.periodAnchorAt).toBe(T); // work-start = shift start
    expect(r.warnings).toEqual([]);
  });

  it('ignores leg-scoped rules (no double-pay): mileage rule does not fire in the session calc', () => {
    const r = calculateSessionPay(sessionInput({ rules: [sessionHourly, legMileage] }));
    expect(r.payItems).toHaveLength(1);
    expect(r.payItems[0].componentCode).toBe('WAGE_HOURLY');
  });

  it('emits nothing when the profile has no session-scoped rule', () => {
    const r = calculateSessionPay(sessionInput({ rules: [legMileage] }));
    expect(r.payItems).toHaveLength(0);
  });

  it('flags when no default/active profile assignment exists', () => {
    const r = calculateSessionPay(sessionInput({ profileAssignments: [] }));
    expect(r.selectedProfileId).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain('NO_PROFILE');
  });

  it('respects a max-amount cap from the rule engine ($285 → capped $200)', () => {
    const cappedRule = { ...sessionHourly, maxAmountCents: centsFromDecimalString('200.00', 'USD') };
    const r = calculateSessionPay(sessionInput({ rules: [cappedRule] }));
    expect(centsToNumber(r.payItems[0].amountCents)).toBeCloseTo(200.0, 6);
  });
});

describe('calculatePay (leg) ignores session-scoped rules', () => {
  function legInput(): CalculatePayInput {
    return {
      leg: { _id: 'leg_1', legLoadedMiles: 100, legEmptyMiles: 0, sequence: 1, payeeSplits: [{ payeeId: D1, splitBps: 10000 }] },
      load: { _id: 'load_1', isHazmat: false, requiresTarp: false },
      stops: [],
      payeeType: 'DRIVER',
      profileAssignments: [assignment()],
      profiles: new Map([[PROF, profile()]]),
      rules: [sessionHourly, legMileage],
      components: components(),
      periodAnchorAt: T,
    };
  }
  it('a profile with both rules pays only the mileage rule per leg; session rule is skipped', () => {
    const r = calculatePay(legInput());
    expect(r.payItems).toHaveLength(1);
    expect(r.payItems[0].componentCode).toBe('WAGE_MILEAGE');
    // 100 mi × $0.55 = $55.00
    expect(centsToNumber(r.payItems[0].amountCents)).toBeCloseTo(55.0, 6);
  });
});
