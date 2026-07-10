import { describe, it, expect } from 'vitest';
import {
  compareLegacyVsNew,
  type LegacyLineSummary,
} from './shadowValidate';
import type { CalculatePayResult, PayItemSpec } from './calculatePay';
import { asMicroCents, centsFromDecimalString } from '../lib/money';

// Fixture helpers — these never touch Convex.
function legacyLine(
  description: string,
  qty: number,
  rate: number,
  totalDollars: number,
  opts: { sourceType?: 'SYSTEM' | 'MANUAL'; isLocked?: boolean } = {},
): LegacyLineSummary {
  return {
    description,
    quantity: qty,
    rate,
    totalAmountDollars: totalDollars,
    totalAmountCents: BigInt(Math.round(totalDollars * 100)),
    sourceType: opts.sourceType ?? 'SYSTEM',
    isLocked: opts.isLocked ?? false,
  };
}

function newPayItem(description: string, amountStr: string): PayItemSpec {
  return {
    payeeType: 'DRIVER',
    payeeId: 'd1',
    kind: 'EARNING',
    componentId: 'c1',
    componentCode: 'WAGE_MILEAGE',
    componentBucket: 'BASE_WAGE',
    componentSign: 'CREDIT',
    lifecycleStatus: 'APPLIED',
    description,
    quantity: 1,
    rateMicroCents: asMicroCents(BigInt(0)),
    amountCents: centsFromDecimalString(amountStr, 'USD'),
    currency: 'USD',
    periodAnchorAt: 0,
    sourceRef: { kind: 'RATE_RULE', id: 'r1', loadId: 'l1', legId: 'lg1' },
    sourceData: { _variant: 'EARNING', ruleId: 'r1', profileIdSnapshot: 'p1', triggerSnapshot: '{}' },
    isLocked: false,
    isVoided: false,
  };
}

function newResult(items: PayItemSpec[], profileId: string | null = 'p1'): CalculatePayResult {
  return { selectedProfileId: profileId, payItems: items, warnings: [] };
}

describe('compareLegacyVsNew', () => {
  it('MATCH — totals equal to the cent', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([newPayItem('Mileage', '55.00')]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('MATCH');
    expect(diff.legacyTotalCents).toBe(BigInt(5500));
    expect(diff.newTotalCents).toBe(BigInt(5500));
  });

  it('ROUNDING_DIFF — within 1 cent tolerance', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([newPayItem('Mileage', '55.01')]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('ROUNDING_DIFF');
    expect(diff.differences[0].deltaCents).toBe(BigInt(1));
  });

  it('ROUNDING_DIFF — within 5 cent total tolerance for multi-line', () => {
    const legacy = [
      legacyLine('Mileage', 100, 0.55, 55.00),
      legacyLine('Stops', 3, 35, 105.00),
      legacyLine('Detention', 1, 25, 25.00),
    ];
    const result = newResult([
      newPayItem('Mileage', '55.01'),
      newPayItem('Stops', '105.01'),
      newPayItem('Detention', '25.01'),
    ]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('ROUNDING_DIFF');
  });

  it('AMOUNT_DIFF — totals differ beyond rounding, same line count', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([newPayItem('Mileage', '60.00')]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('AMOUNT_DIFF');
    expect(diff.differences[0].deltaCents).toBe(BigInt(500)); // +$5
  });

  it('STRUCTURE_DIFF — line count differs significantly + amount differs', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([
      newPayItem('Wage', '50.00'),
      newPayItem('H&W', '10.00'),
      newPayItem('Pension', '5.00'),
      newPayItem('Vacation', '2.00'),
    ]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('STRUCTURE_DIFF');
    expect(diff.differences.some(d => d.kind === 'LINE_COUNT')).toBe(true);
  });

  it('NEW_ENGINE_FAILED — no profile resolved', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([], null);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('NEW_ENGINE_FAILED');
    expect(diff.differences[0].kind).toBe('NO_PROFILE_NEW');
  });

  it('signed delta — positive means new is higher', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([newPayItem('Mileage', '60.00')]);
    const diff = compareLegacyVsNew(legacy, result);
    const totalDiff = diff.differences.find(d => d.kind === 'TOTAL_AMOUNT');
    expect(totalDiff?.deltaCents).toBeGreaterThan(BigInt(0));
  });

  it('signed delta — negative means legacy is higher', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([newPayItem('Mileage', '50.00')]);
    const diff = compareLegacyVsNew(legacy, result);
    const totalDiff = diff.differences.find(d => d.kind === 'TOTAL_AMOUNT');
    expect(totalDiff?.deltaCents).toBeLessThan(BigInt(0));
  });

  it('LOCKED_LINES_PRESENT — legacy locked lines reported and excluded from comparison', () => {
    const legacy = [
      legacyLine('Mileage', 100, 0.55, 55.00),
      legacyLine('Manual bonus', 1, 200, 200.00, { sourceType: 'MANUAL', isLocked: true }),
    ];
    // New engine doesn't know about the manual locked line. Its $55 should
    // match legacy's unlocked $55 — excluding the locked $200 from compare.
    const result = newResult([newPayItem('Mileage', '55.00')]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('MATCH');
    expect(diff.differences.some(d => d.kind === 'LOCKED_LINES_PRESENT')).toBe(true);
  });

  it('carries new-engine WARNING and FLAG into differences', () => {
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result: CalculatePayResult = {
      selectedProfileId: 'p1',
      payItems: [newPayItem('Mileage', '55.00')],
      warnings: [
        { level: 'WARNING', code: 'STALE_DATA', message: 'Stop times stale' },
        { level: 'FLAG', code: 'BAD_THING', message: 'Critical issue' },
      ],
    };
    const diff = compareLegacyVsNew(legacy, result);
    const warnDiffs = diff.differences.filter(d => d.kind === 'WARNING');
    expect(warnDiffs).toHaveLength(2);
    expect(warnDiffs[0].description).toContain('STALE_DATA');
    expect(warnDiffs[1].description).toContain('BAD_THING');
  });

  it('zero-amount legacy placeholders ignored in tolerance scaling', () => {
    // Legacy emits a $0.00 line when no profile resolved — should not inflate
    // tolerance budget for the new engine's diff.
    const legacy = [legacyLine('(No applicable charges)', 0, 0, 0)];
    const result = newResult([newPayItem('Some pay', '50.00')]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).toBe('AMOUNT_DIFF');
  });

  it('empty new payItems with valid profile resolves to AMOUNT/STRUCTURE_DIFF (not NEW_ENGINE_FAILED)', () => {
    // Profile resolved, but no rules fired (e.g., all rules filtered out)
    const legacy = [legacyLine('Base pay', 100, 0.55, 55.00)];
    const result = newResult([], 'p1');
    const diff = compareLegacyVsNew(legacy, result);
    expect(diff.classification).not.toBe('NEW_ENGINE_FAILED');
    expect(['STRUCTURE_DIFF', 'AMOUNT_DIFF']).toContain(diff.classification);
  });

  it('regression: $55.50 sub-cent rate diff is within rounding', () => {
    // Legacy used Math.round / float math; new uses exact cents.
    // 0.555 × 100 = 55.5 in legacy → either 55.50 or 55.49 depending on round
    // In new: exact 55.50. Tolerance should swallow this.
    const legacyFloatResult = 100 * 0.555; // 55.500000000000007 in JS
    const legacy = [legacyLine('Mileage', 100, 0.555, legacyFloatResult)];
    const result = newResult([newPayItem('Mileage', '55.50')]);
    const diff = compareLegacyVsNew(legacy, result);
    expect(['MATCH', 'ROUNDING_DIFF']).toContain(diff.classification);
  });
});

