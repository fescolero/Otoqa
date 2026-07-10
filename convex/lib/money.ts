// Money primitives for the pay engine.
//
// Every monetary amount in the pay engine is stored as an integer count of
// the smallest unit of its currency (cents for USD/CAD, centavos for MXN).
// Rates additionally support sub-cent precision via MicroCents (1/1000 cent).
// Floating-point numbers are never used to represent money — IEEE 754 doubles
// cannot exactly represent decimal fractions, and the rounding errors compound
// across hundreds of thousands of payable rows per year.
//
// Two branded types prevent accidental cross-use:
//   Cents      — for amounts, balances, totals  (persisted as v.int64)
//   MicroCents — for rates                      (persisted as v.int64)
//
// The branding is purely structural: at runtime both are bigint. The compiler
// catches incorrect mixing. Use the conversion helpers when crossing types.
//
// Rounding default is HALF_UP, matching IRS payroll rounding guidance.
// Currency mismatches throw — there is no built-in FX; reporting layers that
// need cross-currency aggregation must supply explicit conversion rates.

// ============================================================================
// TYPES
// ============================================================================

declare const __cents: unique symbol;
declare const __microCents: unique symbol;

export type Cents = bigint & { readonly [__cents]: true };
export type MicroCents = bigint & { readonly [__microCents]: true };

/** Basis points: 10000 = 100%. Stored as `number` because precision needed
 *  is small (5 decimal places of a percentage) and arithmetic is rare. */
export type Bps = number;

export type Currency = 'USD' | 'CAD' | 'MXN';
export const SUPPORTED_CURRENCIES = ['USD', 'CAD', 'MXN'] as const;

export type RoundingMode =
  | 'HALF_UP'      // 0.5 → 1, -0.5 → -1     (default; IRS payroll guidance)
  | 'HALF_EVEN'    // banker's rounding
  | 'FLOOR'        // toward -∞
  | 'CEIL'         // toward +∞
  | 'TRUNCATE';    // toward 0

const ZERO_BIG = BigInt(0);
const ONE_BIG = BigInt(1);
const TEN_BIG = BigInt(10);
const TWO_BIG = BigInt(2);

// Scaling factor between Cents and MicroCents (1 cent = 1000 microcents).
const MICRO_PER_CENT = BigInt(1000);

// Currency → number of decimal places in the smallest unit (cents/centavos).
// All currently supported currencies use 2; structure permits future JPY (0) or BHD (3).
const CURRENCY_DECIMALS: Record<Currency, number> = {
  USD: 2,
  CAD: 2,
  MXN: 2,
};

const CURRENCY_DISPLAY: Record<Currency, string> = {
  USD: 'en-US',
  CAD: 'en-CA',
  MXN: 'es-MX',
};

// ============================================================================
// BRANDED-TYPE CONSTRUCTORS
// ============================================================================

/** Brand a raw bigint as Cents without conversion. Use only when you have a
 *  value that is already in the smallest currency unit (e.g. reading from DB). */
export function asCents(value: bigint): Cents {
  return value as Cents;
}

/** Brand a raw bigint as MicroCents without conversion. */
export function asMicroCents(value: bigint): MicroCents {
  return value as MicroCents;
}

/** Strip the brand and return the raw bigint. */
export function rawCents(value: Cents): bigint {
  return value as bigint;
}

export function rawMicroCents(value: MicroCents): bigint {
  return value as bigint;
}

export const ZERO_CENTS: Cents = asCents(ZERO_BIG);
export const ZERO_MICRO_CENTS: MicroCents = asMicroCents(ZERO_BIG);

// ============================================================================
// DECIMAL STRING ↔ CENTS  (canonical conversion; no precision loss)
// ============================================================================

/** Parse a decimal string like "1234.56" or "-12.5" into Cents.
 *  Always prefer this over the number-based converter for user/external input. */
export function centsFromDecimalString(input: string, currency: Currency = 'USD'): Cents {
  const decimals = CURRENCY_DECIMALS[currency];
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('centsFromDecimalString: empty input');

  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new Error(`centsFromDecimalString: not a decimal number: ${input}`);

  const sign = match[1] === '-' ? BigInt(-1) : ONE_BIG;
  const wholePart = BigInt(match[2]);
  const fracInput = match[3] ?? '';

  // Right-pad or truncate the fractional part to currency decimals.
  // Truncation does NOT round; if the caller passed more decimal places than
  // the currency supports, that's a programming error — fail loudly.
  if (fracInput.length > decimals) {
    throw new Error(
      `centsFromDecimalString: too many decimal places for ${currency} ` +
      `(got ${fracInput.length}, max ${decimals}): ${input}`,
    );
  }
  const fracPadded = fracInput.padEnd(decimals, '0');
  const fracPart = fracPadded === '' ? ZERO_BIG : BigInt(fracPadded);
  const scale = pow10(decimals);
  return asCents(sign * (wholePart * scale + fracPart));
}

/** Format Cents as a plain decimal string ("1234.56"). No currency symbol. */
export function centsToDecimalString(value: Cents, currency: Currency = 'USD'): string {
  const decimals = CURRENCY_DECIMALS[currency];
  const raw = rawCents(value);
  const negative = raw < ZERO_BIG;
  const abs = negative ? -raw : raw;
  const scale = pow10(decimals);
  const whole = abs / scale;
  const frac = abs % scale;
  const fracStr = frac.toString().padStart(decimals, '0');
  const decimalStr = decimals === 0 ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${decimalStr}` : decimalStr;
}

// ============================================================================
// NUMBER ↔ CENTS  (boundary-only; precision loss possible above ~$90 trillion)
// ============================================================================

/** Convert a decimal number (e.g. 12.34) into Cents.
 *  PRECISION WARNING: floats cannot represent all decimals exactly. Use the
 *  decimal-string converter for any input that originated as text. This
 *  helper is intended for tests, fixtures, and legacy-data migration only. */
export function centsFromNumber(value: number, currency: Currency = 'USD'): Cents {
  if (!Number.isFinite(value)) {
    throw new Error(`centsFromNumber: not a finite number: ${value}`);
  }
  return centsFromDecimalString(value.toFixed(CURRENCY_DECIMALS[currency]), currency);
}

/** Convert Cents back to a plain JS number for chart/display purposes only.
 *  Above ~9e15 cents (~$90 trillion) precision is lost. Don't use for math. */
export function centsToNumber(value: Cents, currency: Currency = 'USD'): number {
  return Number(centsToDecimalString(value, currency));
}

// ============================================================================
// MICRO-CENTS  (sub-cent rate precision)
// ============================================================================

/** Convert a decimal string rate like "0.555" into MicroCents.
 *  Supports up to 5 decimal places of a currency unit (3 sub-cent digits). */
export function microCentsFromDecimalString(
  input: string,
  currency: Currency = 'USD',
): MicroCents {
  const decimals = CURRENCY_DECIMALS[currency] + 3; // 3 extra digits for sub-cent
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('microCentsFromDecimalString: empty input');

  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) throw new Error(`microCentsFromDecimalString: not a number: ${input}`);

  const sign = match[1] === '-' ? BigInt(-1) : ONE_BIG;
  const wholePart = BigInt(match[2]);
  const fracInput = match[3] ?? '';

  if (fracInput.length > decimals) {
    throw new Error(
      `microCentsFromDecimalString: too many decimal places for ${currency} ` +
      `(got ${fracInput.length}, max ${decimals}): ${input}`,
    );
  }
  const fracPadded = fracInput.padEnd(decimals, '0');
  const fracPart = fracPadded === '' ? ZERO_BIG : BigInt(fracPadded);
  const scale = pow10(decimals);
  return asMicroCents(sign * (wholePart * scale + fracPart));
}

export function microCentsFromNumber(value: number, currency: Currency = 'USD'): MicroCents {
  if (!Number.isFinite(value)) {
    throw new Error(`microCentsFromNumber: not a finite number: ${value}`);
  }
  // Toward-zero string formatting up to the max precision microcents allow.
  const decimals = CURRENCY_DECIMALS[currency] + 3;
  return microCentsFromDecimalString(value.toFixed(decimals), currency);
}

/** Round MicroCents down to Cents using the requested rounding mode. */
export function microCentsToCents(value: MicroCents, mode: RoundingMode = 'HALF_UP'): Cents {
  return asCents(divideRound(rawMicroCents(value), MICRO_PER_CENT, mode));
}

/** Promote Cents to MicroCents (exact; multiplies by 1000). */
export function centsToMicroCents(value: Cents): MicroCents {
  return asMicroCents(rawCents(value) * MICRO_PER_CENT);
}

// ============================================================================
// ARITHMETIC
// ============================================================================

export function sumCents(values: readonly Cents[]): Cents {
  let total = ZERO_BIG;
  for (const v of values) total += rawCents(v);
  return asCents(total);
}

export function sumMicroCents(values: readonly MicroCents[]): MicroCents {
  let total = ZERO_BIG;
  for (const v of values) total += rawMicroCents(v);
  return asMicroCents(total);
}

export function negate(value: Cents): Cents {
  return asCents(-rawCents(value));
}

export function abs(value: Cents): Cents {
  const raw = rawCents(value);
  return asCents(raw < ZERO_BIG ? -raw : raw);
}

export function isNegative(value: Cents): boolean {
  return rawCents(value) < ZERO_BIG;
}

export function isZero(value: Cents): boolean {
  return rawCents(value) === ZERO_BIG;
}

export function compareCents(a: Cents, b: Cents): -1 | 0 | 1 {
  const ra = rawCents(a);
  const rb = rawCents(b);
  if (ra < rb) return -1;
  if (ra > rb) return 1;
  return 0;
}

/** Multiply Cents by a basis-points multiplier (10000 = 100%, 15000 = 1.5x).
 *  Used for OT premium, percentage allocations, percent-of-load calculations. */
export function multiplyByBps(value: Cents, bps: Bps, mode: RoundingMode = 'HALF_UP'): Cents {
  if (!Number.isFinite(bps)) throw new Error(`multiplyByBps: bps not finite: ${bps}`);
  if (!Number.isInteger(bps)) throw new Error(`multiplyByBps: bps must be integer: ${bps}`);
  const bpsBig = BigInt(bps);
  const divisor = BigInt(10000);
  return asCents(divideRound(rawCents(value) * bpsBig, divisor, mode));
}

/** Convert a percentage (e.g. 75 for 75%) into "micro-percent-points" — the
 *  convention used when a rateRule represents a percentage of a Cents base.
 *  In this scheme, 100% = 100,000,000 micro-pct-points, so that:
 *    amountCents = baseCents × microPctPoints / 100,000,000
 *  keeps full precision under BigInt math. Accepts up to 5 decimal places of
 *  percent precision (e.g. 12.34567%). */
export function percentToMicroPctPoints(percent: number): bigint {
  if (!Number.isFinite(percent)) {
    throw new Error(`percentToMicroPctPoints: not finite: ${percent}`);
  }
  // 1% = 1,000,000 micro-pct-points. Round half-up at 6 decimal places.
  return BigInt(Math.round(percent * 1_000_000));
}

/** Multiply a Cents base by a percentage stored as micro-pct-points.
 *  Returns Cents, rounded HALF_UP by default. */
export function multiplyCentsByPercent(
  base: Cents,
  microPctPoints: bigint,
  mode: RoundingMode = 'HALF_UP',
): Cents {
  const HUNDRED_MILLION = BigInt(100_000_000);
  return asCents(divideRound(rawCents(base) * microPctPoints, HUNDRED_MILLION, mode));
}

/** Calc-engine primary op: rate × quantity → amount.
 *  rate is MicroCents (sub-cent precision); quantity is a regular number
 *  (miles/hours/stops, may have decimal places). Result is Cents, rounded. */
export function multiplyRateByQuantity(
  rate: MicroCents,
  quantity: number,
  mode: RoundingMode = 'HALF_UP',
): Cents {
  if (!Number.isFinite(quantity)) {
    throw new Error(`multiplyRateByQuantity: quantity not finite: ${quantity}`);
  }
  // Convert quantity to a high-precision integer factor. Use up to 6 decimal
  // places of quantity, which covers practical needs (mile fractions, hour
  // fractions). Anything beyond is unrealistic for trucking pay.
  const QTY_SCALE = BigInt(1_000_000);
  const qtyScaled = BigInt(Math.round(quantity * 1_000_000));
  // result in (microcent × micro-quantity); divide by quantity scale to get
  // microcents, then divide by MICRO_PER_CENT to get cents.
  const productMicroCents = divideRound(rawMicroCents(rate) * qtyScaled, QTY_SCALE, mode);
  return asCents(divideRound(productMicroCents, MICRO_PER_CENT, mode));
}

/** Apply a tiered rate schedule to a quantity. Returns total Cents.
 *  Tiers must be sorted ascending by minQty and not overlap. Caller validates. */
export function applyTieredRate(
  tiers: ReadonlyArray<{ minQty: number; maxQty?: number; rate: MicroCents }>,
  quantity: number,
  mode: RoundingMode = 'HALF_UP',
): Cents {
  if (!Number.isFinite(quantity)) {
    throw new Error(`applyTieredRate: quantity not finite: ${quantity}`);
  }
  if (quantity <= 0) return ZERO_CENTS;
  let total = ZERO_BIG;
  for (const tier of tiers) {
    if (quantity <= tier.minQty) break;
    const tierTop = tier.maxQty ?? Number.POSITIVE_INFINITY;
    const tierBottom = tier.minQty;
    const qtyInTier = Math.min(quantity, tierTop) - tierBottom;
    if (qtyInTier <= 0) continue;
    const tierAmount = multiplyRateByQuantity(tier.rate, qtyInTier, mode);
    total += rawCents(tierAmount);
  }
  return asCents(total);
}

// ============================================================================
// CCPA / DEDUCTION ORDERING HELPERS
// ============================================================================

/** Federal CCPA disposable-earnings limit for ordinary garnishments: 25%.
 *  Caller passes disposable earnings (gross minus mandatory withholding).
 *  Returns the maximum amount that can be garnished after the existing pool. */
export function maxAllowedGarnishment(disposableEarnings: Cents, alreadyGarnished: Cents): Cents {
  const cap = multiplyByBps(disposableEarnings, 2500, 'FLOOR'); // 25% rounded down
  const remaining = rawCents(cap) - rawCents(alreadyGarnished);
  return asCents(remaining < ZERO_BIG ? ZERO_BIG : remaining);
}

// ============================================================================
// FORMATTING (display only — uses Number, accepts the precision tradeoff)
// ============================================================================

/** Format Cents for display with currency symbol and locale. */
export function formatCents(
  value: Cents,
  currency: Currency,
  opts: { signMode?: 'auto' | 'always' | 'never' } = {},
): string {
  const locale = CURRENCY_DISPLAY[currency];
  const asNumber = centsToNumber(value, currency);
  const sign = opts.signMode ?? 'auto';
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay: 'symbol',
    signDisplay: sign === 'always' ? 'always' : sign === 'never' ? 'never' : 'auto',
  });
  return formatter.format(asNumber);
}

/** Format MicroCents at full sub-cent precision (e.g. "0.555/mi" → "$0.555").
 *  For display only; not currency-formatted with thousands separators. */
export function formatMicroCents(value: MicroCents, currency: Currency): string {
  const decimals = CURRENCY_DECIMALS[currency] + 3;
  const raw = rawMicroCents(value);
  const negative = raw < ZERO_BIG;
  const absVal = negative ? -raw : raw;
  const scale = pow10(decimals);
  const whole = absVal / scale;
  const frac = absVal % scale;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  const wholeStr = whole.toString();
  const decimalStr = fracStr === '' ? wholeStr : `${wholeStr}.${fracStr}`;
  const symbol = getCurrencySymbol(currency);
  return `${negative ? '-' : ''}${symbol}${decimalStr}`;
}

export function getCurrencySymbol(currency: Currency): string {
  // Minimal; Intl gives the full thing for display, this is for compact contexts.
  switch (currency) {
    case 'USD': return '$';
    case 'CAD': return 'CA$';
    case 'MXN': return 'MX$';
  }
}

export function getCurrencyDecimals(currency: Currency): number {
  return CURRENCY_DECIMALS[currency];
}

// ============================================================================
// VALIDATION & GUARDS
// ============================================================================

export function isValidCurrency(value: unknown): value is Currency {
  return typeof value === 'string'
    && (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** Throw if items don't all share the same currency.
 *  Pay engine forbids cross-currency arithmetic without explicit FX. */
export function assertSameCurrency(
  items: ReadonlyArray<{ currency: Currency }>,
  context = 'operation',
): Currency {
  if (items.length === 0) {
    throw new Error(`assertSameCurrency: empty items for ${context}`);
  }
  const first = items[0].currency;
  for (let i = 1; i < items.length; i++) {
    if (items[i].currency !== first) {
      throw new Error(
        `assertSameCurrency: mixed currencies in ${context} ` +
        `(${first} vs ${items[i].currency} at index ${i})`,
      );
    }
  }
  return first;
}

// ============================================================================
// JSON SERIALIZATION (for external APIs / webhooks that can't carry BigInt)
// ============================================================================

/** Serialize Cents as a string for JSON transport.
 *  BigInt is not JSON-native; strings preserve precision and are unambiguous. */
export function serializeCents(value: Cents): string {
  return rawCents(value).toString();
}

export function deserializeCents(value: string | number | bigint): Cents {
  if (typeof value === 'bigint') return asCents(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`deserializeCents: non-integer number cannot represent cents: ${value}`);
    }
    return asCents(BigInt(value));
  }
  if (typeof value === 'string') {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`deserializeCents: not an integer string: ${value}`);
    }
    return asCents(BigInt(value));
  }
  throw new Error(`deserializeCents: unsupported type: ${typeof value}`);
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

function pow10(exp: number): bigint {
  let result = ONE_BIG;
  for (let i = 0; i < exp; i++) result *= TEN_BIG;
  return result;
}

/** Integer division with explicit rounding mode. Both operands are bigints.
 *  Sign of result matches mathematical division (not truncated). */
function divideRound(num: bigint, denom: bigint, mode: RoundingMode): bigint {
  if (denom === ZERO_BIG) throw new Error('divideRound: division by zero');
  // bigint division in JS truncates toward zero. We need explicit modes.
  const negativeResult = (num < ZERO_BIG) !== (denom < ZERO_BIG);
  const absNum = num < ZERO_BIG ? -num : num;
  const absDenom = denom < ZERO_BIG ? -denom : denom;
  const q = absNum / absDenom;
  const r = absNum % absDenom;

  if (r === ZERO_BIG) return negativeResult ? -q : q;

  let absResult: bigint;
  switch (mode) {
    case 'TRUNCATE':
      absResult = q;
      break;
    case 'FLOOR':
      absResult = negativeResult ? q + ONE_BIG : q;
      break;
    case 'CEIL':
      absResult = negativeResult ? q : q + ONE_BIG;
      break;
    case 'HALF_UP': {
      // Round half away from zero.
      const doubleR = r * TWO_BIG;
      absResult = doubleR >= absDenom ? q + ONE_BIG : q;
      break;
    }
    case 'HALF_EVEN': {
      // Banker's rounding: ties go to nearest even.
      const doubleR = r * TWO_BIG;
      if (doubleR > absDenom) {
        absResult = q + ONE_BIG;
      } else if (doubleR < absDenom) {
        absResult = q;
      } else {
        absResult = q % TWO_BIG === ZERO_BIG ? q : q + ONE_BIG;
      }
      break;
    }
  }
  return negativeResult ? -absResult : absResult;
}
