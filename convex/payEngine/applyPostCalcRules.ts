// Post-calc rules — applied at settlement-build time, NOT per-leg.
//
// calculatePay produces per-leg earning payItems. Post-calc rules sit one
// level up: they look at the full set of earnings for a period and emit
// makeup/premium/cap adjustments that depend on the aggregate.
//
// Examples the schema supports:
//   MINIMUM_GUARANTEE_PERIOD — "at least $1,500/wk" → emit MAKEUP if short
//   MINIMUM_GUARANTEE_DAILY  — "at least $200/day"
//   MAXIMUM_CAP_PERIOD       — "at most $X/period" → emit negative cap
//   OVERTIME_PREMIUM         — hours > 40/wk at 1.5x → emit OT premium delta
//   SHIFT_DIFFERENTIAL       — night/weekend bonus
//
// This module ships with MINIMUM_GUARANTEE_PERIOD fully implemented; the
// other kinds emit a POST_CALC_KIND_UNIMPLEMENTED warning so a future
// settlement-build module fails loud instead of silently miscalculating.
//
// Pure function: takes the set of payItems already produced for a period
// plus the profile's postCalcRules, returns any additional payItems to
// append. Emitted items carry kind='POST_CALC_ADJUSTMENT' and
// sourceRef.kind='POST_CALC_RULE' — both match the schema enums.

import {
  asMicroCents,
  rawCents,
  ZERO_CENTS,
  ZERO_MICRO_CENTS,
  type Cents,
  type Currency,
} from '../lib/money';
import type {
  PayItemSpec,
  PostCalcRule,
  PayProfile,
  ChargeComponentLite,
  PayeeType,
} from './calculatePay';

export type ApplyPostCalcInput = {
  payeeType: PayeeType;
  payeeId: string;
  periodStart: number;
  periodEnd: number;
  profile: PayProfile;
  payItems: PayItemSpec[];           // per-leg earnings + any other items
  components: Map<string, ChargeComponentLite>;
};

export type ApplyPostCalcResult = {
  emittedPayItems: PayItemSpec[];
  warnings: Array<{ level: 'INFO' | 'WARNING' | 'FLAG'; code: string; message: string }>;
};

export function applyPostCalcRules(input: ApplyPostCalcInput): ApplyPostCalcResult {
  const emittedPayItems: PayItemSpec[] = [];
  const warnings: ApplyPostCalcResult['warnings'] = [];

  const postCalcRules = input.profile.postCalcRules ?? [];
  if (postCalcRules.length === 0) {
    return { emittedPayItems, warnings };
  }

  const sortedRules = [...postCalcRules].sort((a, b) => a.sortOrder - b.sortOrder);

  for (const rule of sortedRules) {
    switch (rule.kind) {
      case 'MINIMUM_GUARANTEE_PERIOD': {
        const result = applyMinimumGuaranteePeriod(rule, input);
        emittedPayItems.push(...result);
        break;
      }
      case 'MINIMUM_GUARANTEE_DAILY':
      case 'MAXIMUM_CAP_PERIOD':
      case 'OVERTIME_PREMIUM':
      case 'SHIFT_DIFFERENTIAL':
        warnings.push({
          level: 'WARNING',
          code: 'POST_CALC_KIND_UNIMPLEMENTED',
          message: `Post-calc rule kind ${rule.kind} not yet implemented (rule: ${rule.name})`,
        });
        break;
      default: {
        // exhaustive check — TS will error if a new kind is added without a case
        const _exhaustive: never = rule.kind;
        warnings.push({
          level: 'FLAG',
          code: 'POST_CALC_KIND_UNKNOWN',
          message: `Unknown post-calc rule kind: ${_exhaustive}`,
        });
      }
    }
  }

  return { emittedPayItems, warnings };
}

// ============================================================================
// MINIMUM_GUARANTEE_PERIOD — fully implemented as the reference case
// ============================================================================

function applyMinimumGuaranteePeriod(
  rule: PostCalcRule,
  input: ApplyPostCalcInput,
): PayItemSpec[] {
  if (rule.thresholdCents === undefined) return [];

  // Net so far = sum of CREDIT items minus sum of DEBIT items (using component sign)
  let creditsRaw = BigInt(0);
  let debitsRaw = BigInt(0);
  for (const item of input.payItems) {
    if (item.componentSign === 'CREDIT') creditsRaw += rawCents(item.amountCents);
    else debitsRaw += rawCents(item.amountCents);
  }
  const netSoFar: Cents = creditsRaw - debitsRaw < BigInt(0)
    ? ZERO_CENTS
    : (creditsRaw - debitsRaw) as Cents;

  if (rawCents(netSoFar) >= rawCents(rule.thresholdCents)) {
    return []; // already at or above the guarantee
  }

  const shortfall: Cents = (rawCents(rule.thresholdCents) - rawCents(netSoFar)) as Cents;
  const component = input.components.get(rule.componentId);
  if (!component) return [];

  const currency: Currency = input.profile.currency;
  // Aggregate payItem — covers a whole period, not a single leg. sourceRef.kind
  // is POST_CALC_RULE; sourceData carries the rule name + profile snapshot.
  const spec: PayItemSpec = {
    payeeType: input.payeeType,
    payeeId: input.payeeId,
    kind: 'POST_CALC_ADJUSTMENT',
    componentId: rule.componentId,
    componentCode: component.code,
    componentBucket: component.bucket,
    componentSign: component.sign,
    lifecycleStatus: 'APPLIED',
    description: rule.name,
    quantity: 1,
    rateMicroCents: asMicroCents(ZERO_MICRO_CENTS),
    amountCents: shortfall,
    currency,
    periodAnchorAt: input.periodEnd,
    sourceRef: {
      kind: 'POST_CALC_RULE',
      id: `postcalc:${rule.name}`,
      // loadId/legId omitted — aggregate item doesn't tie to a single leg
    },
    sourceData: {
      _variant: 'POST_CALC_ADJUSTMENT',
      postCalcRuleName: rule.name,
      profileIdSnapshot: input.profile._id,
    },
    isLocked: false,
    isVoided: false,
  };
  return [spec];
}
