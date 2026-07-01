// Tests for non-earning write-coverage backfill.
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import { internal } from '../_generated/api';
import { legacyManualComponentCode } from './manualCoverage';

type T = TestConvex<typeof schema>;
const ORG = 'org_manual';
const USER = 'user_manual';

describe('legacyManualComponentCode', () => {
  it('negative → LEGACY_DEDUCTION, non-negative → LEGACY_MANUAL', () => {
    expect(legacyManualComponentCode(-350)).toBe('LEGACY_DEDUCTION');
    expect(legacyManualComponentCode(-0.01)).toBe('LEGACY_DEDUCTION');
    expect(legacyManualComponentCode(0)).toBe('LEGACY_MANUAL');
    expect(legacyManualComponentCode(195)).toBe('LEGACY_MANUAL');
  });
});

async function seed(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const driverId = await ctx.db.insert('drivers', {
      firstName: 'A', lastName: 'B', email: 'a@b.c', phone: '1',
      licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
      hireDate: '2020-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const mkComp = (code: string, bucket: 'DEDUCTION' | 'BONUS', sign: 'DEBIT' | 'CREDIT') =>
      ctx.db.insert('chargeComponents', {
        workosOrgId: ORG, code, displayName: code, bucket, sign,
        taxability: 'NONE', appliesTo: ['PAY'], isActive: true,
        createdAt: now, updatedAt: now, createdBy: USER,
      });
    await mkComp('LEGACY_DEDUCTION', 'DEDUCTION', 'DEBIT');
    await mkComp('LEGACY_MANUAL', 'BONUS', 'CREDIT');

    const mkPayable = (description: string, quantity: number, rate: number, totalAmount: number) =>
      ctx.db.insert('loadPayables', {
        driverId, description, quantity, rate, totalAmount,
        sourceType: 'MANUAL', isLocked: true, workosOrgId: ORG, createdBy: USER, createdAt: now,
      });
    await mkPayable('Fuel advance', 1, -100, -100);   // deduction
    await mkPayable('Safety bonus', 1, 50, 50);        // positive manual
    // A SYSTEM line must NOT be imported (only MANUAL).
    await mkPayable('Base Hour', 8, 31.4, 251.2).then((id) =>
      ctx.db.patch(id, { sourceType: 'SYSTEM' }),
    );
    return { driverId };
  });
}

async function driverItems(t: T, driverId: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query('payItems')
      .withIndex('by_payee_lifecycle', (q) =>
        q.eq('payeeType', 'DRIVER').eq('payeeId', driverId).eq('lifecycleStatus', 'APPLIED').eq('isVoided', false))
      .collect(),
  );
}

describe('backfillManualPayItems', () => {
  it('imports manual lines with correct component + magnitude, skips SYSTEM', async () => {
    const t = convexTest(schema);
    const { driverId } = await seed(t);

    const res = await t.mutation(internal.payEngine.manualCoverage.backfillManualPayItems, {
      workosOrgId: ORG, dryRun: false,
    });
    expect(res.inserted).toBe(2); // deduction + bonus, NOT the SYSTEM line

    const items = await driverItems(t, driverId);
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.kind).toBe('MANUAL_ADJUSTMENT');
      expect(it.sourceData?._variant).toBe('LEGACY_IMPORT');
      expect(it.amountCents > 0n).toBe(true); // magnitude, never negative
    }

    // Resolve component codes to verify the sign mapping.
    const withCodes = await t.run(async (ctx) =>
      Promise.all(items.map(async (it) => {
        const c = await ctx.db.get(it.componentId);
        return { code: c?.code, amountCents: it.amountCents };
      })),
    );
    const deduction = withCodes.find((x) => x.code === 'LEGACY_DEDUCTION');
    const bonus = withCodes.find((x) => x.code === 'LEGACY_MANUAL');
    expect(deduction?.amountCents).toBe(10000n); // |−$100| = 10000 cents
    expect(bonus?.amountCents).toBe(5000n);      // $50 = 5000 cents
  });

  it('is idempotent — re-run skips already-imported rows', async () => {
    const t = convexTest(schema);
    await seed(t);
    await t.mutation(internal.payEngine.manualCoverage.backfillManualPayItems, { workosOrgId: ORG, dryRun: false });
    const again = await t.mutation(internal.payEngine.manualCoverage.backfillManualPayItems, { workosOrgId: ORG, dryRun: false });
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it('dry-run inserts nothing', async () => {
    const t = convexTest(schema);
    const { driverId } = await seed(t);
    const res = await t.mutation(internal.payEngine.manualCoverage.backfillManualPayItems, { workosOrgId: ORG, dryRun: true });
    expect(res.inserted).toBe(0);
    expect(await driverItems(t, driverId)).toHaveLength(0);
  });
});

// Forward dual-write lifecycle (create → edit → delete).
async function seedComps(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const mk = (code: string, bucket: 'DEDUCTION' | 'BONUS', sign: 'DEBIT' | 'CREDIT') =>
      ctx.db.insert('chargeComponents', {
        workosOrgId: ORG, code, displayName: code, bucket, sign,
        taxability: 'NONE', appliesTo: ['PAY'], isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
      });
    await mk('LEGACY_DEDUCTION', 'DEDUCTION', 'DEBIT');
    await mk('LEGACY_MANUAL', 'BONUS', 'CREDIT');
    const driverId = await ctx.db.insert('drivers', {
      firstName: 'A', lastName: 'B', email: 'a@b.c', phone: '1', licenseState: 'CA',
      licenseExpiration: '2030-01-01', licenseClass: 'A', hireDate: '2020-01-01',
      employmentStatus: 'Active', employmentType: 'Full-time', organizationId: ORG,
      createdBy: USER, createdAt: now, updatedAt: now,
    });
    return { driverId };
  });
}

describe('syncManualPayItem (forward dual-write)', () => {
  const sync = (t: T, payableId: string) =>
    t.mutation(internal.payEngine.manualCoverage.syncManualPayItem, {
      workosOrgId: ORG, table: 'loadPayables', payableId,
    });

  it('create → one mirror; unchanged re-sync → no-op', async () => {
    const t = convexTest(schema);
    const { driverId } = await seedComps(t);
    const payableId = await t.run(async (ctx) =>
      ctx.db.insert('loadPayables', {
        driverId, description: 'Fuel advance', quantity: 1, rate: -100, totalAmount: -100,
        sourceType: 'MANUAL', isLocked: true, workosOrgId: ORG, createdBy: USER, createdAt: Date.now(),
      }),
    );
    expect((await sync(t, payableId)).action).toBe('upserted');
    let items = await driverItems(t, driverId);
    expect(items).toHaveLength(1);
    expect(items[0].amountCents).toBe(10000n);
    expect((await sync(t, payableId)).action).toBe('unchanged');
    items = await driverItems(t, driverId);
    expect(items).toHaveLength(1); // still exactly one
  });

  it('edit → supersedes the mirror with the new amount', async () => {
    const t = convexTest(schema);
    const { driverId } = await seedComps(t);
    const payableId = await t.run(async (ctx) =>
      ctx.db.insert('loadPayables', {
        driverId, description: 'Bonus', quantity: 1, rate: 50, totalAmount: 50,
        sourceType: 'MANUAL', isLocked: true, workosOrgId: ORG, createdBy: USER, createdAt: Date.now(),
      }),
    );
    await sync(t, payableId);
    await t.run(async (ctx) => ctx.db.patch(payableId, { rate: 80, totalAmount: 80 }));
    expect((await sync(t, payableId)).action).toBe('upserted');
    const items = await driverItems(t, driverId);
    expect(items).toHaveLength(1); // old voided, one live
    expect(items[0].amountCents).toBe(8000n);
  });

  it('delete → voids the mirror', async () => {
    const t = convexTest(schema);
    const { driverId } = await seedComps(t);
    const payableId = await t.run(async (ctx) =>
      ctx.db.insert('loadPayables', {
        driverId, description: 'Bonus', quantity: 1, rate: 50, totalAmount: 50,
        sourceType: 'MANUAL', isLocked: true, workosOrgId: ORG, createdBy: USER, createdAt: Date.now(),
      }),
    );
    await sync(t, payableId);
    await t.run(async (ctx) => ctx.db.delete(payableId));
    expect((await sync(t, payableId)).action).toBe('voided');
    expect(await driverItems(t, driverId)).toHaveLength(0);
  });
});

// Roll-forward: a manual line whose natural period already has a FINALIZED
// new-ledger statement lands on the payee's next open period instead of
// orphaning in the approved statement (the leak the perf sweep caught).
describe('syncManualPayItem — roll-forward past finalized periods', () => {
  const DAY = 86_400_000;
  const sync = (t: T, payableId: string) =>
    t.mutation(internal.payEngine.manualCoverage.syncManualPayItem, {
      workosOrgId: ORG, table: 'loadPayables', payableId,
    });
  const mkSettlement = (
    ctx: any, driverId: string, periodStart: number, periodEnd: number,
    status: 'OPEN' | 'VERIFIED', num: string,
  ) =>
    ctx.db.insert('settlements', {
      workosOrgId: ORG, statementNumber: num, payeeType: 'DRIVER', payeeId: driverId,
      periodStart, periodEnd, currency: 'USD', status,
      totals: {
        earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
        taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
        grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
      },
      componentTotals: [], createdAt: Date.now(), updatedAt: Date.now(), createdBy: USER,
    });
  const mkPayable = (ctx: any, driverId: string, createdAt: number) =>
    ctx.db.insert('loadPayables', {
      driverId, description: 'Safety bonus', quantity: 1, rate: 75, totalAmount: 75,
      sourceType: 'MANUAL', isLocked: true, workosOrgId: ORG, createdBy: USER, createdAt,
    });
  const liveItem = async (t: T, driverId: string) => (await driverItems(t, driverId))[0];

  it('finalized natural period → anchors onto the next open period', async () => {
    const t = convexTest(schema);
    const { driverId } = await seedComps(t);
    const base = Date.now();
    const p2Start = base - 9 * DAY;
    const payableId = await t.run(async (ctx) => {
      await mkSettlement(ctx, driverId, base - 20 * DAY, base - 10 * DAY, 'VERIFIED', 'SET-P1');
      await mkSettlement(ctx, driverId, p2Start, base + 5 * DAY, 'OPEN', 'SET-P2');
      return mkPayable(ctx, driverId, base - 15 * DAY); // natural anchor inside finalized P1
    });
    const res = await sync(t, payableId);
    expect(res.rolledForward).toBe(true);
    expect((await liveItem(t, driverId)).periodAnchorAt).toBe(p2Start);
  });

  it('finalized natural period, no open period → anchors to now (current run)', async () => {
    const t = convexTest(schema);
    const { driverId } = await seedComps(t);
    const base = Date.now();
    const p1End = base - 10 * DAY;
    const payableId = await t.run(async (ctx) => {
      await mkSettlement(ctx, driverId, base - 20 * DAY, p1End, 'VERIFIED', 'SET-P1');
      return mkPayable(ctx, driverId, base - 15 * DAY);
    });
    const res = await sync(t, payableId);
    expect(res.rolledForward).toBe(true);
    expect((await liveItem(t, driverId)).periodAnchorAt).toBeGreaterThan(p1End);
  });

  it('open natural period → anchor unchanged (no roll-forward)', async () => {
    const t = convexTest(schema);
    const { driverId } = await seedComps(t);
    const base = Date.now();
    const createdAt = base - 3 * DAY;
    const payableId = await t.run(async (ctx) => {
      await mkSettlement(ctx, driverId, base - 9 * DAY, base + 5 * DAY, 'OPEN', 'SET-P1');
      return mkPayable(ctx, driverId, createdAt); // inside the OPEN period
    });
    const res = await sync(t, payableId);
    expect(res.rolledForward).toBe(false);
    expect((await liveItem(t, driverId)).periodAnchorAt).toBe(createdAt);
  });
});
