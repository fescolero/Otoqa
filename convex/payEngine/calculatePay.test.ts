import { describe, it, expect } from 'vitest';
import {
  calculatePay,
  evaluateFilter,
  type CalculatePayInput,
  type FilterContext,
  type PayProfile,
  type PayRule,
  type ProfileAssignment,
  type ChargeComponentLite,
  type LegInput,
  type LoadInput,
  type StopInput,
} from './calculatePay';
import {
  asCents,
  asMicroCents,
  microCentsFromDecimalString,
  centsFromDecimalString,
  centsToDecimalString,
  percentToMicroPctPoints,
  rawCents,
} from '../lib/money';

// ============================================================================
// Fixture builders — keep test cases short and readable
// ============================================================================

const D1 = 'drv_alice' as const;
const D2 = 'drv_bob' as const;
const C1 = 'crr_omega' as const;
const PROF_STD = 'prof_standard' as const;
const PROF_DB = 'prof_davis_bacon' as const;
const PROF_OO = 'prof_owner_op' as const;
const PROF_OVERRIDE = 'prof_override' as const;

const COMP_WAGE_MI = 'comp_wage_mi' as const;
const COMP_WAGE_HR = 'comp_wage_hr' as const;
const COMP_HW = 'comp_hw' as const;
const COMP_PENSION = 'comp_pension' as const;
const COMP_VAC = 'comp_vac' as const;
const COMP_STOP = 'comp_stop' as const;
const COMP_DETENTION = 'comp_detention' as const;
const COMP_HAZMAT = 'comp_hazmat' as const;
const COMP_PCT = 'comp_pct' as const;
const COMP_FLAT = 'comp_flat' as const;

function components(): Map<string, ChargeComponentLite> {
  return new Map<string, ChargeComponentLite>([
    [COMP_WAGE_MI, { _id: COMP_WAGE_MI, code: 'WAGE_MILEAGE', bucket: 'BASE_WAGE', sign: 'CREDIT' }],
    [COMP_WAGE_HR, { _id: COMP_WAGE_HR, code: 'WAGE_HOURLY', bucket: 'BASE_WAGE', sign: 'CREDIT' }],
    [COMP_HW, { _id: COMP_HW, code: 'HEALTH_WELFARE', bucket: 'BASE_FRINGE', sign: 'CREDIT' }],
    [COMP_PENSION, { _id: COMP_PENSION, code: 'PENSION_CONTRIBUTION', bucket: 'BASE_FRINGE', sign: 'CREDIT' }],
    [COMP_VAC, { _id: COMP_VAC, code: 'VACATION_FUND', bucket: 'BASE_FRINGE', sign: 'CREDIT' }],
    [COMP_STOP, { _id: COMP_STOP, code: 'STOP_PAY', bucket: 'ACCESSORIAL', sign: 'CREDIT' }],
    [COMP_DETENTION, { _id: COMP_DETENTION, code: 'DETENTION_PAY', bucket: 'ACCESSORIAL', sign: 'CREDIT' }],
    [COMP_HAZMAT, { _id: COMP_HAZMAT, code: 'HAZMAT_PREMIUM_PAY', bucket: 'ACCESSORIAL', sign: 'CREDIT' }],
    [COMP_PCT, { _id: COMP_PCT, code: 'WAGE_PERCENT', bucket: 'BASE_WAGE', sign: 'CREDIT' }],
    [COMP_FLAT, { _id: COMP_FLAT, code: 'WAGE_FLAT', bucket: 'BASE_WAGE', sign: 'CREDIT' }],
  ]);
}

function profile(overrides: Partial<PayProfile> = {}): PayProfile {
  return {
    _id: PROF_STD,
    workosOrgId: 'org_test',
    name: 'Standard Mileage',
    payeeType: 'DRIVER',
    currency: 'USD',
    isActive: true,
    ...overrides,
  };
}

function profileMap(...profiles: PayProfile[]): Map<string, PayProfile> {
  return new Map(profiles.map(p => [p._id, p]));
}

function assignment(overrides: Partial<ProfileAssignment> = {}): ProfileAssignment {
  return {
    payeeType: 'DRIVER',
    payeeId: D1,
    profileId: PROF_STD,
    isDefault: true,
    selectionStrategy: 'ALWAYS_ACTIVE',
    isActive: true,
    ...overrides,
  };
}

function leg(overrides: Partial<LegInput> = {}): LegInput {
  return {
    _id: 'leg_1',
    legLoadedMiles: 100,
    legEmptyMiles: 0,
    sequence: 1,
    payeeSplits: [{ payeeId: D1, splitBps: 10000 }],
    ...overrides,
  };
}

function load(overrides: Partial<LoadInput> = {}): LoadInput {
  return {
    _id: 'load_1',
    isHazmat: false,
    requiresTarp: false,
    ...overrides,
  };
}

function rule(overrides: Partial<PayRule> & Pick<PayRule, '_id' | 'profileId' | 'name' | 'componentId' | 'trigger'>): PayRule {
  return {
    isActive: true,
    sortOrder: 1,
    ...overrides,
  };
}

function baseInput(overrides: Partial<CalculatePayInput> = {}): CalculatePayInput {
  return {
    leg: leg(),
    load: load(),
    stops: [],
    payeeType: 'DRIVER',
    profileAssignments: [assignment()],
    profiles: profileMap(profile()),
    rules: [],
    components: components(),
    periodAnchorAt: Date.UTC(2026, 0, 15),
    ...overrides,
  };
}

// ============================================================================
// SCENARIO 1: Standard mileage driver
// ============================================================================

describe('scenario: standard mileage driver', () => {
  it('emits one payItem at $0.55/mi × 100 mi = $55.00', () => {
    const r = rule({
      _id: 'rule_mi',
      profileId: PROF_STD,
      name: 'Mileage pay',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const result = calculatePay(baseInput({ rules: [r] }));
    expect(result.selectedProfileId).toBe(PROF_STD);
    expect(result.payItems).toHaveLength(1);
    expect(result.payItems[0].componentCode).toBe('WAGE_MILEAGE');
    expect(result.payItems[0].quantity).toBe(100);
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('55.00');
    expect(result.payItems[0].currency).toBe('USD');
    expect(result.warnings).toEqual([]);
  });

  it('handles sub-cent rate $0.555/mi × 100 mi = $55.50', () => {
    const r = rule({
      _id: 'rule_mi',
      profileId: PROF_STD,
      name: 'Mileage pay',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.555', 'USD'),
    });
    const result = calculatePay(baseInput({ rules: [r] }));
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('55.50');
  });
});

// ============================================================================
// SCENARIO 2: Davis-Bacon prevailing wage (4 base components, single trigger)
// ============================================================================

describe('scenario: Davis-Bacon prevailing wage', () => {
  it('emits 4 payItems from 4 rules all driven by hours worked', () => {
    const wage = rule({
      _id: 'r_wage',  profileId: PROF_DB, name: 'Wage',
      componentId: COMP_WAGE_HR,
      trigger: { source: 'leg.durationMinutes', transform: 'HOURS_FROM_MINUTES' },
      rateAmountMicroCents: microCentsFromDecimalString('28.50', 'USD'),
      sortOrder: 1,
    });
    const hw = rule({
      _id: 'r_hw', profileId: PROF_DB, name: 'H&W',
      componentId: COMP_HW,
      trigger: { source: 'leg.durationMinutes', transform: 'HOURS_FROM_MINUTES' },
      rateAmountMicroCents: microCentsFromDecimalString('4.50', 'USD'),
      sortOrder: 2,
    });
    const pension = rule({
      _id: 'r_pension', profileId: PROF_DB, name: 'Pension',
      componentId: COMP_PENSION,
      trigger: { source: 'leg.durationMinutes', transform: 'HOURS_FROM_MINUTES' },
      rateAmountMicroCents: microCentsFromDecimalString('2.75', 'USD'),
      sortOrder: 3,
    });
    const vac = rule({
      _id: 'r_vac', profileId: PROF_DB, name: 'Vacation',
      componentId: COMP_VAC,
      trigger: { source: 'leg.durationMinutes', transform: 'HOURS_FROM_MINUTES' },
      rateAmountMicroCents: microCentsFromDecimalString('1.00', 'USD'),
      sortOrder: 4,
    });

    const stops: StopInput[] = [
      { sequence: 1, checkedInAt: Date.UTC(2026, 0, 15, 8, 0), checkedOutAt: Date.UTC(2026, 0, 15, 9, 0) },
      { sequence: 2, checkedInAt: Date.UTC(2026, 0, 15, 14, 0), checkedOutAt: Date.UTC(2026, 0, 15, 16, 0) },
    ];

    const result = calculatePay(baseInput({
      stops,
      rules: [wage, hw, pension, vac],
      profileAssignments: [assignment({ profileId: PROF_DB })],
      profiles: profileMap(profile({ _id: PROF_DB, name: 'Davis-Bacon', contractTag: 'DAVIS_BACON', state: 'US-CA' })),
    }));

    // 8 hours between 8am first-in and 4pm last-out
    expect(result.payItems).toHaveLength(4);
    const byCode = Object.fromEntries(result.payItems.map(p => [p.componentCode, p]));
    expect(centsToDecimalString(byCode.WAGE_HOURLY.amountCents)).toBe('228.00');
    expect(centsToDecimalString(byCode.HEALTH_WELFARE.amountCents)).toBe('36.00');
    expect(centsToDecimalString(byCode.PENSION_CONTRIBUTION.amountCents)).toBe('22.00');
    expect(centsToDecimalString(byCode.VACATION_FUND.amountCents)).toBe('8.00');
    expect(byCode.HEALTH_WELFARE.componentBucket).toBe('BASE_FRINGE');
  });
});

// ============================================================================
// SCENARIO 3: Owner-op contractor (percent of load)
// ============================================================================

describe('scenario: owner-operator percent of load', () => {
  it('pays 75% of load.invoiceTotalCents', () => {
    const r = rule({
      _id: 'r_pct', profileId: PROF_OO, name: '75% of load',
      componentId: COMP_PCT,
      trigger: { source: 'load.invoiceTotalCents', transform: 'PERCENT' },
      rateAmountMicroCents: asMicroCents(percentToMicroPctPoints(75)),
    });
    const result = calculatePay(baseInput({
      load: load({ invoiceTotalCents: centsFromDecimalString('2000.00', 'USD') }),
      rules: [r],
      profileAssignments: [assignment({ profileId: PROF_OO })],
      profiles: profileMap(profile({ _id: PROF_OO, name: 'Owner-Op 75%', payeeType: 'CARRIER' })),
      payeeType: 'CARRIER',
      leg: leg({ payeeSplits: [{ payeeId: C1, splitBps: 10000 }] }),
    }));
    expect(result.payItems).toHaveLength(1);
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('1500.00');
    expect(result.payItems[0].payeeType).toBe('CARRIER');
    expect(result.payItems[0].payeeId).toBe(C1);
  });

  it('handles fractional percent 12.5% exactly', () => {
    const r = rule({
      _id: 'r_pct', profileId: PROF_OO, name: '12.5% of load',
      componentId: COMP_PCT,
      trigger: { source: 'load.invoiceTotalCents', transform: 'PERCENT' },
      rateAmountMicroCents: asMicroCents(percentToMicroPctPoints(12.5)),
    });
    const result = calculatePay(baseInput({
      load: load({ invoiceTotalCents: centsFromDecimalString('800.00', 'USD') }),
      rules: [r],
      profileAssignments: [assignment({ profileId: PROF_OO })],
      profiles: profileMap(profile({ _id: PROF_OO, payeeType: 'CARRIER' })),
      payeeType: 'CARRIER',
      leg: leg({ payeeSplits: [{ payeeId: C1, splitBps: 10000 }] }),
    }));
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('100.00');
  });
});

// ============================================================================
// SCENARIO 4: Tiered rate
// ============================================================================

describe('scenario: tiered mileage rate', () => {
  it('first 100 mi at $0.50, next at $0.55, totals correctly across tiers', () => {
    const r = rule({
      _id: 'r_tier', profileId: PROF_STD, name: 'Tiered miles',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      tieredRate: [
        { minQty: 0, maxQty: 100, rateMicroCents: microCentsFromDecimalString('0.50', 'USD') },
        { minQty: 100, maxQty: 300, rateMicroCents: microCentsFromDecimalString('0.55', 'USD') },
        { minQty: 300, rateMicroCents: microCentsFromDecimalString('0.60', 'USD') },
      ],
    });
    const result = calculatePay(baseInput({
      leg: leg({ legLoadedMiles: 350 }),
      rules: [r],
    }));
    // 100 × 0.50 + 200 × 0.55 + 50 × 0.60 = 50 + 110 + 30 = 190
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('190.00');
  });
});

// ============================================================================
// SCENARIO 5: Hazmat premium with equipment-type condition
// ============================================================================

describe('scenario: hazmat premium, equipment-type gated', () => {
  it('fires on FLATBED hazmat load', () => {
    const r = rule({
      _id: 'r_haz', profileId: PROF_STD, name: 'Hazmat premium',
      componentId: COMP_HAZMAT,
      trigger: { source: 'attr.hazmat' },
      rateAmountMicroCents: microCentsFromDecimalString('150', 'USD'),
      equipmentTypeCondition: 'FLATBED',
    });
    const result = calculatePay(baseInput({
      load: load({ isHazmat: true, equipmentType: 'FLATBED' }),
      rules: [r],
    }));
    expect(result.payItems).toHaveLength(1);
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('150.00');
  });

  it('does NOT fire on VAN hazmat load (equipment mismatch)', () => {
    const r = rule({
      _id: 'r_haz', profileId: PROF_STD, name: 'Hazmat premium',
      componentId: COMP_HAZMAT,
      trigger: { source: 'attr.hazmat' },
      rateAmountMicroCents: microCentsFromDecimalString('150', 'USD'),
      equipmentTypeCondition: 'FLATBED',
    });
    const result = calculatePay(baseInput({
      load: load({ isHazmat: true, equipmentType: 'VAN' }),
      rules: [r],
    }));
    expect(result.payItems).toHaveLength(0);
  });

  it('does NOT fire when load is not hazmat (attr.* zero-skip)', () => {
    const r = rule({
      _id: 'r_haz', profileId: PROF_STD, name: 'Hazmat premium',
      componentId: COMP_HAZMAT,
      trigger: { source: 'attr.hazmat' },
      rateAmountMicroCents: microCentsFromDecimalString('150', 'USD'),
      equipmentTypeCondition: 'FLATBED',
    });
    const result = calculatePay(baseInput({
      load: load({ isHazmat: false, equipmentType: 'FLATBED' }),
      rules: [r],
    }));
    // attr.hazmat=0 → rule skipped entirely (no zero-amount noise)
    expect(result.payItems).toHaveLength(0);
  });

  it('legitimate qty=0 (e.g. 0 loaded miles) still emits a $0 payItem', () => {
    const r = rule({
      _id: 'r_mi', profileId: PROF_STD, name: 'Mileage',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const result = calculatePay(baseInput({
      leg: leg({ legLoadedMiles: 0 }),
      rules: [r],
    }));
    // Non-attr zero quantities ARE emitted — distinct from boolean condition false
    expect(result.payItems).toHaveLength(1);
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('0.00');
  });
});

// ============================================================================
// SCENARIO 6: Team driver split
// ============================================================================

describe('scenario: team driver 50/50 split', () => {
  it('emits one payItem per driver at 50% of total', () => {
    const r = rule({
      _id: 'r_mi', profileId: PROF_STD, name: 'Mileage',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.50', 'USD'),
    });
    const result = calculatePay(baseInput({
      leg: leg({
        legLoadedMiles: 200,
        payeeSplits: [
          { payeeId: D1, splitBps: 5000, role: 'CO_DRIVER' },
          { payeeId: D2, splitBps: 5000, role: 'CO_DRIVER' },
        ],
      }),
      rules: [r],
    }));
    expect(result.payItems).toHaveLength(2);
    expect(result.payItems.map(p => p.payeeId).sort()).toEqual([D1, D2].sort());
    // 200 × 0.50 = $100 total; each gets $50
    for (const item of result.payItems) {
      expect(centsToDecimalString(item.amountCents)).toBe('50.00');
      expect(item.quantity).toBe(100); // 50% of 200
    }
  });

  it('handles uneven splits (60/40)', () => {
    const r = rule({
      _id: 'r_mi', profileId: PROF_STD, name: 'Mileage',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.50', 'USD'),
    });
    const result = calculatePay(baseInput({
      leg: leg({
        legLoadedMiles: 200,
        payeeSplits: [
          { payeeId: D1, splitBps: 6000 },
          { payeeId: D2, splitBps: 4000 },
        ],
      }),
      rules: [r],
    }));
    const byPayee = Object.fromEntries(result.payItems.map(p => [p.payeeId, p]));
    expect(centsToDecimalString(byPayee[D1].amountCents)).toBe('60.00');
    expect(centsToDecimalString(byPayee[D2].amountCents)).toBe('40.00');
  });
});

// ============================================================================
// SCENARIO 7: Detention via dwell minutes → hours
// ============================================================================

describe('scenario: detention via dwell minutes', () => {
  it('90 minutes × $25/hr = $37.50', () => {
    const r = rule({
      _id: 'r_det', profileId: PROF_STD, name: 'Detention',
      componentId: COMP_DETENTION,
      trigger: { source: 'stops.dwellMinutesSum', transform: 'HOURS_FROM_MINUTES' },
      rateAmountMicroCents: microCentsFromDecimalString('25.00', 'USD'),
    });
    const stops: StopInput[] = [
      { sequence: 1, dwellTimeMinutes: 30 },
      { sequence: 2, dwellTimeMinutes: 60 },
    ];
    const result = calculatePay(baseInput({ stops, rules: [r] }));
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('37.50');
    expect(result.payItems[0].quantity).toBe(1.5);
  });
});

// ============================================================================
// SCENARIO 8: Min/max amount caps
// ============================================================================

describe('scenario: min/max amount caps', () => {
  it('caps amount at maxAmountCents', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Capped',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('1.00', 'USD'),
      maxAmountCents: centsFromDecimalString('150.00', 'USD'),
    });
    const result = calculatePay(baseInput({
      leg: leg({ legLoadedMiles: 200 }),
      rules: [r],
    }));
    // 200 × $1.00 = $200, capped to $150
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('150.00');
  });

  it('floors amount at minAmountCents', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Floored',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.10', 'USD'),
      minAmountCents: centsFromDecimalString('50.00', 'USD'),
    });
    const result = calculatePay(baseInput({
      leg: leg({ legLoadedMiles: 100 }),
      rules: [r],
    }));
    // 100 × $0.10 = $10, floored to $50
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('50.00');
  });
});

// ============================================================================
// SCENARIO 9: minThreshold skips the rule
// ============================================================================

describe('scenario: minThreshold skip', () => {
  it('skips rule entirely when qty < threshold', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Long-haul only',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
      minThreshold: 50,
    });
    const result = calculatePay(baseInput({
      leg: leg({ legLoadedMiles: 30 }),
      rules: [r],
    }));
    expect(result.payItems).toHaveLength(0);
  });

  it('fires when qty >= threshold', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Long-haul only',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
      minThreshold: 50,
    });
    const result = calculatePay(baseInput({
      leg: leg({ legLoadedMiles: 60 }),
      rules: [r],
    }));
    expect(result.payItems).toHaveLength(1);
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('33.00');
  });
});

// ============================================================================
// SCENARIO 10: Profile selection by JURISDICTION
// ============================================================================

describe('scenario: profile selection by jurisdiction', () => {
  it('picks DAVIS_BACON profile when load matches contractTag', () => {
    const assignments: ProfileAssignment[] = [
      assignment({ profileId: PROF_STD, selectionStrategy: 'ALWAYS_ACTIVE', isDefault: true }),
      assignment({
        profileId: PROF_DB,
        selectionStrategy: 'JURISDICTION',
        matchContractTag: 'DAVIS_BACON',
        matchState: 'US-CA',
        isDefault: false,
      }),
    ];
    const profiles = profileMap(
      profile({ _id: PROF_STD }),
      profile({ _id: PROF_DB, name: 'CA Davis-Bacon', contractTag: 'DAVIS_BACON', state: 'US-CA' }),
    );
    const result = calculatePay(baseInput({
      leg: leg({ workState: 'US-CA' }),
      load: load({ contractTag: 'DAVIS_BACON' }),
      profileAssignments: assignments,
      profiles,
    }));
    expect(result.selectedProfileId).toBe(PROF_DB);
  });

  it('falls back to default when no jurisdiction match', () => {
    const assignments: ProfileAssignment[] = [
      assignment({ profileId: PROF_STD, selectionStrategy: 'ALWAYS_ACTIVE', isDefault: true }),
      assignment({
        profileId: PROF_DB,
        selectionStrategy: 'JURISDICTION',
        matchContractTag: 'DAVIS_BACON',
        isDefault: false,
      }),
    ];
    const profiles = profileMap(
      profile({ _id: PROF_STD }),
      profile({ _id: PROF_DB, contractTag: 'DAVIS_BACON' }),
    );
    const result = calculatePay(baseInput({
      load: load({ contractTag: undefined }), // no contract tag
      profileAssignments: assignments,
      profiles,
    }));
    expect(result.selectedProfileId).toBe(PROF_STD);
  });

  it('picks most-specific jurisdiction match when multiple apply', () => {
    const assignments: ProfileAssignment[] = [
      assignment({
        profileId: PROF_DB,
        selectionStrategy: 'JURISDICTION',
        matchContractTag: 'DAVIS_BACON',  // less specific
        isDefault: false,
      }),
      assignment({
        profileId: PROF_OVERRIDE,
        selectionStrategy: 'JURISDICTION',
        matchContractTag: 'DAVIS_BACON',
        matchState: 'US-CA',              // more specific
        isDefault: false,
      }),
    ];
    const profiles = profileMap(
      profile({ _id: PROF_DB }),
      profile({ _id: PROF_OVERRIDE, name: 'CA DB-specific' }),
    );
    const result = calculatePay(baseInput({
      leg: leg({ workState: 'US-CA' }),
      load: load({ contractTag: 'DAVIS_BACON' }),
      profileAssignments: assignments,
      profiles,
    }));
    expect(result.selectedProfileId).toBe(PROF_OVERRIDE);
  });
});

// ============================================================================
// SCENARIO 11: Profile overrides (load-level + leg-level)
// ============================================================================

describe('scenario: profile overrides', () => {
  it('load.payProfileOverrideId beats default assignment', () => {
    const profiles = profileMap(
      profile({ _id: PROF_STD }),
      profile({ _id: PROF_OVERRIDE, name: 'Load-override' }),
    );
    const result = calculatePay(baseInput({
      load: load({ payProfileOverrideId: PROF_OVERRIDE }),
      profileAssignments: [assignment({ profileId: PROF_STD })],
      profiles,
    }));
    expect(result.selectedProfileId).toBe(PROF_OVERRIDE);
  });

  it('leg.payProfileOverrideId beats load override', () => {
    const profiles = profileMap(
      profile({ _id: PROF_STD }),
      profile({ _id: PROF_OVERRIDE, name: 'Load-override' }),
      profile({ _id: 'prof_leg', name: 'Leg-override' }),
    );
    const result = calculatePay(baseInput({
      leg: leg({ payProfileOverrideId: 'prof_leg' }),
      load: load({ payProfileOverrideId: PROF_OVERRIDE }),
      profileAssignments: [assignment({ profileId: PROF_STD })],
      profiles,
    }));
    expect(result.selectedProfileId).toBe('prof_leg');
  });

  it('warns and falls through when override profile is missing', () => {
    const profiles = profileMap(profile({ _id: PROF_STD }));
    const result = calculatePay(baseInput({
      load: load({ payProfileOverrideId: 'prof_ghost' }),
      profileAssignments: [assignment({ profileId: PROF_STD })],
      profiles,
    }));
    expect(result.selectedProfileId).toBe(PROF_STD);
    expect(result.warnings.some(w => w.code === 'LOAD_OVERRIDE_INVALID')).toBe(true);
  });
});

// ============================================================================
// SCENARIO 12: Multi-state work allocation
// ============================================================================

describe('scenario: multi-state work allocation', () => {
  it('payItem carries the load-level allocation array', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Mileage',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const result = calculatePay(baseInput({
      load: load({
        workStateAllocation: [
          { state: 'US-CA', portionBps: 6000 },
          { state: 'US-NV', portionBps: 4000 },
        ],
      }),
      rules: [r],
    }));
    expect(result.payItems[0].workJurisdiction?.allocation).toEqual([
      { state: 'US-CA', portionBps: 6000 },
      { state: 'US-NV', portionBps: 4000 },
    ]);
  });

  it('falls back to single state from leg when no load allocation', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Mileage',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const result = calculatePay(baseInput({
      leg: leg({ workState: 'US-TX', workCountry: 'US' }),
      rules: [r],
    }));
    expect(result.payItems[0].workJurisdiction).toEqual({ country: 'US', state: 'US-TX' });
  });
});

// ============================================================================
// SCENARIO 13: No profile resolves → fail-loud with FLAG warning
// ============================================================================

describe('scenario: no profile resolves', () => {
  it('returns empty payItems and a FLAG warning', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Mileage',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const result = calculatePay(baseInput({
      profileAssignments: [],  // no assignments at all
      rules: [r],
    }));
    expect(result.selectedProfileId).toBeNull();
    expect(result.payItems).toEqual([]);
    expect(result.warnings.some(w => w.code === 'NO_PROFILE' && w.level === 'FLAG')).toBe(true);
  });
});

// ============================================================================
// SCENARIO 14: Rule references missing component → FLAG warning, skip
// ============================================================================

describe('scenario: rule references missing component', () => {
  it('warns and continues with other rules', () => {
    const good = rule({
      _id: 'r_good', profileId: PROF_STD, name: 'Good',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
      sortOrder: 1,
    });
    const broken = rule({
      _id: 'r_broken', profileId: PROF_STD, name: 'Broken',
      componentId: 'comp_does_not_exist',
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.10', 'USD'),
      sortOrder: 2,
    });
    const result = calculatePay(baseInput({ rules: [good, broken] }));
    expect(result.payItems).toHaveLength(1);
    expect(result.payItems[0].componentCode).toBe('WAGE_MILEAGE');
    expect(result.warnings.some(w => w.code === 'MISSING_COMPONENT')).toBe(true);
  });
});

// ============================================================================
// SCENARIO 15: Unknown trigger source → WARNING, skip rule
// ============================================================================

describe('scenario: unknown trigger source', () => {
  it('skips the rule with a WARNING', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Unknown',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'driver.imaginaryField' },
      rateAmountMicroCents: microCentsFromDecimalString('1', 'USD'),
    });
    const result = calculatePay(baseInput({ rules: [r] }));
    expect(result.payItems).toHaveLength(0);
    expect(result.warnings.some(w => w.code === 'UNKNOWN_TRIGGER_SOURCE')).toBe(true);
  });
});

// ============================================================================
// SCENARIO 16: Inactive rules ignored; sortOrder respected
// ============================================================================

describe('scenario: inactive rules ignored, sortOrder respected', () => {
  it('does not emit payItems for isActive=false rules', () => {
    const inactive = rule({
      _id: 'r_inactive', profileId: PROF_STD, name: 'Inactive',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('1', 'USD'),
      isActive: false,
    });
    const result = calculatePay(baseInput({ rules: [inactive] }));
    expect(result.payItems).toHaveLength(0);
  });

  it('emits payItems in rule.sortOrder', () => {
    const a = rule({
      _id: 'a', profileId: PROF_STD, name: 'A',
      componentId: COMP_FLAT,
      trigger: { source: 'constant.1' },
      rateAmountMicroCents: microCentsFromDecimalString('10', 'USD'),
      sortOrder: 10,
    });
    const b = rule({
      _id: 'b', profileId: PROF_STD, name: 'B',
      componentId: COMP_FLAT,
      trigger: { source: 'constant.1' },
      rateAmountMicroCents: microCentsFromDecimalString('20', 'USD'),
      sortOrder: 1,
    });
    const result = calculatePay(baseInput({ rules: [a, b] }));
    expect(result.payItems.map(p => p.description)).toEqual(['B', 'A']);
  });
});

// ============================================================================
// SCENARIO 17: sourceRef + sourceData traceability
// ============================================================================

describe('scenario: sourceRef and sourceData populated', () => {
  it('captures rule, profile, and trigger snapshot on every payItem', () => {
    const r = rule({
      _id: 'r_trace', profileId: PROF_STD, name: 'Traced',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles', transform: 'IDENTITY' },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const result = calculatePay(baseInput({ rules: [r] }));
    const p = result.payItems[0];
    expect(p.sourceRef.kind).toBe('RATE_RULE');
    expect(p.sourceRef.id).toBe('r_trace');
    expect(p.sourceRef.loadId).toBe('load_1');
    expect(p.sourceRef.legId).toBe('leg_1');
    // Narrow the union with the discriminator before reading variant-specific fields.
    if (p.sourceData._variant !== 'EARNING') throw new Error('expected EARNING variant');
    expect(p.sourceData.ruleId).toBe('r_trace');
    expect(p.sourceData.profileIdSnapshot).toBe(PROF_STD);
    expect(JSON.parse(p.sourceData.triggerSnapshot)).toEqual({
      source: 'leg.legLoadedMiles',
      transform: 'IDENTITY',
    });
  });
});

// ============================================================================
// SCENARIO 18: Flat per-leg rule via constant.1 trigger
// ============================================================================

describe('scenario: flat per-leg rule', () => {
  it('emits a single payItem at the flat rate, qty=1', () => {
    const r = rule({
      _id: 'r_flat', profileId: PROF_STD, name: 'Stop bonus',
      componentId: COMP_FLAT,
      trigger: { source: 'constant.1' },
      rateAmountMicroCents: microCentsFromDecimalString('75', 'USD'),
    });
    const result = calculatePay(baseInput({ rules: [r] }));
    expect(result.payItems).toHaveLength(1);
    expect(result.payItems[0].quantity).toBe(1);
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('75.00');
  });
});

// ============================================================================
// SCENARIO 19: maxCap caps quantity (qty cap, distinct from amount cap)
// ============================================================================

describe('scenario: maxCap on quantity', () => {
  it('caps quantity at maxCap before rate multiplication', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Capped at 500 mi',
      componentId: COMP_WAGE_MI,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: microCentsFromDecimalString('0.50', 'USD'),
      maxCap: 500,
    });
    const result = calculatePay(baseInput({
      leg: leg({ legLoadedMiles: 800 }),
      rules: [r],
    }));
    // 500 × 0.50 = 250, not 800 × 0.50 = 400
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('250.00');
    expect(result.payItems[0].quantity).toBe(500);
  });
});

// ============================================================================
// SCENARIO 20: Multi-rule ordering — same trigger source, different components
// ============================================================================

describe('scenario: trigger.filter — boolean conditions', () => {
  function fctx(over: Partial<{ leg: LegInput; load: LoadInput; stops: StopInput[] }> = {}): FilterContext {
    const l = leg(over.leg);
    const ld = load(over.load);
    const s = over.stops ?? [];
    return {
      leg: l,
      load: ld,
      stops: s,
      trigger: {
        leg: { legLoadedMiles: l.legLoadedMiles, legEmptyMiles: l.legEmptyMiles,
               totalMiles: l.legLoadedMiles + l.legEmptyMiles, durationMinutes: 0 },
        load: { invoiceTotalCents: asCents(BigInt(0)), linehaulTotalCents: asCents(BigInt(0)),
                isHazmat: ld.isHazmat, requiresTarp: ld.requiresTarp, isOversize: false },
        stops: { count: s.length, dwellMinutesSum: 0 },
      },
      payeeType: 'DRIVER',
    };
  }

  it('"load.isHazmat === true" evaluates correctly', () => {
    expect(evaluateFilter('load.isHazmat === true', fctx({ load: load({ isHazmat: true }) }))).toBe(true);
    expect(evaluateFilter('load.isHazmat === true', fctx({ load: load({ isHazmat: false }) }))).toBe(false);
  });

  it('"load.equipmentType === \'FLATBED\'" with single quotes', () => {
    expect(evaluateFilter("load.equipmentType === 'FLATBED'", fctx({ load: load({ equipmentType: 'FLATBED' }) }))).toBe(true);
    expect(evaluateFilter("load.equipmentType === 'FLATBED'", fctx({ load: load({ equipmentType: 'VAN' }) }))).toBe(false);
  });

  it('"stops.count > 2" numeric comparison', () => {
    expect(evaluateFilter('stops.count > 2', fctx({ stops: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }] }))).toBe(true);
    expect(evaluateFilter('stops.count > 2', fctx({ stops: [{ sequence: 1 }] }))).toBe(false);
  });

  it('"leg.legLoadedMiles >= 500" boundary', () => {
    expect(evaluateFilter('leg.legLoadedMiles >= 500', fctx({ leg: leg({ legLoadedMiles: 500 }) }))).toBe(true);
    expect(evaluateFilter('leg.legLoadedMiles >= 500', fctx({ leg: leg({ legLoadedMiles: 499 }) }))).toBe(false);
  });

  it('"!=="" inverse equality', () => {
    expect(evaluateFilter("load.contractTag !== 'DAVIS_BACON'", fctx({ load: load({ contractTag: 'UNION_70' }) }))).toBe(true);
    expect(evaluateFilter("load.contractTag !== 'DAVIS_BACON'", fctx({ load: load({ contractTag: 'DAVIS_BACON' }) }))).toBe(false);
  });

  it('malformed expression returns null', () => {
    expect(evaluateFilter('garbage', fctx())).toBeNull();
    expect(evaluateFilter('load.isHazmat =', fctx())).toBeNull();
  });

  it('unresolvable path returns null', () => {
    expect(evaluateFilter('load.imaginaryField === 1', fctx())).toBeNull();
  });

  it('numeric op on non-numeric returns false (type-safe)', () => {
    // String "FLATBED" > number 1 should be false, not coerce
    expect(evaluateFilter("load.equipmentType > 1", fctx({ load: load({ equipmentType: 'FLATBED' }) }))).toBe(false);
  });

  it('filter on rule: only fires when filter passes', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'CA-only mileage',
      componentId: COMP_WAGE_MI,
      trigger: {
        source: 'leg.legLoadedMiles',
        filter: "leg.workState === 'US-CA'",
      },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const resultCA = calculatePay(baseInput({
      leg: leg({ workState: 'US-CA' }),
      rules: [r],
    }));
    expect(resultCA.payItems).toHaveLength(1);

    const resultTX = calculatePay(baseInput({
      leg: leg({ workState: 'US-TX' }),
      rules: [r],
    }));
    expect(resultTX.payItems).toHaveLength(0);
  });

  it('malformed filter on rule: warns and skips', () => {
    const r = rule({
      _id: 'r', profileId: PROF_STD, name: 'Broken filter',
      componentId: COMP_WAGE_MI,
      trigger: {
        source: 'leg.legLoadedMiles',
        filter: 'this is not a valid filter',
      },
      rateAmountMicroCents: microCentsFromDecimalString('0.55', 'USD'),
    });
    const result = calculatePay(baseInput({ rules: [r] }));
    expect(result.payItems).toHaveLength(0);
    expect(result.warnings.some(w => w.code === 'INVALID_FILTER')).toBe(true);
  });
});

describe('scenario: regression — many rules with same trigger source emit independently', () => {
  it('Davis-Bacon style: 4 rules, 1 trigger source, 4 distinct payItems', () => {
    const triggers = ['stops.dwellMinutesSum', 'stops.dwellMinutesSum', 'stops.dwellMinutesSum', 'stops.dwellMinutesSum'];
    const codes = [COMP_WAGE_HR, COMP_HW, COMP_PENSION, COMP_VAC];
    const rates = ['28.50', '4.50', '2.75', '1.00'];
    const rules = triggers.map((src, i) => rule({
      _id: `r${i}`,
      profileId: PROF_STD,
      name: `Rule ${i}`,
      componentId: codes[i],
      trigger: { source: src, transform: 'HOURS_FROM_MINUTES' },
      rateAmountMicroCents: microCentsFromDecimalString(rates[i], 'USD'),
      sortOrder: i,
    }));
    const stops: StopInput[] = [{ sequence: 1, dwellTimeMinutes: 60 }, { sequence: 2, dwellTimeMinutes: 60 }];
    const result = calculatePay(baseInput({ stops, rules }));
    expect(result.payItems).toHaveLength(4);
    // 2 hours of dwell × each rate
    expect(centsToDecimalString(result.payItems[0].amountCents)).toBe('57.00');
    expect(centsToDecimalString(result.payItems[1].amountCents)).toBe('9.00');
    expect(centsToDecimalString(result.payItems[2].amountCents)).toBe('5.50');
    expect(centsToDecimalString(result.payItems[3].amountCents)).toBe('2.00');
  });
});
