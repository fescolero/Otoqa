// Read-adapter tests — the new ledger, projected into the dashboard's
// SettlementRow shape, computes the same earn/deduct/net/bucket via the shared
// helpers.
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { api, internal } from '../_generated/api';

type T = TestConvex<typeof schema>;
const ORG = 'org_reads';
const USER = 'user_reads';
const DAY = 86_400_000;

async function seed(t: T, opts: { status: 'OPEN' | 'VERIFIED'; periodEndFromNow: number }) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const driverId = await ctx.db.insert('drivers', {
      firstName: 'Sam', lastName: 'Rivera', email: 's@r.co', phone: '1', licenseState: 'CA',
      licenseExpiration: '2030-01-01', licenseClass: 'A', hireDate: '2020-01-01',
      employmentStatus: 'Active', employmentType: 'Full-time', organizationId: ORG,
      createdBy: USER, createdAt: now, updatedAt: now,
    });
    const mkComp = (code: string, bucket: 'BASE_WAGE' | 'DEDUCTION', sign: 'CREDIT' | 'DEBIT') =>
      ctx.db.insert('chargeComponents', {
        workosOrgId: ORG, code, displayName: code, bucket, sign, taxability: 'NONE',
        appliesTo: ['PAY'], isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
      });
    const wageComp = await mkComp('WAGE_HOURLY', 'BASE_WAGE', 'CREDIT');
    const dedComp = await mkComp('LEGACY_DEDUCTION', 'DEDUCTION', 'DEBIT');

    const periodStart = now - 3 * DAY;
    const periodEnd = now + opts.periodEndFromNow;
    const settlementId = await ctx.db.insert('settlements', {
      workosOrgId: ORG, statementNumber: 'SET-1', payeeType: 'DRIVER', payeeId: driverId,
      periodStart, periodEnd, currency: 'USD', status: opts.status,
      totals: {
        earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
        taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
        grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
      },
      componentTotals: [], createdAt: now, updatedAt: now, createdBy: USER,
    });

    const anchor = periodStart + DAY;
    const mkItem = (kind: 'EARNING' | 'MANUAL_ADJUSTMENT', componentId: Id<'chargeComponents'>, amountCents: bigint, description: string) =>
      ctx.db.insert('payItems', {
        workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId, kind, componentId,
        lifecycleStatus: 'APPLIED', description, quantity: 1, rateMicroCents: amountCents * 1000n,
        amountCents, currency: 'USD', periodAnchorAt: anchor,
        settlementId, // real finalized settlements have their items stamped by the aggregator
        sourceRef: kind === 'EARNING' ? { kind: 'RATE_RULE', id: 'r' } : { kind: 'LEGACY_IMPORT', id: 'x' },
        // EARNING sourceData carries real payRules/payProfiles ids in prod; the
        // adapter never reads it, so omit it here (it's optional).
        sourceData: kind === 'EARNING'
          ? undefined
          : { _variant: 'LEGACY_IMPORT', legacyTable: 'loadPayables', legacyRowId: 'x', legacyCalcSnapshot: '{}', backfillRunId: 'b', backfilledAt: now },
        isLocked: kind === 'MANUAL_ADJUSTMENT', isVoided: false, createdAt: now, updatedAt: now, createdBy: USER,
      });
    await mkItem('EARNING', wageComp, 100000n, 'Base Wage');       // $1000
    await mkItem('MANUAL_ADJUSTMENT', dedComp, 35000n, 'Fuel advance'); // $350 deduction (magnitude)

    return { driverId, settlementId };
  });
}

describe('settlementReads (new-ledger adapter)', () => {
  it('listActive: OPEN settlement → open bucket with earn/deduct/net from live payItems', async () => {
    const t = convexTest(schema);
    await seed(t, { status: 'OPEN', periodEndFromNow: 3 * DAY }); // period still open
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const res = await at.query(api.payEngine.settlementReads.listActive, { workosOrgId: ORG, view: 'open' });
    expect(res.rows).toHaveLength(1);
    const row = res.rows[0];
    expect(row.status).toBe('DRAFT');      // OPEN → legacy DRAFT
    expect(row.bucket).toBe('open');
    expect(row.payeeName).toBe('Sam Rivera');
    expect(row.earnTotal).toBe(1000);      // Base Wage
    expect(row.deductTotal).toBe(350);     // Fuel advance magnitude
    expect(row.net).toBe(650);             // 1000 − 350
    expect(row.lineCount).toBe(2);
  });

  it('getViewStats: counts + accruing reflect the open settlement', async () => {
    const t = convexTest(schema);
    await seed(t, { status: 'OPEN', periodEndFromNow: 3 * DAY });
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const stats = await at.query(api.payEngine.settlementReads.getViewStats, { workosOrgId: ORG });
    expect(stats.counts.open).toBe(1);
    expect(stats.openAccruing).toBe(650);
  });

  it('getSettlementDetails: returns the driver + itemized lines', async () => {
    const t = convexTest(schema);
    const { settlementId } = await seed(t, { status: 'VERIFIED', periodEndFromNow: -DAY });
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const d = await at.query(api.payEngine.settlementReads.getSettlementDetails, { settlementId });
    expect(d.driver?.firstName).toBe('Sam');
    expect(d.settlement.status).toBe('APPROVED'); // VERIFIED → APPROVED
    expect(d.payables).toHaveLength(2);
    expect(d.summary.net).toBe(650);
    const deduction = d.payables.find((p) => p.description === 'Fuel advance');
    expect(deduction?.totalAmount).toBe(-350); // signed for display
  });

  // Perf: settled-bucket stat sums read the materialized settlements.totals.netCents
  // instead of re-collecting each statement's payItems on every reactive tick.
  it('getViewStats: settled net sums read materialized totals, not a payItems re-collect', async () => {
    const t = convexTest(schema);
    // seed() leaves totals.netCents = 0 while its payItems net to 650 — a deliberate
    // mismatch: the old enrich-per-row path returned 650, the totals path returns 0.
    await seed(t, { status: 'VERIFIED', periodEndFromNow: -DAY });
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const stats = await at.query(api.payEngine.settlementReads.getViewStats, { workosOrgId: ORG });
    expect(stats.counts.approved).toBe(1);
    expect(stats.dueThisRun).toBe(0); // materialized totals.netCents; a re-collect would give 650
  });

  // Invariant the perf change relies on: for every bucket present today, the
  // append-only rollup's net (settlements.totals.netCents, written by the
  // aggregator) equals the net the read adapter derives from live payItems via
  // summarizeLines. They only diverge once TAX_WITHHOLDING / GARNISHMENT /
  // REVERSAL items exist (M6/M7), and totals is the correct value then.
  it('materialized net equals adapter-summarized net (aggregator ⇄ reads parity)', async () => {
    const t = convexTest(schema);
    const { driverId, settlementId } = await seed(t, { status: 'OPEN', periodEndFromNow: 3 * DAY });
    const s = await t.run((ctx) => ctx.db.get(settlementId));
    await t.mutation(internal.payEngine.aggregateSettlement.aggregateDriverSettlement, {
      workosOrgId: ORG, payeeId: driverId as string,
      periodStart: s!.periodStart, periodEnd: s!.periodEnd, userId: USER,
    });
    const after = await t.run((ctx) => ctx.db.get(settlementId));
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const d = await at.query(api.payEngine.settlementReads.getSettlementDetails, { settlementId });
    expect(Number(after!.totals.netCents) / 100).toBe(d.summary.net);
    expect(d.summary.net).toBe(650); // 1000 base − 350 deduction
  });

  // The leak the sweep caught: a manual line lands in a period AFTER its
  // statement was approved, unattached (settlementId null). A finalized
  // statement freezes to its stamped membership, so the orphan is excluded.
  it('finalized settlement excludes a post-approval in-window orphan line', async () => {
    const t = convexTest(schema);
    const { driverId, settlementId } = await seed(t, { status: 'VERIFIED', periodEndFromNow: -DAY });
    await t.run(async (ctx) => {
      const s = (await ctx.db.get(settlementId))!;
      const compId = await ctx.db.insert('chargeComponents', {
        workosOrgId: ORG, code: 'LEGACY_MANUAL', displayName: 'Manual', bucket: 'BONUS', sign: 'CREDIT',
        taxability: 'NONE', appliesTo: ['PAY'], isActive: true, createdAt: Date.now(), updatedAt: Date.now(), createdBy: USER,
      });
      await ctx.db.insert('payItems', {
        workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId, kind: 'MANUAL_ADJUSTMENT', componentId: compId,
        lifecycleStatus: 'APPLIED', description: 'Safety bonus', quantity: 1, rateMicroCents: 7500n * 1000n,
        amountCents: 7500n, currency: 'USD', periodAnchorAt: s.periodStart + DAY, // in-window
        settlementId: undefined, // NOT attached — the leak
        sourceRef: { kind: 'MANUAL', id: undefined },
        sourceData: { _variant: 'MANUAL_ADJUSTMENT', reason: 'Safety bonus' },
        isLocked: true, isVoided: false, createdAt: Date.now(), updatedAt: Date.now(), createdBy: USER,
      });
    });
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const d = await at.query(api.payEngine.settlementReads.getSettlementDetails, { settlementId });
    expect(d.payables).toHaveLength(2); // the orphan $75 is excluded, not 3
    expect(d.summary.net).toBe(650);    // frozen at the approved total, not 725
  });
});

async function seedCarrier(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const partnershipId = await ctx.db.insert('carrierPartnerships', {
      brokerOrgId: ORG, mcNumber: '654321', carrierName: 'Acme Trucking', status: 'ACTIVE',
      isOwnerOperator: true, createdAt: now, updatedAt: now, createdBy: USER,
    });
    const comp = await ctx.db.insert('chargeComponents', {
      workosOrgId: ORG, code: 'CARRIER_MILES', displayName: 'Loaded Miles', bucket: 'ACCESSORIAL',
      sign: 'CREDIT', taxability: 'NONE', appliesTo: ['PAY'], isActive: true,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    const periodStart = now - 5 * DAY;
    const periodEnd = now - DAY;
    const settlementId = await ctx.db.insert('settlements', {
      workosOrgId: ORG, statementNumber: 'SET-C1', payeeType: 'CARRIER', payeeId: partnershipId,
      periodStart, periodEnd, currency: 'USD', status: 'VERIFIED',
      totals: {
        earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
        taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
        grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
      },
      componentTotals: [], createdAt: now, updatedAt: now, createdBy: USER,
    });
    await ctx.db.insert('payItems', {
      workosOrgId: ORG, payeeType: 'CARRIER', payeeId: partnershipId, kind: 'EARNING', componentId: comp,
      lifecycleStatus: 'APPLIED', description: 'Base Loaded Miles', quantity: 500, rateMicroCents: 550000n,
      amountCents: 275000n, currency: 'USD', periodAnchorAt: periodStart + DAY, // $2,750
      settlementId, // stamped, as the aggregator would on a finalized statement
      sourceRef: { kind: 'RATE_RULE', id: 'r' }, isLocked: false, isVoided: false,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    return { partnershipId, settlementId };
  });
}

describe('settlementReads — carrier', () => {
  it('carrierGetSettlementDetails: partnership + mileage line + net', async () => {
    const t = convexTest(schema);
    const { settlementId } = await seedCarrier(t);
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const d = await at.query(api.payEngine.settlementReads.carrierGetSettlementDetails, { settlementId });
    expect(d.partnership?.name).toBe('Acme Trucking');
    expect(d.partnership?.mcNumber).toBe('654321');
    expect(d.payables).toHaveLength(1);
    expect(d.summary.net).toBe(2750);
    expect(d.summary.earnTotal).toBe(2750);
  });

  it('carrierListSettled: APPROVED row shows carrier name + MC sub + net', async () => {
    const t = convexTest(schema);
    await seedCarrier(t);
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const res = await at.query(api.payEngine.settlementReads.carrierListSettled, {
      workosOrgId: ORG, status: 'APPROVED', paginationOpts: { numItems: 20, cursor: null },
    });
    expect(res.page).toHaveLength(1);
    expect(res.page[0].payeeName).toBe('Acme Trucking');
    expect(res.page[0].payeeSub).toBe('MC-654321 · Owner Op');
    expect(res.page[0].net).toBe(2750);
    expect(res.page[0].status).toBe('APPROVED');
  });
});
