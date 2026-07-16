// Frontend display helpers for the pay engine.
//
// Bridges the backend's data shape (trigger source / micro-cents / payBasis)
// to the design's human-readable labels (Per Loaded Mile, $0.62 / mi, etc.).
// Pure functions only — no Convex imports, safe to use anywhere.

// ============================================================================
// PAY MODEL LABELS (chip text on the pay-profile list)
// ============================================================================

export type PayBasis = 'MILEAGE' | 'HOURLY' | 'PERCENTAGE' | 'FLAT' | 'HYBRID';

export const PAY_BASIS_LABEL: Record<PayBasis, string> = {
  MILEAGE: 'Per-mile',
  HOURLY: 'Hourly',
  PERCENTAGE: 'Percentage',
  FLAT: 'Flat',
  HYBRID: 'Hybrid',
};

// ============================================================================
// DESIGN RATE TYPES ↔ BACKEND TRIGGER SOURCES
// ============================================================================

export type DesignRateType =
  | 'Per Total Mile'
  | 'Per Loaded Mile'
  | 'Per Empty Mile'
  | 'Per Extra Stop'
  | 'Per Extra Order Stop'
  | 'Percentage from Load'
  | 'Flat'
  | 'Hourly'
  | 'Hourly (per shift)'
  | 'Weekly';

export type TriggerSource =
  | 'constant.1'
  | 'leg.legLoadedMiles'
  | 'leg.legEmptyMiles'
  | 'leg.totalMiles'
  | 'leg.durationMinutes'
  | 'session.activeMinutes'
  | 'stops.count'
  | 'stops.dwellMinutesSum'
  | 'load.invoiceTotalCents'
  | 'load.linehaulTotalCents'
  | 'attr.hazmat'
  | 'attr.tarp'
  | 'attr.oversize';

export type Transform =
  | 'IDENTITY'
  | 'HOURS_FROM_MINUTES'
  | 'COUNT'
  | 'SUM'
  | 'PERCENT';

export type RateTypeBinding = {
  source: TriggerSource;
  transform?: Transform;
  unit: string;          // shown in the rates table ("/mi", "/hr", "% load")
  supportsDistance: boolean;
  /** When true, this row is rendered in the picker but not yet wired into
   *  the backend calc engine; submission disabled. */
  comingSoon?: boolean;
};

export const RATE_TYPE_BINDINGS: Record<DesignRateType, RateTypeBinding> = {
  'Per Total Mile':       { source: 'leg.totalMiles',         unit: '/mi',     supportsDistance: true },
  'Per Loaded Mile':      { source: 'leg.legLoadedMiles',     unit: '/mi',     supportsDistance: true },
  'Per Empty Mile':       { source: 'leg.legEmptyMiles',      unit: '/mi',     supportsDistance: true },
  'Per Extra Stop':       { source: 'stops.count',            unit: '/stop',   supportsDistance: false },
  // "Per Extra Order Stop" counts ORDERS beyond the first on a multi-stop
  // load, not stops. The backend doesn't yet have a `orders.count` trigger
  // source, and getting it right requires deciding:
  //   - what counts as an "order"? load.orderSequence rows? distinct BOLs?
  //   - does it count per stop or per load?
  //   - does it interact with split delivery scenarios?
  // Picker shows it but submission is disabled. To ship: add a new trigger
  // source in convex/payEngine/calculatePay.ts (e.g. `orders.count`), add an
  // assemble-side calculator in assembleInput.ts, then drop `comingSoon` here.
  'Per Extra Order Stop': { source: 'stops.count',            unit: '/stop',   supportsDistance: false, comingSoon: true },
  'Percentage from Load': { source: 'load.invoiceTotalCents', transform: 'PERCENT', unit: '% load', supportsDistance: false },
  'Flat':                 { source: 'constant.1',             unit: '/load',   supportsDistance: false },
  'Hourly':               { source: 'leg.durationMinutes',    transform: 'HOURS_FROM_MINUTES', unit: '/hr', supportsDistance: false },
  // Shift-scoped hours: fires once per completed session on the driver's
  // total active minutes (clock-in → clock-out), NOT per leg. The engine
  // partitions session.* rules from leg rules, so a profile can pay a base
  // rate on all shift hours plus a per-leg differential while on a load.
  'Hourly (per shift)':   { source: 'session.activeMinutes',  transform: 'HOURS_FROM_MINUTES', unit: '/hr', supportsDistance: false },
  // "Weekly" is a period-level guarantee, not a per-leg rule. It belongs in
  // payProfile.postCalcRules with kind=MINIMUM_GUARANTEE_PERIOD (already
  // supported by the calc engine — see applyPostCalcRules.ts). What's
  // missing is the UI surface: a "Bonuses & adjustments" tab on the profile
  // editor that lets users add/edit postCalcRules. The current picker only
  // edits per-rule (per-leg) payRules. To ship: build that tab, then remove
  // 'Weekly' from this trigger list (it shouldn't live alongside per-leg
  // rates — it's a different layer).
  'Weekly':               { source: 'constant.1',             unit: '/wk',     supportsDistance: false, comingSoon: true },
};

/** Default chargeComponent.code that a new rule of this rate type should use.
 *  The catalog is seeded with these codes (see seedChargeComponents.ts), so
 *  the modal can resolve componentId via convex chargeComponents.getByCode. */
export const RATE_TYPE_TO_COMPONENT_CODE: Record<DesignRateType, string> = {
  'Per Total Mile':       'WAGE_MILEAGE',
  'Per Loaded Mile':      'WAGE_MILEAGE',
  'Per Empty Mile':       'WAGE_MILEAGE',
  'Per Extra Stop':       'STOP_PAY',
  'Per Extra Order Stop': 'STOP_PAY',
  'Percentage from Load': 'WAGE_PERCENT',
  'Flat':                 'WAGE_FLAT',
  'Hourly':               'WAGE_HOURLY',
  'Hourly (per shift)':   'WAGE_HOURLY',
  'Weekly':               'WAGE_FLAT',
};

/** Reverse lookup: given a backend trigger source + optional transform, return
 *  the design label most callers will expect to see in the table. */
export function triggerToDesignType(source: string, transform?: string): DesignRateType {
  if (source === 'leg.legLoadedMiles') return 'Per Loaded Mile';
  if (source === 'leg.legEmptyMiles') return 'Per Empty Mile';
  if (source === 'leg.totalMiles') return 'Per Total Mile';
  if (source === 'stops.count') return 'Per Extra Stop';
  if (source === 'load.invoiceTotalCents' && transform === 'PERCENT') return 'Percentage from Load';
  if (source === 'leg.durationMinutes') return 'Hourly';
  if (source === 'session.activeMinutes') return 'Hourly (per shift)';
  if (source === 'constant.1') return 'Flat';
  return 'Flat';
}

// ============================================================================
// DESIGN TYPE COLORS (chip + dropdown tint, mirrors settings-screen.jsx)
// ============================================================================

export const RATE_TYPE_COLOR: Record<DesignRateType, string> = {
  'Per Total Mile':       '#1A47E6',
  'Per Loaded Mile':      '#1A47E6',
  'Per Empty Mile':       '#4B5B86',
  'Per Extra Stop':       '#7C3AED',
  'Per Extra Order Stop': '#7C3AED',
  'Percentage from Load': '#A66800',
  'Flat':                 '#5A6172',
  'Hourly':               '#0F8C5F',
  'Hourly (per shift)':   '#0F8C5F',
  'Weekly':               '#0F8C5F',
};

// ============================================================================
// MONEY FORMATTING
// ============================================================================

/** Format a MicroCents rate (BigInt, 1/1000 cent) as "$0.62" / "$0.555" /
 *  "75%" depending on the design type. Strips trailing zeros for micro
 *  precision but keeps at least 2 decimals on currency display. */
export function formatRateMicroCents(
  rateMicroCents: bigint | number | undefined,
  designType: DesignRateType,
): string {
  if (rateMicroCents === undefined || rateMicroCents === null) return '—';
  const raw = typeof rateMicroCents === 'bigint' ? rateMicroCents : BigInt(rateMicroCents);

  // PERCENT path: rate is stored as micro-pct-points (100% = 100,000,000)
  if (designType === 'Percentage from Load') {
    const percent = Number(raw) / 1_000_000; // 75_000_000 → 75
    return `${stripTrailingZeros(percent.toFixed(3))}%`;
  }

  // Normal path: rateMicroCents is 1/1000 of a cent (so 555 = $0.00555… wait,
  // that's wrong). Actually 1 micro-cent = 0.001 cent = $0.00001. So 55,500
  // micro-cents = 55.5 cents = $0.555 per unit. Compute via cents.
  const microCents = Number(raw);
  const dollars = microCents / 100_000; // microcents → dollars
  // Display rule: ≥2 decimals; up to 3 if non-zero in the sub-cent slot.
  const fixed3 = dollars.toFixed(3);
  const fixed2 = dollars.toFixed(2);
  const display = fixed3.endsWith('0') ? fixed2 : fixed3;
  const negative = dollars < 0;
  return (negative ? '-$' : '$') + display.replace('-', '');
}

/** Format Cents (BigInt) as "$1,234.56". */
export function formatCents(cents: bigint | number | undefined): string {
  if (cents === undefined || cents === null) return '—';
  const raw = typeof cents === 'bigint' ? cents : BigInt(cents);
  const dollars = Number(raw) / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(dollars);
}

function stripTrailingZeros(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

// ============================================================================
// DISTANCE OPERATORS (design has Greater than / Less than / Any)
// ============================================================================

export type DistanceOp = 'gt' | 'lt' | 'any';

/** From rule.minThreshold + rule.trigger.filter, derive the operator + value
 *  shown in the design's "Distance" column. */
export function deriveDistanceLabel(
  minThreshold: number | undefined,
  filter: string | undefined,
): { op: DistanceOp; value: number | null } {
  // ">N" → minThreshold:N
  if (minThreshold !== undefined && minThreshold > 0) {
    return { op: 'gt', value: minThreshold };
  }
  // "<N" → filter "leg.legLoadedMiles < N" (or similar)
  if (filter) {
    const m = /<\s*(\d+(?:\.\d+)?)/.exec(filter);
    if (m) return { op: 'lt', value: Number(m[1]) };
  }
  return { op: 'any', value: null };
}

export function distanceLabel(op: DistanceOp, value: number | null): string {
  if (op === 'any' || value === null) return 'Any distance';
  if (op === 'gt') return `Greater than ${value} mi`;
  return `Less than ${value} mi`;
}

// ============================================================================
// EARNING COMPONENT OPTIONS ("Counts as" pickers)
// ============================================================================
//
// Buckets a profile rate line can be classified into — earning side only
// (deductions / withholdings / garnishments are managed elsewhere). The
// classification drives paycheck bucketing and tax treatment: an hourly H&W
// line counted as Health & Welfare pays as non-taxable fringe, not base wage.

export const EARNING_BUCKETS: Record<string, string> = {
  BASE_WAGE: 'Base wage',
  BASE_FRINGE: 'Fringe',
  ACCESSORIAL: 'Accessorial',
  BONUS: 'Bonus',
};

export type EarningComponent = {
  _id: string;
  code: string;
  displayName: string;
  bucket: string;
  appliesTo: string[];
  isActive: boolean;
};

/** Build <select> options for a "Counts as" picker from the org's component
 *  catalog. `valueKey` picks what the option value carries: catalog `code`
 *  (create flows — resolved server-side) or `_id` (updateRule patches). */
export function earningComponentOptions(
  components: EarningComponent[] | undefined,
  valueKey: 'code' | '_id' = 'code',
): Array<{ value: string; label: string }> {
  if (!components) return [];
  const order = Object.keys(EARNING_BUCKETS);
  return components
    .filter(c => c.isActive && c.appliesTo.includes('PAY') && c.bucket in EARNING_BUCKETS)
    .sort((a, b) =>
      a.bucket === b.bucket
        ? a.displayName.localeCompare(b.displayName)
        : order.indexOf(a.bucket) - order.indexOf(b.bucket))
    .map(c => ({
      value: c[valueKey],
      label: `${c.displayName} · ${EARNING_BUCKETS[c.bucket]}`,
    }));
}

// ============================================================================
// PROFILE SUMMARY (one-line description shown on the list page)
// ============================================================================

export type RuleForSummary = {
  name: string;
  trigger: { source: string; transform?: string };
  rateAmountMicroCents?: bigint | number;
};

/** Produce a one-line summary like "$0.62/mi · $45/hr detention · $35 stops". */
export function composeProfileSummary(rules: RuleForSummary[]): string {
  if (rules.length === 0) return 'No rate lines configured';
  const parts: string[] = [];
  for (const r of rules.slice(0, 3)) {
    const type = triggerToDesignType(r.trigger.source, r.trigger.transform);
    const binding = RATE_TYPE_BINDINGS[type];
    const formatted = formatRateMicroCents(r.rateAmountMicroCents, type);
    parts.push(`${formatted}${binding.unit}`);
  }
  if (rules.length > 3) parts.push(`+${rules.length - 3} more`);
  return parts.join(' · ');
}

/** Primary rate string for the list page "Base rate" column — picks the
 *  lowest sortOrder rule's display. */
export function formatPrimaryRate(rules: RuleForSummary[]): string {
  if (rules.length === 0) return '—';
  const r = rules[0];
  const type = triggerToDesignType(r.trigger.source, r.trigger.transform);
  const binding = RATE_TYPE_BINDINGS[type];
  return `${formatRateMicroCents(r.rateAmountMicroCents, type)} ${binding.unit}`;
}
