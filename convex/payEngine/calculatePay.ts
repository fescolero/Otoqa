// Pure-function pay calculation engine.
//
// Decoupled from Convex runtime — operates on plain input shapes, returns
// plain output shapes. This lets us pressure-test the calc design with rich
// fixtures before wiring it into a real mutation, and gives us a substrate
// for shadow-validation against the legacy engine.
//
// The eventual Convex mutation will be a thin wrapper that:
//   1. Reads from tables (payRules, payProfiles, chargeComponents, etc.)
//      to assemble the CalculatePayInput shape
//   2. Calls calculatePay(input)
//   3. Inserts the resulting PayItemSpec rows as actual payItems
//
// Profile-selection precedence (highest first):
//   1. leg.payProfileOverride          — operator-set, rare
//   2. load.payProfileOverride         — customer-contract-driven (Davis-Bacon etc.)
//   3. JURISDICTION match              — assignments where state + contractTag align
//   4. DISTANCE_THRESHOLD match        — legacy distance-based switching
//   5. Driver's default                — fallback
//
// Trigger sources currently supported:
//   constant.1                  always 1                  (FLAT_LOAD, FLAT_LEG, ATTR_*)
//   leg.legLoadedMiles          loaded miles              (MILE_LOADED)
//   leg.legEmptyMiles           empty miles               (MILE_EMPTY)
//   leg.totalMiles              loaded + empty            (MILE_PRACTICAL)
//   stops.count                 stops on the leg          (COUNT_STOPS)
//   stops.dwellMinutesSum       sum of dwell minutes      (TIME_WAITING)
//   leg.durationMinutes         first-checkin to last-co  (TIME_DURATION)
//   load.invoiceTotalCents      gross load revenue        (PCT_OF_LOAD)
//   load.linehaulTotalCents     linehaul excl. FSC/acc.   (PCT_OF_LINEHAUL)
//   attr.hazmat                 1 if hazmat, else 0       (ATTR_HAZMAT)
//   attr.tarp                   1 if tarp, else 0         (ATTR_TARP)
//   attr.oversize               1 if oversize, else 0     (ATTR_OVERSIZE)
//
// Filter expressions support a single-comparison grammar; see evaluateFilter
// below. equipmentTypeCondition and customerCondition are structured filters
// applied directly in the main loop.

import {
  asCents,
  asMicroCents,
  multiplyRateByQuantity,
  multiplyCentsByPercent,
  applyTieredRate,
  multiplyByBps,
  rawCents,
  rawMicroCents,
  ZERO_CENTS,
  type Cents,
  type MicroCents,
  type Currency,
} from '../lib/money';

// ============================================================================
// INPUT TYPES — plain shapes, NOT Convex Doc<T>
// ============================================================================

export type PayeeType = 'DRIVER' | 'CARRIER';

export type Trigger = {
  source: string;
  transform?: 'IDENTITY' | 'HOURS_FROM_MINUTES' | 'COUNT' | 'SUM' | 'PERCENT';
  filter?: string;
};

export type TierBracket = {
  minQty: number;
  maxQty?: number;
  rateMicroCents: MicroCents;
};

export type PostCalcRule = {
  name: string;
  kind:
    | 'MINIMUM_GUARANTEE_PERIOD'
    | 'MINIMUM_GUARANTEE_DAILY'
    | 'MAXIMUM_CAP_PERIOD'
    | 'OVERTIME_PREMIUM'
    | 'SHIFT_DIFFERENTIAL';
  componentId: string;
  thresholdCents?: Cents;
  thresholdQty?: number;
  multiplierBps?: number;
  sortOrder: number;
};

export type PayRule = {
  _id: string;
  profileId: string;
  name: string;
  componentId: string;
  trigger: Trigger;
  rateAmountMicroCents?: MicroCents;
  tieredRate?: TierBracket[];
  minThreshold?: number;
  maxCap?: number;
  minAmountCents?: Cents;
  maxAmountCents?: Cents;
  equipmentTypeCondition?: string;
  customerCondition?: string;
  isActive: boolean;
  sortOrder: number;
};

export type PayProfile = {
  _id: string;
  workosOrgId: string;
  name: string;
  payeeType: PayeeType;
  currency: Currency;
  country?: string;
  state?: string;
  contractTag?: string;
  postCalcRules?: PostCalcRule[];
  isDefault?: boolean;
  isActive: boolean;
};

export type ProfileAssignment = {
  payeeType: PayeeType;
  payeeId: string;
  profileId: string;
  isDefault?: boolean;
  selectionStrategy:
    | 'ALWAYS_ACTIVE'
    | 'DISTANCE_THRESHOLD'
    | 'JURISDICTION'
    | 'MANUAL_ONLY';
  thresholdValue?: number;
  matchState?: string;
  matchContractTag?: string;
  effectiveStart?: number;
  effectiveEnd?: number;
  isActive: boolean;
};

export type ChargeComponentLite = {
  _id: string;
  code: string;
  bucket: string;
  sign: 'CREDIT' | 'DEBIT';
};

// LegPayeeSplit is generic over payee kind. For driver-pay calcs, the wrapper
// mutation translates dispatchLegs.drivers[] into this shape (one entry per
// driver, splits summing to 10000bps). For carrier-pay calcs, a single entry
// with payeeId=carrierPartnershipId and splitBps=10000 is passed. The pure
// function never needs to branch on payee kind beyond reading input.payeeType.
export type LegPayeeSplit = {
  payeeId: string;
  splitBps: number;             // basis points; multi-payee splits sum to 10000
  role?: 'CO_DRIVER' | 'TRAINEE' | 'TRAINER' | 'PRIMARY_CARRIER';
};

export type LegInput = {
  _id: string;
  legLoadedMiles: number;
  legEmptyMiles: number;
  sequence: number;
  payeeSplits: LegPayeeSplit[];
  payProfileOverrideId?: string;
  workState?: string;
  workCountry?: string;
};

export type LoadInput = {
  _id: string;
  isHazmat: boolean;
  requiresTarp: boolean;
  isOversize?: boolean;
  equipmentType?: string;
  invoiceTotalCents?: Cents;
  linehaulTotalCents?: Cents;
  contractTag?: string;
  payProfileOverrideId?: string;
  customerId?: string;
  workStateAllocation?: Array<{ state: string; portionBps: number }>;
};

export type StopInput = {
  sequence: number;
  dwellTimeMinutes?: number;
  checkedInAt?: number;
  checkedOutAt?: number;
  windowBeginTime?: number;
  windowEndTime?: number;
};

export type CalculatePayInput = {
  leg: LegInput;
  load: LoadInput;
  stops: StopInput[];
  payeeType: PayeeType;
  // Profile selection inputs — assignments + the profile catalog
  profileAssignments: ProfileAssignment[];
  profiles: Map<string, PayProfile>;
  // Active rules across all candidate profiles — engine filters by selected profile
  rules: PayRule[];
  // Component map for sign/bucket lookups during emission
  components: Map<string, ChargeComponentLite>;
  // Timestamp that goes on every emitted payItem; usually load delivery date
  periodAnchorAt: number;
};

// ============================================================================
// OUTPUT TYPES
// ============================================================================

// PayItemSpec — what the calc engine emits before persistence. Currently
// covers per-leg EARNING items (from calculatePay) and aggregate
// POST_CALC_ADJUSTMENT items (from applyPostCalcRules). Future kinds (tax,
// recurring, money codes) will broaden this further.
export type PayItemSpec = {
  payeeType: PayeeType;
  payeeId: string;
  kind: 'EARNING' | 'POST_CALC_ADJUSTMENT';
  componentId: string;
  componentCode: string;
  componentBucket: string;
  componentSign: 'CREDIT' | 'DEBIT';
  lifecycleStatus: 'APPLIED';
  description: string;
  quantity: number;
  rateMicroCents: MicroCents;
  amountCents: Cents;
  currency: Currency;
  periodAnchorAt: number;
  workJurisdiction?: {
    country: string;
    state?: string;
    allocation?: Array<{ state: string; portionBps: number }>;
  };
  // sourceRef.kind matches the schema's enum. loadId/legId omitted for
  // aggregate items (post-calc adjustments cover a whole period, not a leg).
  sourceRef: {
    kind: 'RATE_RULE' | 'POST_CALC_RULE';
    id: string;
    loadId?: string;
    legId?: string;
    sessionId?: string; // set for session/shift pay (no legId/loadId)
  };
  sourceData:
    | {
        _variant: 'EARNING';
        ruleId: string;
        profileIdSnapshot: string;
        triggerSnapshot: string;
      }
    | {
        _variant: 'POST_CALC_ADJUSTMENT';
        postCalcRuleName: string;
        profileIdSnapshot: string;
      };
  isLocked: false;
  isVoided: false;
};

export type Warning = {
  level: 'INFO' | 'WARNING' | 'FLAG';
  code: string;
  message: string;
  ruleId?: string;
};

export type CalculatePayResult = {
  selectedProfileId: string | null;
  payItems: PayItemSpec[];
  warnings: Warning[];
};

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

export function calculatePay(input: CalculatePayInput): CalculatePayResult {
  const warnings: Warning[] = [];

  // 1. Resolve which profile applies to this leg+load+payee
  const selectedProfileId = resolveProfile(input, warnings);
  if (!selectedProfileId) {
    warnings.push({
      level: 'FLAG',
      code: 'NO_PROFILE',
      message: 'No active payProfile resolved for payee on this load',
    });
    return { selectedProfileId: null, payItems: [], warnings };
  }

  const profile = input.profiles.get(selectedProfileId);
  if (!profile) {
    warnings.push({
      level: 'FLAG',
      code: 'PROFILE_NOT_FOUND',
      message: `Selected profileId ${selectedProfileId} not in profiles map`,
    });
    return { selectedProfileId, payItems: [], warnings };
  }

  // 2. Filter rules to those belonging to the selected profile, active, sorted.
  //    Session-scoped rules (source `session.*`) fire once per shift in
  //    calculateSessionPay, NOT per leg — excluding them here is what prevents
  //    double-paying hourly drivers (no suppression hack; rules partition by
  //    trigger source).
  const profileRules = input.rules
    .filter(r => r.profileId === selectedProfileId && r.isActive
      && !r.trigger.source.startsWith('session.'))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // 3. Evaluate each rule, fan out per payee in leg.payeeSplits
  const payItems: PayItemSpec[] = [];
  const baseContext: TriggerContext = buildTriggerContext(input);
  const filterContext: FilterContext = buildFilterContext(input, baseContext);

  for (const rule of profileRules) {
    // Equipment-type filter
    if (rule.equipmentTypeCondition && input.load.equipmentType !== rule.equipmentTypeCondition) {
      continue;
    }
    // Customer filter (string-id match)
    if (rule.customerCondition && input.load.customerId !== rule.customerCondition) {
      continue;
    }

    const evaluation = evaluateRule(rule, baseContext, profile, filterContext);
    if (evaluation.skipped) {
      if (evaluation.warning) warnings.push(evaluation.warning);
      continue;
    }

    // Look up component for emission metadata
    const component = input.components.get(rule.componentId);
    if (!component) {
      warnings.push({
        level: 'FLAG',
        code: 'MISSING_COMPONENT',
        message: `Rule ${rule.name} references missing componentId ${rule.componentId}`,
        ruleId: rule._id,
      });
      continue;
    }

    // Fan out one payItem per payee on the leg, quantity scaled by split.
    // For driver-pay calcs this is the team-driver split. For carrier-pay
    // calcs this is typically a single entry. Empty array = unassigned leg.
    for (const split of input.leg.payeeSplits) {
      const splitFraction = split.splitBps / 10000;
      const splitQty = evaluation.quantity * splitFraction;
      const splitAmountCents = scaleAmountByBps(
        evaluation.totalAmountCents,
        split.splitBps,
      );

      payItems.push({
        payeeType: input.payeeType,
        payeeId: split.payeeId,
        kind: 'EARNING',
        componentId: rule.componentId,
        componentCode: component.code,
        componentBucket: component.bucket,
        componentSign: component.sign,
        lifecycleStatus: 'APPLIED',
        description: rule.name,
        quantity: splitQty,
        rateMicroCents: evaluation.effectiveRateMicroCents,
        amountCents: splitAmountCents,
        currency: profile.currency,
        periodAnchorAt: input.periodAnchorAt,
        workJurisdiction: resolveWorkJurisdiction(input),
        sourceRef: {
          kind: 'RATE_RULE',
          id: rule._id,
          loadId: input.load._id,
          legId: input.leg._id,
        },
        sourceData: {
          _variant: 'EARNING',
          ruleId: rule._id,
          profileIdSnapshot: selectedProfileId,
          triggerSnapshot: JSON.stringify(rule.trigger),
        },
        isLocked: false,
        isVoided: false,
      });
    }
  }

  if (payItems.length === 0 && input.leg.payeeSplits.length === 0) {
    warnings.push({
      level: 'WARNING',
      code: 'NO_PAYEES_ON_LEG',
      message: 'Leg has no payeeSplits[]; nothing to pay',
    });
  }

  return { selectedProfileId, payItems, warnings };
}

// ============================================================================
// SESSION / SHIFT PAY — first-class, rule-driven (mirrors calculatePay but
// scoped to a driver session instead of a leg)
// ============================================================================

// A driver session spans 0..N legs; pay is computed ONCE per shift from
// session.activeMinutes against the driver's session-scoped rules (trigger
// source `session.*`). Flows through the SAME rule engine as leg pay
// (rate/component/caps/thresholds/tiers), so it stays compatible with the
// post-calc rules (OT, minimum guarantees, shift differential).
export type CalculateSessionPayInput = {
  driverId: string; // payeeId
  sessionId: string;
  session: { activeMinutes: number; startedAt: number };
  profileAssignments: ProfileAssignment[];
  profiles: Map<string, PayProfile>;
  rules: PayRule[];
  components: Map<string, ChargeComponentLite>;
};

export function calculateSessionPay(input: CalculateSessionPayInput): CalculatePayResult {
  const warnings: Warning[] = [];

  // 1. Resolve the driver's profile. Jurisdiction/distance strategies need a
  //    leg, which a multi-leg shift doesn't have — session pay uses the default
  //    (or ALWAYS_ACTIVE) assignment effective at shift start.
  const now = input.session.startedAt;
  const active = input.profileAssignments.filter(a =>
    a.isActive
    && (a.effectiveStart === undefined || a.effectiveStart <= now)
    && (a.effectiveEnd === undefined || a.effectiveEnd >= now),
  );
  const chosen = active.find(a => a.isDefault)
    ?? active.find(a => a.selectionStrategy === 'ALWAYS_ACTIVE');
  if (!chosen) {
    warnings.push({ level: 'FLAG', code: 'NO_PROFILE', message: 'No default/always-active payProfile for session pay' });
    return { selectedProfileId: null, payItems: [], warnings };
  }
  const selectedProfileId = chosen.profileId;
  const profile = input.profiles.get(selectedProfileId);
  if (!profile) {
    warnings.push({ level: 'FLAG', code: 'PROFILE_NOT_FOUND', message: `Selected profileId ${selectedProfileId} not in profiles map` });
    return { selectedProfileId, payItems: [], warnings };
  }

  // 2. Session-scoped rules only.
  const sessionRules = input.rules
    .filter(r => r.profileId === selectedProfileId && r.isActive && r.trigger.source.startsWith('session.'))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // 3. Session trigger context (no leg/load/stops; placeholders satisfy the
  //    filter context for the rare session rule that carries a filter).
  const ctx: TriggerContext = {
    leg: { legLoadedMiles: 0, legEmptyMiles: 0, totalMiles: 0, durationMinutes: 0 },
    load: { invoiceTotalCents: ZERO_CENTS, linehaulTotalCents: ZERO_CENTS, isHazmat: false, requiresTarp: false, isOversize: false },
    stops: { count: 0, dwellMinutesSum: 0 },
    session: { activeMinutes: input.session.activeMinutes },
  };
  const placeholderLeg: LegInput = { _id: '', legLoadedMiles: 0, legEmptyMiles: 0, sequence: 0, payeeSplits: [] };
  const placeholderLoad: LoadInput = { _id: '', isHazmat: false, requiresTarp: false };
  const filterCtx: FilterContext = { leg: placeholderLeg, load: placeholderLoad, stops: [], trigger: ctx, payeeType: 'DRIVER' };

  // 4. Evaluate + emit ONE payItem per firing session rule.
  const payItems: PayItemSpec[] = [];
  for (const rule of sessionRules) {
    const evaluation = evaluateRule(rule, ctx, profile, filterCtx);
    if (evaluation.skipped) {
      if (evaluation.warning) warnings.push(evaluation.warning);
      continue;
    }
    const component = input.components.get(rule.componentId);
    if (!component) {
      warnings.push({ level: 'FLAG', code: 'MISSING_COMPONENT', message: `Rule ${rule.name} references missing componentId ${rule.componentId}`, ruleId: rule._id });
      continue;
    }
    payItems.push({
      payeeType: 'DRIVER',
      payeeId: input.driverId,
      kind: 'EARNING',
      componentId: rule.componentId,
      componentCode: component.code,
      componentBucket: component.bucket,
      componentSign: component.sign,
      lifecycleStatus: 'APPLIED',
      description: rule.name,
      quantity: evaluation.quantity,
      rateMicroCents: evaluation.effectiveRateMicroCents,
      amountCents: evaluation.totalAmountCents,
      currency: profile.currency,
      periodAnchorAt: input.session.startedAt, // WORK-START (shift start)
      sourceRef: { kind: 'RATE_RULE', id: rule._id, sessionId: input.sessionId },
      sourceData: { _variant: 'EARNING', ruleId: rule._id, profileIdSnapshot: selectedProfileId, triggerSnapshot: JSON.stringify(rule.trigger) },
      isLocked: false,
      isVoided: false,
    });
  }

  return { selectedProfileId, payItems, warnings };
}

// ============================================================================
// PROFILE RESOLUTION — precedence chain
// ============================================================================

function resolveProfile(
  input: CalculatePayInput,
  warnings: Warning[],
): string | null {
  // Precedence 1: leg-level explicit override
  if (input.leg.payProfileOverrideId) {
    const profile = input.profiles.get(input.leg.payProfileOverrideId);
    if (profile && profile.isActive) return profile._id;
    warnings.push({
      level: 'WARNING',
      code: 'LEG_OVERRIDE_INVALID',
      message: `Leg payProfileOverrideId ${input.leg.payProfileOverrideId} missing or inactive`,
    });
  }

  // Precedence 2: load-level override
  if (input.load.payProfileOverrideId) {
    const profile = input.profiles.get(input.load.payProfileOverrideId);
    if (profile && profile.isActive) return profile._id;
    warnings.push({
      level: 'WARNING',
      code: 'LOAD_OVERRIDE_INVALID',
      message: `Load payProfileOverrideId ${input.load.payProfileOverrideId} missing or inactive`,
    });
  }

  // Filter assignments to those that are active and effective right now
  const now = input.periodAnchorAt;
  const activeAssignments = input.profileAssignments.filter(a =>
    a.isActive
    && (a.effectiveStart === undefined || a.effectiveStart <= now)
    && (a.effectiveEnd === undefined || a.effectiveEnd >= now),
  );

  // Precedence 3: JURISDICTION strategy — match contractTag + workState
  const jurisdictionMatches = activeAssignments.filter(a =>
    a.selectionStrategy === 'JURISDICTION'
    && (a.matchContractTag === undefined || a.matchContractTag === input.load.contractTag)
    && (a.matchState === undefined || a.matchState === input.leg.workState),
  );
  // Most-specific match first: a rule that names both contractTag AND state
  // wins over one that names only contractTag, which wins over one with neither.
  jurisdictionMatches.sort((a, b) => specificity(b) - specificity(a));
  if (jurisdictionMatches.length > 0) return jurisdictionMatches[0].profileId;

  // Precedence 4: DISTANCE_THRESHOLD strategy — match leg loaded miles
  const distanceMatches = activeAssignments
    .filter(a =>
      a.selectionStrategy === 'DISTANCE_THRESHOLD'
      && a.thresholdValue !== undefined
      && input.leg.legLoadedMiles >= a.thresholdValue,
    )
    .sort((a, b) => (b.thresholdValue ?? 0) - (a.thresholdValue ?? 0));
  if (distanceMatches.length > 0) return distanceMatches[0].profileId;

  // Precedence 5: assignment marked isDefault
  const explicitDefault = activeAssignments.find(a => a.isDefault);
  if (explicitDefault) return explicitDefault.profileId;

  // Fallback: any ALWAYS_ACTIVE assignment
  const alwaysActive = activeAssignments.find(a => a.selectionStrategy === 'ALWAYS_ACTIVE');
  if (alwaysActive) return alwaysActive.profileId;

  return null;
}

function specificity(a: ProfileAssignment): number {
  let s = 0;
  if (a.matchContractTag !== undefined) s += 2;
  if (a.matchState !== undefined) s += 1;
  return s;
}

// ============================================================================
// TRIGGER EVALUATION
// ============================================================================

type TriggerContext = {
  leg: {
    legLoadedMiles: number;
    legEmptyMiles: number;
    totalMiles: number;
    durationMinutes: number;
  };
  load: {
    invoiceTotalCents: Cents;
    linehaulTotalCents: Cents;
    isHazmat: boolean;
    requiresTarp: boolean;
    isOversize: boolean;
  };
  stops: {
    count: number;
    dwellMinutesSum: number;
  };
  // Present only for session/shift-scoped calcs (calculateSessionPay). Leg
  // calcs leave this undefined, so `session.*` sources resolve to null there.
  session?: {
    activeMinutes: number;
  };
};

function buildTriggerContext(input: CalculatePayInput): TriggerContext {
  // Compute total dwell across stops
  let dwellSum = 0;
  for (const s of input.stops) {
    if (s.dwellTimeMinutes !== undefined) dwellSum += s.dwellTimeMinutes;
  }

  // Compute leg duration: first checkin to last checkout, falling back to window times
  let durationMinutes = 0;
  if (input.stops.length >= 2) {
    const sorted = [...input.stops].sort((a, b) => a.sequence - b.sequence);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const start = first.checkedInAt ?? first.windowBeginTime;
    const end = last.checkedOutAt ?? last.windowEndTime;
    if (start !== undefined && end !== undefined && end > start) {
      durationMinutes = (end - start) / 60_000;
    }
  }

  return {
    leg: {
      legLoadedMiles: input.leg.legLoadedMiles,
      legEmptyMiles: input.leg.legEmptyMiles,
      totalMiles: input.leg.legLoadedMiles + input.leg.legEmptyMiles,
      durationMinutes,
    },
    load: {
      invoiceTotalCents: input.load.invoiceTotalCents ?? ZERO_CENTS,
      linehaulTotalCents: input.load.linehaulTotalCents ?? ZERO_CENTS,
      isHazmat: input.load.isHazmat,
      requiresTarp: input.load.requiresTarp,
      isOversize: input.load.isOversize ?? false,
    },
    stops: {
      count: input.stops.length,
      dwellMinutesSum: dwellSum,
    },
  };
}

type RawTriggerValue =
  | { kind: 'number'; value: number }
  | { kind: 'cents'; value: Cents }
  | { kind: 'bool'; value: boolean };

function resolveTriggerSource(source: string, ctx: TriggerContext): RawTriggerValue | null {
  switch (source) {
    case 'constant.1':
      return { kind: 'number', value: 1 };
    case 'leg.legLoadedMiles':
      return { kind: 'number', value: ctx.leg.legLoadedMiles };
    case 'leg.legEmptyMiles':
      return { kind: 'number', value: ctx.leg.legEmptyMiles };
    case 'leg.totalMiles':
      return { kind: 'number', value: ctx.leg.totalMiles };
    case 'leg.durationMinutes':
      return { kind: 'number', value: ctx.leg.durationMinutes };
    case 'session.activeMinutes':
      // Shift-scoped: total active minutes of the driver session. Only available
      // in a session calc; null in a leg context (those rules are filtered out
      // before evaluation, so this null is never actually reached there).
      return ctx.session ? { kind: 'number', value: ctx.session.activeMinutes } : null;
    case 'stops.count':
      return { kind: 'number', value: ctx.stops.count };
    case 'stops.dwellMinutesSum':
      return { kind: 'number', value: ctx.stops.dwellMinutesSum };
    case 'load.invoiceTotalCents':
      return { kind: 'cents', value: ctx.load.invoiceTotalCents };
    case 'load.linehaulTotalCents':
      return { kind: 'cents', value: ctx.load.linehaulTotalCents };
    case 'attr.hazmat':
      return { kind: 'number', value: ctx.load.isHazmat ? 1 : 0 };
    case 'attr.tarp':
      return { kind: 'number', value: ctx.load.requiresTarp ? 1 : 0 };
    case 'attr.oversize':
      return { kind: 'number', value: ctx.load.isOversize ? 1 : 0 };
    default:
      return null;
  }
}

type RuleEvaluation = {
  skipped: boolean;
  warning?: Warning;
  quantity: number;
  effectiveRateMicroCents: MicroCents;
  totalAmountCents: Cents;
};

function evaluateRule(
  rule: PayRule,
  ctx: TriggerContext,
  _profile: PayProfile,
  filterCtx: FilterContext,
): RuleEvaluation {
  // Filter expression — single-comparison form: "path OP literal"
  if (rule.trigger.filter) {
    const filterResult = evaluateFilter(rule.trigger.filter, filterCtx);
    if (filterResult === null) {
      return {
        skipped: true,
        warning: {
          level: 'WARNING',
          code: 'INVALID_FILTER',
          message: `Rule ${rule.name} has malformed filter: ${rule.trigger.filter}`,
          ruleId: rule._id,
        },
        quantity: 0,
        effectiveRateMicroCents: asMicroCents(BigInt(0)),
        totalAmountCents: ZERO_CENTS,
      };
    }
    if (!filterResult) {
      return {
        skipped: true,
        quantity: 0,
        effectiveRateMicroCents: asMicroCents(BigInt(0)),
        totalAmountCents: ZERO_CENTS,
      };
    }
  }

  const raw = resolveTriggerSource(rule.trigger.source, ctx);
  if (raw === null) {
    return {
      skipped: true,
      warning: {
        level: 'WARNING',
        code: 'UNKNOWN_TRIGGER_SOURCE',
        message: `Rule ${rule.name} uses unknown trigger.source: ${rule.trigger.source}`,
        ruleId: rule._id,
      },
      quantity: 0,
      effectiveRateMicroCents: asMicroCents(BigInt(0)),
      totalAmountCents: ZERO_CENTS,
    };
  }

  // attr.* sources are boolean conditions encoded as 0/1. When the condition
  // is false (qty=0), the rule simply doesn't apply — skip emission entirely
  // rather than producing a $0.00 payItem. This is distinct from legitimate
  // zero quantities like 0 loaded miles, which DO apply (rate × 0 = $0 is a
  // valid result and shouldn't be hidden).
  if (rule.trigger.source.startsWith('attr.') && raw.kind === 'number' && raw.value === 0) {
    return {
      skipped: true,
      quantity: 0,
      effectiveRateMicroCents: asMicroCents(BigInt(0)),
      totalAmountCents: ZERO_CENTS,
    };
  }

  // Apply transform to get quantity (number) used for rate multiplication
  const transformed = applyTransform(raw, rule.trigger.transform);
  if (transformed === null) {
    return {
      skipped: true,
      warning: {
        level: 'WARNING',
        code: 'TRANSFORM_MISMATCH',
        message: `Rule ${rule.name}: transform ${rule.trigger.transform} not applicable to ${raw.kind}`,
        ruleId: rule._id,
      },
      quantity: 0,
      effectiveRateMicroCents: asMicroCents(BigInt(0)),
      totalAmountCents: ZERO_CENTS,
    };
  }

  let { quantity, percentOfCents } = transformed;

  // minThreshold check — skip rule entirely if below floor
  if (rule.minThreshold !== undefined && quantity < rule.minThreshold) {
    return {
      skipped: true,
      quantity,
      effectiveRateMicroCents: asMicroCents(BigInt(0)),
      totalAmountCents: ZERO_CENTS,
    };
  }

  // maxCap — cap quantity at the ceiling
  if (rule.maxCap !== undefined && quantity > rule.maxCap) {
    quantity = rule.maxCap;
  }

  // Compute amount: either tiered, percent-of-cents, or flat
  let amount: Cents;
  let effectiveRate: MicroCents;

  if (percentOfCents !== undefined) {
    // PERCENT transform: rateAmountMicroCents is reinterpreted as
    // micro-percent-points (100% = 100,000,000). Use percentToMicroPctPoints()
    // in callers/seeders to construct these values from a normal percent like 75.
    // See convex/lib/money.ts for the convention.
    const rateMicroPct = rule.rateAmountMicroCents ?? asMicroCents(BigInt(0));
    effectiveRate = rateMicroPct;
    amount = multiplyCentsByPercent(percentOfCents, rawMicroCents(rateMicroPct));
  } else if (rule.tieredRate && rule.tieredRate.length > 0) {
    effectiveRate = rule.tieredRate[0].rateMicroCents; // for reporting; tier rate varies
    amount = applyTieredRate(
      rule.tieredRate.map(t => ({
        minQty: t.minQty,
        maxQty: t.maxQty,
        rate: t.rateMicroCents,
      })),
      quantity,
    );
  } else if (rule.rateAmountMicroCents !== undefined) {
    effectiveRate = rule.rateAmountMicroCents;
    amount = multiplyRateByQuantity(rule.rateAmountMicroCents, quantity);
  } else {
    return {
      skipped: true,
      warning: {
        level: 'WARNING',
        code: 'NO_RATE',
        message: `Rule ${rule.name} has neither rateAmountMicroCents nor tieredRate`,
        ruleId: rule._id,
      },
      quantity,
      effectiveRateMicroCents: asMicroCents(BigInt(0)),
      totalAmountCents: ZERO_CENTS,
    };
  }

  // Amount-level constraints
  if (rule.minAmountCents !== undefined && rawCents(amount) < rawCents(rule.minAmountCents)) {
    amount = rule.minAmountCents;
  }
  if (rule.maxAmountCents !== undefined && rawCents(amount) > rawCents(rule.maxAmountCents)) {
    amount = rule.maxAmountCents;
  }

  return {
    skipped: false,
    quantity,
    effectiveRateMicroCents: effectiveRate,
    totalAmountCents: amount,
  };
}

type TransformedTrigger = {
  quantity: number;             // for normal rate-multiplication path
  percentOfCents?: Cents;       // when present, switches to percent path
};

function applyTransform(
  raw: RawTriggerValue,
  transform: Trigger['transform'],
): TransformedTrigger | null {
  switch (transform ?? 'IDENTITY') {
    case 'IDENTITY':
      if (raw.kind === 'number') return { quantity: raw.value };
      if (raw.kind === 'bool') return { quantity: raw.value ? 1 : 0 };
      return null; // Cents source needs PERCENT transform
    case 'HOURS_FROM_MINUTES':
      // Round to the hundredth-hour, matching the legacy payroll convention
      // (paySession: hours = round(minutes/60, 2)). Without this, full-precision
      // minutes/60 drifts ~a cent per shift vs legacy on non-round durations.
      if (raw.kind === 'number') return { quantity: Math.round((raw.value / 60) * 100) / 100 };
      return null;
    case 'COUNT':
      // For now, source values are pre-counted scalars; COUNT is a no-op marker
      if (raw.kind === 'number') return { quantity: raw.value };
      return null;
    case 'SUM':
      // Likewise, sources we expose are pre-summed scalars
      if (raw.kind === 'number') return { quantity: raw.value };
      return null;
    case 'PERCENT':
      if (raw.kind === 'cents') {
        // quantity stays at 1; downstream uses percentOfCents path
        return { quantity: 1, percentOfCents: raw.value };
      }
      return null;
    default:
      return null;
  }
}

// ============================================================================
// HELPERS
// ============================================================================

function resolveWorkJurisdiction(input: CalculatePayInput): PayItemSpec['workJurisdiction'] {
  // Multi-state allocation on the load wins if present
  if (input.load.workStateAllocation && input.load.workStateAllocation.length > 0) {
    return {
      country: input.leg.workCountry ?? 'US',
      allocation: input.load.workStateAllocation,
    };
  }
  // Otherwise single state from the leg
  if (input.leg.workState) {
    return {
      country: input.leg.workCountry ?? 'US',
      state: input.leg.workState,
    };
  }
  return undefined;
}

function scaleAmountByBps(amount: Cents, bps: number): Cents {
  if (bps === 10000) return amount;
  return multiplyByBps(amount, bps);
}

// ============================================================================
// FILTER EVALUATOR — minimal grammar: "path OP literal"
// ============================================================================
//
// Single comparison per filter — intentionally constrained to keep the
// evaluator small and the schema field human-readable. For compound conditions,
// add multiple rules. Operators: === !== > < >= <=
// Literals: numbers, booleans (true/false), null, JS-quoted strings ('x', "x").
// Paths: dotted, e.g. "load.isHazmat", "stops.count", "leg.workState".
// Returns true/false on successful evaluation, null on parse/lookup failure
// (callers treat null as "malformed filter — skip rule with warning").

export type FilterContext = {
  leg: LegInput;
  load: LoadInput;
  stops: StopInput[];
  trigger: TriggerContext;
  payeeType: PayeeType;
};

function buildFilterContext(input: CalculatePayInput, trigger: TriggerContext): FilterContext {
  return {
    leg: input.leg,
    load: input.load,
    stops: input.stops,
    trigger,
    payeeType: input.payeeType,
  };
}

const FILTER_PATTERN = /^\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(===|!==|>=|<=|>|<)\s*(.+?)\s*$/;

export function evaluateFilter(expr: string, ctx: FilterContext): boolean | null {
  const match = FILTER_PATTERN.exec(expr);
  if (!match) return null;
  const [, pathStr, op, literalStr] = match;

  const left = resolvePath(pathStr, ctx);
  if (left === undefined) return null;

  const right = parseLiteral(literalStr);
  if (right === undefined) return null;

  return compareValues(left, op, right);
}

function resolvePath(path: string, ctx: FilterContext): unknown {
  const parts = path.split('.');
  // Special-cased aliases route through the precomputed TriggerContext so
  // filters can read the same derived numbers the trigger sources do.
  if (parts[0] === 'leg' && parts.length === 2) {
    const k = parts[1];
    if (k in ctx.trigger.leg) return (ctx.trigger.leg as Record<string, unknown>)[k];
    if (k in ctx.leg) return (ctx.leg as unknown as Record<string, unknown>)[k];
    return undefined;
  }
  if (parts[0] === 'stops' && parts.length === 2) {
    const k = parts[1];
    if (k in ctx.trigger.stops) return (ctx.trigger.stops as Record<string, unknown>)[k];
    return undefined;
  }
  if (parts[0] === 'load' && parts.length === 2) {
    return (ctx.load as unknown as Record<string, unknown>)[parts[1]];
  }
  return undefined;
}

function parseLiteral(s: string): unknown {
  const trimmed = s.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  // Quoted string — single or double
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
   || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  const n = Number(trimmed);
  if (!Number.isNaN(n)) return n;
  return undefined;
}

function compareValues(left: unknown, op: string, right: unknown): boolean {
  switch (op) {
    case '===': return left === right;
    case '!==': return left !== right;
    case '>':
      return typeof left === 'number' && typeof right === 'number' && left > right;
    case '<':
      return typeof left === 'number' && typeof right === 'number' && left < right;
    case '>=':
      return typeof left === 'number' && typeof right === 'number' && left >= right;
    case '<=':
      return typeof left === 'number' && typeof right === 'number' && left <= right;
    default: return false;
  }
}

// ============================================================================
// TODO — features not in v1
// ============================================================================
//
//  - Compound filter expressions (rule.trigger.filter)
//      Single-comparison filters are supported via evaluateFilter() above.
//      Multi-condition expressions (AND/OR, parens) are not — model them as
//      multiple rules with shared triggers, or extend the evaluator when a
//      real use case lands.
//
//  - Post-calc rules
//      MINIMUM_GUARANTEE_*, OVERTIME_PREMIUM, MAXIMUM_CAP_PERIOD, etc. fire
//      at settlement-build time across all legs in the period — not during
//      per-leg calc. Lives in the settlement-build module (not yet written).
//
//  - Driver "away from home days" trigger source
//      For per-diem rules. Needs the broader leg/home-terminal computation
//      that goes beyond a single leg's context.
