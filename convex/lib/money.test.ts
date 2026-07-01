import { describe, it, expect } from 'vitest';
import {
  asCents,
  asMicroCents,
  rawCents,
  rawMicroCents,
  ZERO_CENTS,
  centsFromDecimalString,
  centsToDecimalString,
  centsFromNumber,
  centsToNumber,
  microCentsFromDecimalString,
  microCentsFromNumber,
  microCentsToCents,
  centsToMicroCents,
  sumCents,
  sumMicroCents,
  negate,
  abs,
  isNegative,
  isZero,
  compareCents,
  multiplyByBps,
  multiplyRateByQuantity,
  applyTieredRate,
  percentToMicroPctPoints,
  multiplyCentsByPercent,
  maxAllowedGarnishment,
  formatCents,
  formatMicroCents,
  getCurrencySymbol,
  getCurrencyDecimals,
  isValidCurrency,
  assertSameCurrency,
  serializeCents,
  deserializeCents,
  type Cents,
  type MicroCents,
} from './money';

describe('centsFromDecimalString / centsToDecimalString — canonical conversion', () => {
  it('parses whole dollars', () => {
    expect(rawCents(centsFromDecimalString('100', 'USD'))).toBe(BigInt(10000));
  });

  it('parses decimal amounts exactly', () => {
    expect(rawCents(centsFromDecimalString('1234.56', 'USD'))).toBe(BigInt(123456));
    expect(rawCents(centsFromDecimalString('0.01', 'USD'))).toBe(BigInt(1));
    expect(rawCents(centsFromDecimalString('0.10', 'USD'))).toBe(BigInt(10));
  });

  it('parses negative amounts', () => {
    expect(rawCents(centsFromDecimalString('-12.34', 'USD'))).toBe(BigInt(-1234));
  });

  it('handles missing fractional part', () => {
    expect(rawCents(centsFromDecimalString('5', 'USD'))).toBe(BigInt(500));
    expect(rawCents(centsFromDecimalString('5.', 'USD'))).toBe(BigInt(500));
  });

  it('round-trips through string format', () => {
    const cases = ['0.00', '0.01', '1.00', '99.99', '1234.56', '-0.05', '-99999.99'];
    for (const s of cases) {
      const cents = centsFromDecimalString(s, 'USD');
      expect(centsToDecimalString(cents, 'USD')).toBe(s);
    }
  });

  it('rejects too many decimal places', () => {
    expect(() => centsFromDecimalString('1.234', 'USD')).toThrow(/too many decimal places/);
  });

  it('rejects empty and malformed input', () => {
    expect(() => centsFromDecimalString('', 'USD')).toThrow();
    expect(() => centsFromDecimalString('abc', 'USD')).toThrow();
    expect(() => centsFromDecimalString('1.2.3', 'USD')).toThrow();
  });

  it('formats with leading zero padding for fractional part', () => {
    expect(centsToDecimalString(asCents(BigInt(5)), 'USD')).toBe('0.05');
    expect(centsToDecimalString(asCents(BigInt(50)), 'USD')).toBe('0.50');
  });
});

describe('centsFromNumber / centsToNumber — boundary helpers', () => {
  it('converts simple numbers', () => {
    expect(rawCents(centsFromNumber(12.34))).toBe(BigInt(1234));
    expect(rawCents(centsFromNumber(0))).toBe(BigInt(0));
    expect(rawCents(centsFromNumber(-5.50))).toBe(BigInt(-550));
  });

  it('rejects non-finite numbers', () => {
    expect(() => centsFromNumber(NaN)).toThrow();
    expect(() => centsFromNumber(Infinity)).toThrow();
  });

  it('handles the classic 0.1 + 0.2 case correctly', () => {
    // The bug we're trying to avoid: 0.1 + 0.2 = 0.30000000000000004 in floats.
    // Our cents-based math gives the exact answer.
    const a = centsFromNumber(0.1);
    const b = centsFromNumber(0.2);
    const sum = sumCents([a, b]);
    expect(centsToDecimalString(sum)).toBe('0.30');
  });

  it('round-trips small numbers cleanly', () => {
    expect(centsToNumber(centsFromNumber(99.99))).toBe(99.99);
  });
});

describe('MicroCents — sub-cent rate precision', () => {
  it('represents $0.555/mi exactly', () => {
    const rate = microCentsFromDecimalString('0.555', 'USD');
    expect(rawMicroCents(rate)).toBe(BigInt(55500));
  });

  it('multiplies $0.555/mi × 100 mi = $55.50 exactly', () => {
    const rate = microCentsFromDecimalString('0.555', 'USD');
    const amount = multiplyRateByQuantity(rate, 100);
    expect(centsToDecimalString(amount)).toBe('55.50');
  });

  it('rounds half-up on the boundary', () => {
    // $0.555 × 1 = $0.555, rounds to $0.56 (half-up away from zero)
    const rate = microCentsFromDecimalString('0.555', 'USD');
    const amount = multiplyRateByQuantity(rate, 1);
    expect(centsToDecimalString(amount)).toBe('0.56');
  });

  it('rounds half-even (banker) on the boundary', () => {
    const rate = microCentsFromDecimalString('0.005', 'USD'); // 5 microcents
    // 0.5 cents rounds to 0 (nearest even) under HALF_EVEN
    const amount = multiplyRateByQuantity(rate, 1, 'HALF_EVEN');
    expect(centsToDecimalString(amount)).toBe('0.00');
    // 1.5 cents rounds to 2 (nearest even)
    const amount2 = multiplyRateByQuantity(rate, 3, 'HALF_EVEN');
    expect(centsToDecimalString(amount2)).toBe('0.02');
  });

  it('promotes Cents to MicroCents exactly', () => {
    const c = centsFromDecimalString('1.23', 'USD');
    const mc = centsToMicroCents(c);
    expect(rawMicroCents(mc)).toBe(BigInt(123000));
  });

  it('demotes MicroCents to Cents with rounding', () => {
    expect(rawCents(microCentsToCents(asMicroCents(BigInt(1499))))).toBe(BigInt(1));
    expect(rawCents(microCentsToCents(asMicroCents(BigInt(1500))))).toBe(BigInt(2)); // half-up
    expect(rawCents(microCentsToCents(asMicroCents(BigInt(1500)), 'HALF_EVEN'))).toBe(BigInt(2));
    expect(rawCents(microCentsToCents(asMicroCents(BigInt(2500)), 'HALF_EVEN'))).toBe(BigInt(2));
  });

  it('rejects too many decimal places for currency', () => {
    expect(() => microCentsFromDecimalString('0.123456', 'USD')).toThrow(/too many decimal places/);
  });

  it('handles negative rates (rare but valid for offsets)', () => {
    const mc = microCentsFromDecimalString('-0.005', 'USD');
    expect(rawMicroCents(mc)).toBe(BigInt(-500));
  });
});

describe('arithmetic operations', () => {
  it('sums cents', () => {
    const total = sumCents([
      asCents(BigInt(100)),
      asCents(BigInt(250)),
      asCents(BigInt(-50)),
    ]);
    expect(rawCents(total)).toBe(BigInt(300));
  });

  it('sums an empty array to zero', () => {
    expect(rawCents(sumCents([]))).toBe(BigInt(0));
  });

  it('sums microcents', () => {
    const total = sumMicroCents([asMicroCents(BigInt(500)), asMicroCents(BigInt(700))]);
    expect(rawMicroCents(total)).toBe(BigInt(1200));
  });

  it('negates and absolutes', () => {
    expect(rawCents(negate(asCents(BigInt(100))))).toBe(BigInt(-100));
    expect(rawCents(negate(asCents(BigInt(-100))))).toBe(BigInt(100));
    expect(rawCents(abs(asCents(BigInt(-100))))).toBe(BigInt(100));
    expect(rawCents(abs(asCents(BigInt(100))))).toBe(BigInt(100));
  });

  it('predicates', () => {
    expect(isNegative(asCents(BigInt(-1)))).toBe(true);
    expect(isNegative(asCents(BigInt(0)))).toBe(false);
    expect(isZero(ZERO_CENTS)).toBe(true);
    expect(isZero(asCents(BigInt(1)))).toBe(false);
  });

  it('compares', () => {
    expect(compareCents(asCents(BigInt(100)), asCents(BigInt(200)))).toBe(-1);
    expect(compareCents(asCents(BigInt(200)), asCents(BigInt(200)))).toBe(0);
    expect(compareCents(asCents(BigInt(300)), asCents(BigInt(200)))).toBe(1);
  });
});

describe('multiplyByBps — basis-point multiplier', () => {
  it('applies 100% (10000 bps) unchanged', () => {
    const result = multiplyByBps(asCents(BigInt(12345)), 10000);
    expect(rawCents(result)).toBe(BigInt(12345));
  });

  it('applies 75% (PCT_OF_LOAD style)', () => {
    const result = multiplyByBps(asCents(BigInt(100000)), 7500);
    expect(rawCents(result)).toBe(BigInt(75000));
  });

  it('applies 1.5x for OT premium', () => {
    const result = multiplyByBps(asCents(BigInt(1000)), 15000);
    expect(rawCents(result)).toBe(BigInt(1500));
  });

  it('rounds half-up by default', () => {
    // 333 cents × 5000 bps = 166.5 cents → 167 under HALF_UP
    expect(rawCents(multiplyByBps(asCents(BigInt(333)), 5000))).toBe(BigInt(167));
  });

  it('rejects non-integer bps (precision discipline)', () => {
    expect(() => multiplyByBps(asCents(BigInt(100)), 50.5)).toThrow();
  });
});

describe('multiplyRateByQuantity — the calc engine primary op', () => {
  it('handles a standard mileage rule: $0.55/mi × 100 mi = $55.00', () => {
    const rate = microCentsFromDecimalString('0.55', 'USD');
    const amount = multiplyRateByQuantity(rate, 100);
    expect(centsToDecimalString(amount)).toBe('55.00');
  });

  it('handles fractional miles: $0.55/mi × 47.3 mi', () => {
    const rate = microCentsFromDecimalString('0.55', 'USD');
    const amount = multiplyRateByQuantity(rate, 47.3);
    // 0.55 × 47.3 = 26.015 → 26.02 (HALF_UP)
    expect(centsToDecimalString(amount)).toBe('26.02');
  });

  it('handles hourly pay: $28.50/hr × 8.5 hr = $242.25', () => {
    const rate = microCentsFromDecimalString('28.50', 'USD');
    const amount = multiplyRateByQuantity(rate, 8.5);
    expect(centsToDecimalString(amount)).toBe('242.25');
  });

  it('returns zero for zero quantity', () => {
    const rate = microCentsFromDecimalString('0.55', 'USD');
    expect(rawCents(multiplyRateByQuantity(rate, 0))).toBe(BigInt(0));
  });

  it('handles zero rate', () => {
    expect(rawCents(multiplyRateByQuantity(asMicroCents(BigInt(0)), 100))).toBe(BigInt(0));
  });
});

describe('applyTieredRate — tiered/bracketed pay rules', () => {
  it('all quantity in first tier', () => {
    const tiers = [
      { minQty: 0, maxQty: 100, rate: microCentsFromDecimalString('0.50', 'USD') },
      { minQty: 100, rate: microCentsFromDecimalString('0.55', 'USD') },
    ];
    const amount = applyTieredRate(tiers, 50);
    expect(centsToDecimalString(amount)).toBe('25.00'); // 50 × 0.50
  });

  it('spans multiple tiers', () => {
    const tiers = [
      { minQty: 0, maxQty: 100, rate: microCentsFromDecimalString('0.50', 'USD') },
      { minQty: 100, maxQty: 300, rate: microCentsFromDecimalString('0.55', 'USD') },
      { minQty: 300, rate: microCentsFromDecimalString('0.60', 'USD') },
    ];
    // 100 × 0.50 + 200 × 0.55 + 50 × 0.60 = 50 + 110 + 30 = $190.00
    const amount = applyTieredRate(tiers, 350);
    expect(centsToDecimalString(amount)).toBe('190.00');
  });

  it('handles open-ended top tier', () => {
    const tiers = [
      { minQty: 0, maxQty: 100, rate: microCentsFromDecimalString('0.50', 'USD') },
      { minQty: 100, rate: microCentsFromDecimalString('0.55', 'USD') },
    ];
    // 100 × 0.50 + 9900 × 0.55 = 50 + 5445 = $5495.00
    const amount = applyTieredRate(tiers, 10000);
    expect(centsToDecimalString(amount)).toBe('5495.00');
  });

  it('returns zero for zero or negative quantity', () => {
    const tiers = [{ minQty: 0, rate: microCentsFromDecimalString('0.50', 'USD') }];
    expect(rawCents(applyTieredRate(tiers, 0))).toBe(BigInt(0));
    expect(rawCents(applyTieredRate(tiers, -5))).toBe(BigInt(0));
  });
});

describe('percent helpers — micro-pct-points convention', () => {
  it('converts whole percents', () => {
    expect(percentToMicroPctPoints(75)).toBe(BigInt(75_000_000));
    expect(percentToMicroPctPoints(100)).toBe(BigInt(100_000_000));
    expect(percentToMicroPctPoints(0)).toBe(BigInt(0));
  });

  it('handles fractional percents up to 5 decimal places', () => {
    expect(percentToMicroPctPoints(12.5)).toBe(BigInt(12_500_000));
    expect(percentToMicroPctPoints(0.001)).toBe(BigInt(1000));
  });

  it('multiplies base by 75% exactly', () => {
    const base = asCents(BigInt(200_000));         // $2,000.00
    const result = multiplyCentsByPercent(base, percentToMicroPctPoints(75));
    expect(centsToDecimalString(result)).toBe('1500.00');
  });

  it('multiplies base by 12.5% exactly', () => {
    const base = asCents(BigInt(80_000));          // $800.00
    const result = multiplyCentsByPercent(base, percentToMicroPctPoints(12.5));
    expect(centsToDecimalString(result)).toBe('100.00');
  });

  it('multiplies base by 100% returns the same amount', () => {
    const base = asCents(BigInt(123_456));
    expect(rawCents(multiplyCentsByPercent(base, percentToMicroPctPoints(100)))).toBe(BigInt(123_456));
  });

  it('rounds HALF_UP on sub-cent results', () => {
    // $0.01 × 50% = $0.005 → rounds to $0.01 (half-up)
    const base = asCents(BigInt(1));
    const result = multiplyCentsByPercent(base, percentToMicroPctPoints(50));
    expect(rawCents(result)).toBe(BigInt(1));
  });

  it('rejects non-finite percent', () => {
    expect(() => percentToMicroPctPoints(NaN)).toThrow();
    expect(() => percentToMicroPctPoints(Infinity)).toThrow();
  });
});

describe('CCPA garnishment cap', () => {
  it('returns 25% of disposable earnings when nothing garnished yet', () => {
    const cap = maxAllowedGarnishment(asCents(BigInt(100000)), ZERO_CENTS);
    expect(rawCents(cap)).toBe(BigInt(25000));
  });

  it('reduces by already-garnished amount', () => {
    const cap = maxAllowedGarnishment(asCents(BigInt(100000)), asCents(BigInt(10000)));
    expect(rawCents(cap)).toBe(BigInt(15000));
  });

  it('returns zero when garnishment pool exhausted', () => {
    const cap = maxAllowedGarnishment(asCents(BigInt(100000)), asCents(BigInt(30000)));
    expect(rawCents(cap)).toBe(BigInt(0));
  });

  it('rounds floor on the cap (conservative — never over-garnish)', () => {
    // 99 cents × 25% = 24.75 cents → FLOOR → 24 cents
    const cap = maxAllowedGarnishment(asCents(BigInt(99)), ZERO_CENTS);
    expect(rawCents(cap)).toBe(BigInt(24));
  });
});

describe('formatting', () => {
  it('formats USD with symbol', () => {
    expect(formatCents(asCents(BigInt(123456)), 'USD')).toContain('1,234.56');
    expect(formatCents(asCents(BigInt(123456)), 'USD')).toMatch(/\$/);
  });

  it('formats negative amounts', () => {
    expect(formatCents(asCents(BigInt(-100)), 'USD')).toMatch(/-?\$1\.00/);
  });

  it('formats zero', () => {
    expect(formatCents(ZERO_CENTS, 'USD')).toMatch(/\$0\.00/);
  });

  it('formats CAD distinctly from USD', () => {
    const cad = formatCents(asCents(BigInt(100)), 'CAD');
    expect(cad).toMatch(/CA\$|\$/);
  });

  it('formats microCents with sub-cent precision', () => {
    const rate = microCentsFromDecimalString('0.555', 'USD');
    expect(formatMicroCents(rate, 'USD')).toBe('$0.555');
  });

  it('formats microCents stripping trailing zeros', () => {
    const rate = microCentsFromDecimalString('0.500', 'USD');
    expect(formatMicroCents(rate, 'USD')).toBe('$0.5');
  });

  it('formats microCents with no fractional part', () => {
    const rate = microCentsFromDecimalString('28', 'USD');
    expect(formatMicroCents(rate, 'USD')).toBe('$28');
  });

  it('exposes currency symbol and decimals', () => {
    expect(getCurrencySymbol('USD')).toBe('$');
    expect(getCurrencySymbol('CAD')).toBe('CA$');
    expect(getCurrencySymbol('MXN')).toBe('MX$');
    expect(getCurrencyDecimals('USD')).toBe(2);
    expect(getCurrencyDecimals('MXN')).toBe(2);
  });
});

describe('validation guards', () => {
  it('isValidCurrency narrows correctly', () => {
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('CAD')).toBe(true);
    expect(isValidCurrency('MXN')).toBe(true);
    expect(isValidCurrency('EUR')).toBe(false);
    expect(isValidCurrency('usd')).toBe(false);
    expect(isValidCurrency(null)).toBe(false);
    expect(isValidCurrency(42)).toBe(false);
  });

  it('assertSameCurrency passes when all match', () => {
    expect(assertSameCurrency([
      { currency: 'USD' as const },
      { currency: 'USD' as const },
    ])).toBe('USD');
  });

  it('assertSameCurrency throws on mismatch', () => {
    expect(() => assertSameCurrency([
      { currency: 'USD' as const },
      { currency: 'CAD' as const },
    ])).toThrow(/mixed currencies/);
  });

  it('assertSameCurrency throws on empty', () => {
    expect(() => assertSameCurrency([])).toThrow(/empty/);
  });
});

describe('JSON serialization for external boundaries', () => {
  it('round-trips through string', () => {
    const c = asCents(BigInt(123456));
    const serialized = serializeCents(c);
    expect(serialized).toBe('123456');
    expect(rawCents(deserializeCents(serialized))).toBe(BigInt(123456));
  });

  it('round-trips negative', () => {
    const c = asCents(BigInt(-5000));
    expect(rawCents(deserializeCents(serializeCents(c)))).toBe(BigInt(-5000));
  });

  it('accepts integer numbers but rejects floats', () => {
    expect(rawCents(deserializeCents(100))).toBe(BigInt(100));
    expect(() => deserializeCents(100.5)).toThrow(/non-integer/);
  });

  it('accepts bigint directly', () => {
    expect(rawCents(deserializeCents(BigInt(42)))).toBe(BigInt(42));
  });

  it('rejects malformed strings', () => {
    expect(() => deserializeCents('12.5')).toThrow();
    expect(() => deserializeCents('abc')).toThrow();
  });
});

describe('regression: classic floating-point bugs that motivated this module', () => {
  it('avoids 0.1 + 0.2 ≠ 0.3', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // confirming JS behavior
    const sum = sumCents([centsFromNumber(0.1), centsFromNumber(0.2)]);
    expect(centsToDecimalString(sum)).toBe('0.30');
  });

  it('avoids precision drift in 1000 settlements of $0.555/mi × 1mi', () => {
    const rate = microCentsFromDecimalString('0.555', 'USD');
    // Float math: 0.555 × 1000 = 554.9999... or 555.0000001 depending on platform.
    // Our math: each multiplication rounds to cents (HALF_UP → $0.56),
    // so 1000 × $0.56 = $560.00 exactly. The rounding error is local, not
    // accumulating, and is visible per line item.
    const perLeg = multiplyRateByQuantity(rate, 1);
    const total = sumCents(Array.from({ length: 1000 }, () => perLeg));
    expect(centsToDecimalString(total)).toBe('560.00');
  });

  it('produces deterministic results across many small additions', () => {
    // Stress test: 10,000 small payable rows summed.
    const values: Cents[] = Array.from({ length: 10_000 }, (_, i) =>
      centsFromNumber((i % 7) * 0.01 + 0.13)
    );
    const total1 = sumCents(values);
    const total2 = sumCents([...values].reverse());
    expect(rawCents(total1)).toBe(rawCents(total2)); // order independent
  });
});
