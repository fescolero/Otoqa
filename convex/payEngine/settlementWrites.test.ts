// Write-layer tests — the new-ledger settlement review/approve/pay lifecycle.
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { api } from '../_generated/api';

type T = TestConvex<typeof schema>;
const ORG = 'org_writes';
const USER = 'user_writes';
const DAY = 86_400_000;

async function seed(t: T, status: 'OPEN' | 'IN_REVIEW' | 'VERIFIED' = 'IN_REVIEW') {
  return t.run(async (ctx) => {
    const now = Date.now();
    const driverId = await ctx.db.insert('drivers', {
      firstName: 'Dana', lastName: 'Cole', email: 'd@c.co', phone: '1', licenseState: 'CA',
      licenseExpiration: '2030-01-01', licenseClass: 'A', hireDate: '2020-01-01',
      employmentStatus: 'Active', employmentType: 'Full-time', organizationId: ORG,
      createdBy: USER, createdAt: now, updatedAt: now,
    });
    const mkComp = (code: string, bucket: 'BASE_WAGE' | 'DEDUCTION' | 'BONUS', sign: 'CREDIT' | 'DEBIT') =>
      ctx.db.insert('chargeComponents', {
        workosOrgId: ORG, code, displayName: code, bucket, sign, taxability: 'NONE',
        appliesTo: ['PAY'], isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
      });
    const wageComp = await mkComp('WAGE_HOURLY', 'BASE_WAGE', 'CREDIT');
    await mkComp('LEGACY_DEDUCTION', 'DEDUCTION', 'DEBIT');
    await mkComp('LEGACY_MANUAL', 'BONUS', 'CREDIT');

    const periodStart = now - 3 * DAY;
    const periodEnd = now + 3 * DAY;
    const settlementId = await ctx.db.insert('settlements', {
      workosOrgId: ORG, statementNumber: 'SET-W1', payeeType: 'DRIVER', payeeId: driverId,
      periodStart, periodEnd, currency: 'USD', status,
      totals: {
        earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
        taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
        grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
      },
      componentTotals: [], createdAt: now, updatedAt: now, createdBy: USER,
    });
    const payItemId = await ctx.db.insert('payItems', {
      workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId, kind: 'EARNING', componentId: wageComp,
      lifecycleStatus: 'APPLIED', description: 'Base Wage', quantity: 1, rateMicroCents: 100000000n,
      amountCents: 100000n, currency: 'USD', periodAnchorAt: periodStart + DAY,
      sourceRef: { kind: 'RATE_RULE', id: 'r' }, isLocked: false, isVoided: false,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    return { driverId, settlementId, payItemId };
  });
}

const authed = (t: T) => t.withIdentity({ subject: USER, org_id: ORG });

async function getSettlement(t: T, id: Id<'settlements'>) {
  return t.run(async (ctx) => ctx.db.get(id));
}

describe('settlementWrites — status lifecycle', () => {
  it('APPROVED freezes: locks payItems, sets verified, status VERIFIED', async () => {
    const t = convexTest(schema);
    const { settlementId, payItemId } = await seed(t);
    await authed(t).mutation(api.payEngine.settlementWrites.updateSettlementStatus, {
      settlementId, newStatus: 'APPROVED',
    });
    const s = await getSettlement(t, settlementId);
    expect(s?.status).toBe('VERIFIED');
    expect(s?.verifiedBy).toBe(USER);
    const item = await t.run(async (ctx) => ctx.db.get(payItemId));
    expect(item?.isLocked).toBe(true);
  });

  it('PAID stamps payment; reversePayment restores VERIFIED and clears it', async () => {
    const t = convexTest(schema);
    const { settlementId } = await seed(t, 'VERIFIED');
    await authed(t).mutation(api.payEngine.settlementWrites.updateSettlementStatus, {
      settlementId, newStatus: 'PAID', paidMethod: 'ACH', paidReference: 'W-123',
    });
    let s = await getSettlement(t, settlementId);
    expect(s?.status).toBe('PAID');
    expect(s?.paymentMethod).toBe('ACH');
    expect(s?.paymentReference).toBe('W-123');
    expect(s?.paidBy).toBe(USER);

    await authed(t).mutation(api.payEngine.settlementWrites.reversePayment, { settlementId });
    s = await getSettlement(t, settlementId);
    expect(s?.status).toBe('VERIFIED');
    expect(s?.paymentMethod).toBeUndefined();
    expect(s?.paidAt).toBeUndefined();
  });

  it('VOID stamps the reason', async () => {
    const t = convexTest(schema);
    const { settlementId } = await seed(t);
    await authed(t).mutation(api.payEngine.settlementWrites.updateSettlementStatus, {
      settlementId, newStatus: 'VOID', voidReason: 'duplicate',
    });
    const s = await getSettlement(t, settlementId);
    expect(s?.status).toBe('VOID');
    expect(s?.voidReason).toBe('duplicate');
  });
});

describe('settlementWrites — blockers + adjustments', () => {
  it('acknowledge is idempotent; unacknowledge removes it', async () => {
    const t = convexTest(schema);
    const { settlementId } = await seed(t);
    const at = authed(t);
    await at.mutation(api.payEngine.settlementWrites.acknowledgeBlocker, { settlementId, blockerKey: 'pod', note: 'ok' });
    await at.mutation(api.payEngine.settlementWrites.acknowledgeBlocker, { settlementId, blockerKey: 'pod' });
    let s = await getSettlement(t, settlementId);
    expect(s?.acknowledgedBlockers).toHaveLength(1);
    expect(s?.acknowledgedBlockers?.[0].by).toBe(USER);

    await at.mutation(api.payEngine.settlementWrites.unacknowledgeBlocker, { settlementId, blockerKey: 'pod' });
    s = await getSettlement(t, settlementId);
    expect(s?.acknowledgedBlockers).toHaveLength(0);
  });

  it('addManualAdjustment: negative → LEGACY_DEDUCTION magnitude, scoped to settlement', async () => {
    const t = convexTest(schema);
    const { settlementId } = await seed(t);
    const id = await authed(t).mutation(api.payEngine.settlementWrites.addManualAdjustment, {
      settlementId, description: 'Fuel advance', amount: -175,
    });
    const item = await t.run(async (ctx) => ctx.db.get(id));
    expect(item?.kind).toBe('MANUAL_ADJUSTMENT');
    expect(item?.amountCents).toBe(17500n); // magnitude
    expect(item?.settlementId).toBe(settlementId);
    const comp = await t.run(async (ctx) => (item ? ctx.db.get(item.componentId) : null));
    expect(comp?.code).toBe('LEGACY_DEDUCTION');
  });

  it('removePayItem voids it', async () => {
    const t = convexTest(schema);
    const { payItemId } = await seed(t);
    await authed(t).mutation(api.payEngine.settlementWrites.removePayItem, { payItemId });
    const item = await t.run(async (ctx) => ctx.db.get(payItemId));
    expect(item?.isVoided).toBe(true);
  });

  it('rejects adjustments on a finalized (VERIFIED) settlement', async () => {
    const t = convexTest(schema);
    const { settlementId } = await seed(t, 'VERIFIED');
    await expect(
      authed(t).mutation(api.payEngine.settlementWrites.addManualAdjustment, {
        settlementId, description: 'x', amount: 10,
      }),
    ).rejects.toThrow(/finalized/i);
  });
});
