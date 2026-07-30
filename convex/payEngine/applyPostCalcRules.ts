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
//   MAXIMUM_CAP_WEEKLY       — "at most N hours/week" → emit offset for overage
//   OVERTIME_PREMIUM         — hours > 40/wk at 1.5x → emit OT premium delta
//   SHIFT_DIFFERENTIAL       — night/weekend bonus
//
// MINIMUM_GUARANTEE_PERIOD and MAXIMUM_CAP_WEEKLY are implemented; the other
// kinds emit a POST_CALC_KIND_UNIMPLEMENTED warning so the settlement-build
// path fails loud instead of silently miscalculating.
//
// Pure function: takes the set of payItems already produced for a period
// plus the profile's postCalcRules, returns any additional payItems to
// append. Emitted items carry kind='POST_CALC_ADJUSTMENT' and
// sourceRef.kind='POST_CALC_RULE' — both match the schema enums. Rules run
// in sortOrder and each sees the emissions of the rules before it, so a
// minimum guarantee evaluated after a cap accounts for the cap's offset.

import {
  asMicroCents,
  multiplyByBps,
  multiplyRateByQuantity,
  rawCents,
  rawMicroCents,
  sumCents,
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

/** Component code the cap offsets are emitted against. Seeded in the stdlib
 *  catalog as bucket=DEDUCTION / sign=DEBIT so the offset subtracts in the
 *  aggregator's rollup AND renders as a normal deduction line on statements
 *  with no read-adapter changes. */
export const CAP_OFFSET_COMPONENT_CODE = 'PAY_CAP_OFFSET';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** The slice of a payItem the post-calc pass needs. PayItemSpec satisfies
 *  this structurally; the aggregator maps persisted payItem docs into it. */
export type PostCalcBasisItem = Pick<
  PayItemSpec,
  'kind' | 'componentId' | 'componentSign' | 'quantity' | 'rateMicroCents' | 'amountCents' | 'periodAnchorAt'
>;

export type ApplyPostCalcInput = {
  payeeType: PayeeType;
  payeeId: string;
  periodStart: number;
  periodEnd: number;
  profile: PayProfile;
  /** Per-leg/session earnings + other period items — EXCLUDING any previously
   *  emitted post-calc items (the caller recomputes those from scratch). */
  payItems: PostCalcBasisItem[];
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

  // Later rules see earlier rules' emissions (e.g. a guarantee after a cap
  // works from the capped net, not the raw one).
  const working: PostCalcBasisItem[] = [...input.payItems];

  for (const rule of sortedRules) {
    switch (rule.kind) {
      case 'MINIMUM_GUARANTEE_PERIOD': {
        const result = applyMinimumGuaranteePeriod(rule, input, working);
        emittedPayItems.push(...result);
        working.push(...result);
        break;
      }
      case 'MAXIMUM_CAP_WEEKLY': {
        const result = applyMaximumCapWeekly(rule, input, working, warnings);
        emittedPayItems.push(...result);
        working.push(...result);
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
  items: PostCalcBasisItem[],
): PayItemSpec[] {
  if (rule.thresholdCents === undefined) return [];

  // Net so far = sum of CREDIT items minus sum of DEBIT items (using component sign)
  let creditsRaw = BigInt(0);
  let debitsRaw = BigInt(0);
  for (const item of items) {
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

// ============================================================================
// MAXIMUM_CAP_WEEKLY — cap a component's hours per 7-day window
// ============================================================================
//
// The classic use: Health & Welfare fringe owed on at most 40 hours per week.
// Per-shift rules can't see the running weekly total, so the cap runs here,
// where the whole period's lines are visible.
//
// Semantics:
//   - Weeks are consecutive 7-day windows anchored at periodStart (a bi-weekly
//     period yields exactly two). Items bucket by their periodAnchorAt
//     (work-start).
//   - Within a week, hours accumulate CHRONOLOGICALLY; once the running total
//     passes thresholdQty, the overage hours of each later line are "over cap"
//     at that line's own rate. First-worked hours pay; later ones don't.
//   - Instead of shrinking hours on the shift lines (which would collide with
//     the reviewer edit/lock system and trip the rules-drift detector), the
//     cap emits ONE VISIBLE OFFSET LINE per over-cap week against the
//     PAY_CAP_OFFSET component (DEDUCTION/DEBIT) — the shift lines stay
//     auditable and the statement math is transparent.

function applyMaximumCapWeekly(
  rule: PostCalcRule,
  input: ApplyPostCalcInput,
  items: PostCalcBasisItem[],
  warnings: ApplyPostCalcResult['warnings'],
): PayItemSpec[] {
  if (rule.thresholdQty === undefined || rule.thresholdQty <= 0) {
    warnings.push({
      level: 'WARNING',
      code: 'POST_CALC_RULE_MISCONFIGURED',
      message: `MAXIMUM_CAP_WEEKLY rule "${rule.name}" has no positive thresholdQty`,
    });
    return [];
  }

  let offsetComponent: ChargeComponentLite | undefined;
  for (const c of input.components.values()) {
    if (c.code === CAP_OFFSET_COMPONENT_CODE) { offsetComponent = c; break; }
  }
  if (!offsetComponent) {
    warnings.push({
      level: 'FLAG',
      code: 'POST_CALC_OFFSET_COMPONENT_MISSING',
      message: `Cap rule "${rule.name}" needs the ${CAP_OFFSET_COMPONENT_CODE} charge component; none found for this org`,
    });
    return [];
  }

  // Basis: system earnings of the capped component with positive hours.
  const basis = items.filter(
    (it) => it.kind === 'EARNING' && it.componentId === rule.componentId && it.quantity > 0,
  );
  if (basis.length === 0) return [];

  const byWeek = new Map<number, PostCalcBasisItem[]>();
  for (const it of basis) {
    // Window queries guarantee anchor ∈ [periodStart, periodEnd]; clamp anyway
    // so a stray anchor can't produce a negative week index.
    const wk = Math.max(0, Math.floor((it.periodAnchorAt - input.periodStart) / WEEK_MS));
    const bucket = byWeek.get(wk);
    if (bucket) bucket.push(it);
    else byWeek.set(wk, [it]);
  }

  const emitted: PayItemSpec[] = [];
  const currency: Currency = input.profile.currency;
  for (const [wk, weekItems] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    weekItems.sort((a, b) => a.periodAnchorAt - b.periodAnchorAt);

    let cumulative = 0;
    let overHours = 0;
    const overAmounts: Cents[] = [];
    for (const it of weekItems) {
      const before = cumulative;
      cumulative += it.quantity;
      // Hours of THIS line beyond the threshold (0 while still under it).
      const over = Math.max(0, cumulative - rule.thresholdQty) - Math.max(0, before - rule.thresholdQty);
      if (over <= 0) continue;
      overHours += over;
      overAmounts.push(overAmountFor(it, over));
    }
    // Hours arrive rounded to 0.01 h; keep the total on that grid too.
    overHours = Math.round(overHours * 100) / 100;
    const overCents = sumCents(overAmounts);
    if (overHours <= 0 || rawCents(overCents) <= BigInt(0)) continue;

    // Effective (weighted-average) rate — display only, derived from the
    // exact cents so quantity × rate reads true on the statement.
    const avgRateMicroCents = asMicroCents(
      BigInt(Math.round((Number(rawCents(overCents)) * 1000) / overHours)),
    );

    emitted.push({
      payeeType: input.payeeType,
      payeeId: input.payeeId,
      kind: 'POST_CALC_ADJUSTMENT',
      componentId: offsetComponent._id,
      componentCode: offsetComponent.code,
      componentBucket: offsetComponent.bucket,
      componentSign: offsetComponent.sign,
      lifecycleStatus: 'APPLIED',
      description: `${rule.name} — ${overHours.toFixed(2)} h over ${rule.thresholdQty} h (week ${wk + 1})`,
      quantity: overHours,
      rateMicroCents: avgRateMicroCents,
      amountCents: overCents,
      currency,
      // Anchor at the week's end, clamped inside the period so re-aggregation
      // window queries always find the row again.
      periodAnchorAt: Math.min(input.periodStart + (wk + 1) * WEEK_MS - 1, input.periodEnd),
      sourceRef: {
        kind: 'POST_CALC_RULE',
        // Idempotency key for the aggregator's sync — stable per profile ×
        // rule × week, so recomputes patch in place instead of duplicating.
        id: `postcalc:${input.profile._id}:${rule.name}:w${wk}`,
      },
      sourceData: {
        _variant: 'POST_CALC_ADJUSTMENT',
        postCalcRuleName: rule.name,
        profileIdSnapshot: input.profile._id,
      },
      isLocked: false,
      isVoided: false,
    });
  }
  return emitted;
}

/** Cents for `over` hours of a line: rate × over when the line has a rate,
 *  else the line's amount pro-rated by hours (guards divide-by-zero via the
 *  caller's quantity > 0 filter). */
function overAmountFor(it: PostCalcBasisItem, over: number): Cents {
  if (rawMicroCents(it.rateMicroCents) > BigInt(0)) {
    return multiplyRateByQuantity(it.rateMicroCents, over);
  }
  const fractionBps = Math.round((over / it.quantity) * 10000);
  return multiplyByBps(it.amountCents, fractionBps);
}
