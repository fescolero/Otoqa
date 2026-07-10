import { describe, it, expect } from 'vitest';
import { rollupSettlementTotals, type RollupItem } from './aggregateSettlement';
import { asCents } from '../lib/money';
import type { Id } from '../_generated/dataModel';

// Build a RollupItem with sane defaults; cents passed as plain numbers.
let seq = 0;
function item(p: {
  bucket: string;
  sign?: 'CREDIT' | 'DEBIT';
  kind?: string;
  cents: number;
  qty?: number;
  code?: string;
  componentId?: string;
  holdbackCents?: number;
}): RollupItem {
  seq += 1;
  return {
    id: `pi_${seq}` as Id<'payItems'>,
    componentId: (p.componentId ?? `cc_${p.bucket}`) as Id<'chargeComponents'>,
    componentCode: p.code ?? p.bucket,
    bucket: p.bucket,
    sign: p.sign ?? 'CREDIT',
    kind: p.kind ?? 'EARNING',
    amountCents: asCents(BigInt(p.cents)),
    quantity: p.qty ?? 1,
    holdbackCents: p.holdbackCents !== undefined ? asCents(BigInt(p.holdbackCents)) : undefined,
    currency: 'USD',
  };
}

const t = (r: ReturnType<typeof rollupSettlementTotals>) => r.totals;
const codes = (r: ReturnType<typeof rollupSettlementTotals>) => r.variances.map((v) => v.code);

describe('rollupSettlementTotals', () => {
  it('carrier mileage (the live case): earnings = gross = net, no variances', () => {
    const r = rollupSettlementTotals([
      item({ bucket: 'BASE_WAGE', cents: 3263, code: 'WAGE_MILEAGE' }),
      item({ bucket: 'BASE_WAGE', cents: 3747, code: 'WAGE_MILEAGE' }),
    ]);
    expect(t(r).earningsCents).toBe(BigInt(7010));
    expect(t(r).grossCents).toBe(BigInt(7010));
    expect(t(r).netCents).toBe(BigInt(7010));
    expect(t(r).deductionsCents).toBe(BigInt(0));
    expect(t(r).itemCount).toBe(2);
    expect(r.variances).toEqual([]);
  });

  it('buckets each kind/sign correctly and nets them — the unsigned-amount risk', () => {
    const r = rollupSettlementTotals([
      item({ bucket: 'BASE_WAGE', cents: 100000, code: 'WAGE' }),       // +1000 earnings
      item({ bucket: 'ACCESSORIAL', cents: 5000, code: 'DETENTION' }),  // +50 earnings
      item({ bucket: 'BONUS', cents: 2000, code: 'SAFETY' }),           // +20 bonus
      item({ bucket: 'REIMBURSEMENT', cents: 1500, code: 'LUMPER' }),   // +15 credit
      item({ bucket: 'DEDUCTION', sign: 'DEBIT', kind: 'TRIP_EXPENSE', cents: 7000, code: 'ADVANCE' }), // -70
      item({ bucket: 'TAX_WITHHOLDING', sign: 'DEBIT', kind: 'TAX_WITHHOLDING', cents: 3000, code: 'FED' }), // -30
      item({ bucket: 'GARNISHMENT', sign: 'DEBIT', kind: 'GARNISHMENT', cents: 2500, code: 'CHILD' }), // -25
    ]);
    // amounts are all POSITIVE magnitudes; direction comes from bucket only.
    expect(t(r).earningsCents).toBe(BigInt(105000));
    expect(t(r).bonusesCents).toBe(BigInt(2000));
    expect(t(r).creditsCents).toBe(BigInt(1500));
    expect(t(r).deductionsCents).toBe(BigInt(7000));        // stored positive
    expect(t(r).taxWithholdingCents).toBe(BigInt(3000));
    expect(t(r).garnishmentsCents).toBe(BigInt(2500));
    expect(t(r).grossCents).toBe(BigInt(108500));           // 105000+2000+1500
    expect(t(r).netCents).toBe(BigInt(108500 - 7000 - 3000 - 2500)); // 96000
    expect(codes(r)).not.toContain('NET_RECONCILE');
  });

  it('signed adjustments land in adjustments and move net by sign', () => {
    const credit = rollupSettlementTotals([item({ bucket: 'ACCESSORIAL', kind: 'MANUAL_ADJUSTMENT', sign: 'CREDIT', cents: 4000 })]);
    expect(t(credit).adjustmentsCents).toBe(BigInt(4000));
    expect(t(credit).netCents).toBe(BigInt(4000));
    const debit = rollupSettlementTotals([item({ bucket: 'DEDUCTION', kind: 'MANUAL_ADJUSTMENT', sign: 'DEBIT', cents: 4000 })]);
    expect(t(debit).adjustmentsCents).toBe(BigInt(-4000));
    expect(t(debit).netCents).toBe(BigInt(-4000));
  });

  it('REVERSAL negates its component bucket', () => {
    const r = rollupSettlementTotals([
      item({ bucket: 'BASE_WAGE', cents: 5000 }),
      item({ bucket: 'BASE_WAGE', kind: 'REVERSAL', cents: 5000 }),
    ]);
    expect(t(r).earningsCents).toBe(BigInt(0));
    expect(t(r).netCents).toBe(BigInt(0));
  });

  it('flags a negative amount (engine should emit magnitudes)', () => {
    const r = rollupSettlementTotals([item({ bucket: 'BASE_WAGE', cents: -100 })]);
    expect(codes(r)).toContain('NEGATIVE_AMOUNT');
  });

  it('rolls up per component and warns on negative net', () => {
    const r = rollupSettlementTotals([
      item({ bucket: 'BASE_WAGE', cents: 1000, componentId: 'cc_wage', code: 'WAGE', qty: 10 }),
      item({ bucket: 'BASE_WAGE', cents: 2000, componentId: 'cc_wage', code: 'WAGE', qty: 20 }),
      item({ bucket: 'DEDUCTION', sign: 'DEBIT', kind: 'TRIP_EXPENSE', cents: 9000, componentId: 'cc_adv', code: 'ADV' }),
    ]);
    const wage = r.componentTotals.find((c) => c.componentCode === 'WAGE');
    expect(wage?.amountCents).toBe(BigInt(3000));
    expect(wage?.quantity).toBe(30);
    expect(wage?.payItemCount).toBe(2);
    expect(t(r).netCents).toBe(BigInt(3000 - 9000)); // -6000
    expect(codes(r)).toContain('NEGATIVE_NET');
  });

  it('empty input → all zeros', () => {
    const r = rollupSettlementTotals([]);
    expect(t(r).grossCents).toBe(BigInt(0));
    expect(t(r).netCents).toBe(BigInt(0));
    expect(t(r).itemCount).toBe(0);
    expect(r.componentTotals).toEqual([]);
  });

  it('holdback total sums independently of net', () => {
    const r = rollupSettlementTotals([item({ bucket: 'BASE_WAGE', cents: 10000, holdbackCents: 2500 })]);
    expect(t(r).holdbackTotalCents).toBe(BigInt(2500));
    expect(t(r).netCents).toBe(BigInt(10000));
  });
});
