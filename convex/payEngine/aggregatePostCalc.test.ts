// Aggregator ↔ post-calc integration — the weekly H&W hour cap end to end:
// runAggregation resolves the payee's default profile, recomputes the cap
// offsets from the period's basis items, and reconciles them into payItems
// idempotently (insert / patch-in-place / void-stale / reviewer-lock wins).
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';

type T = TestConvex<typeof schema>;
const ORG = 'org_postcalc';
const USER = 'user_postcalc';
const DAY = 86_400_000;
const HW_RATE_MICRO = 555_000n; // $5.55/hr

// Fixed 14-day period — cap weeks are [start, start+7d) and [start+7d, end].
const PERIOD_START = 1_700_000_000_000;
const PERIOD_END = PERIOD_START + 14 * DAY;

async function seed(t: T, opts: { capHours?: number } = {}) {
  return t.run(async (ctx) => {
    const now = PERIOD_START;
    const driverId = await ctx.db.insert('drivers', {
      firstName: 'Manny', lastName: 'Paredes', email: 'm@p.co', phone: '1', licenseState: 'CA',
      licenseExpiration: '2030-01-01', licenseClass: 'A', hireDate: '2020-01-01',
      employmentStatus: 'Active', employmentType: 'Full-time', organizationId: ORG,
      createdBy: USER, createdAt: now, updatedAt: now,
    });
    const hwComp = await ctx.db.insert('chargeComponents', {
      workosOrgId: ORG, code: 'HEALTH_WELFARE', displayName: 'Health & Welfare',
      bucket: 'BASE_FRINGE', sign: 'CREDIT', taxability: 'FRINGE_NON_TAXABLE',
      appliesTo: ['PAY'], isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
    });
    // NOTE: PAY_CAP_OFFSET is deliberately NOT seeded — the aggregator must
    // lazily create it from the catalog template for pre-existing orgs.
    const profileId = await ctx.db.insert('payProfiles', {
      workosOrgId: ORG, name: 'Hourly + H&W', payeeType: 'DRIVER', payBasis: 'HOURLY',
      currency: 'USD', isDefault: true, isActive: true,
      postCalcRules: [{
        name: 'H&W weekly cap', kind: 'MAXIMUM_CAP_WEEKLY', componentId: hwComp,
        thresholdQty: opts.capHours ?? 40, sortOrder: 1,
      }],
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    await ctx.db.insert('payeeProfileAssignments', {
      workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId as string, profileId,
      isDefault: true, selectionStrategy: 'ALWAYS_ACTIVE', isActive: true,
      createdAt: now, updatedAt: now, createdBy: USER,
    });

    const mkHours = (hours: number, day: number) =>
      ctx.db.insert('payItems', {
        workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId as string, kind: 'EARNING',
        componentId: hwComp, lifecycleStatus: 'APPLIED', description: 'H&W',
        quantity: hours, rateMicroCents: HW_RATE_MICRO,
        amountCents: BigInt(Math.round(hours * 555)), currency: 'USD',
        periodAnchorAt: PERIOD_START + day * DAY,
        sourceRef: { kind: 'RATE_RULE', id: `rule-hw-${day}` },
        isLocked: false, isVoided: false, createdAt: now, updatedAt: now, createdBy: USER,
      });
    // Week 1: 30 + 20 = 50 h → 10 h over. Week 2: 38 h → clean.
    const itemW1a = await mkHours(30, 1);
    const itemW1b = await mkHours(20, 4);
    await mkHours(38, 9);
    return { driverId, hwComp, profileId, itemW1a, itemW1b };
  });
}

function aggregate(t: T, driverId: Id<'drivers'>) {
  return t.mutation(internal.payEngine.aggregateSettlement.aggregateDriverSettlement, {
    workosOrgId: ORG, payeeId: driverId as string,
    periodStart: PERIOD_START, periodEnd: PERIOD_END, userId: USER,
  });
}

async function capOffsets(t: T, driverId: Id<'drivers'>): Promise<Array<Doc<'payItems'>>> {
  return t.run(async (ctx) => {
    const items = await ctx.db
      .query('payItems')
      .withIndex('by_payee_period', (q) =>
        q.eq('payeeType', 'DRIVER').eq('payeeId', driverId as string)
          .gte('periodAnchorAt', PERIOD_START).lte('periodAnchorAt', PERIOD_END))
      .collect();
    return items.filter((it) => it.kind === 'POST_CALC_ADJUSTMENT');
  });
}

describe('aggregateSettlement — MAXIMUM_CAP_WEEKLY offsets', () => {
  it('emits one visible offset for the over-cap week and folds it into totals', async () => {
    const t = convexTest(schema);
    const { driverId, hwComp } = await seed(t);
    const result = await aggregate(t, driverId);
    expect(result.action).toBe('created');

    const offsets = (await capOffsets(t, driverId)).filter((o) => !o.isVoided);
    expect(offsets).toHaveLength(1);
    const offset = offsets[0];
    expect(offset.amountCents).toBe(5550n); // 10 h × $5.55
    expect(offset.quantity).toBe(10);
    expect(offset.description).toContain('40 h/week max reached');
    expect(offset.description).toContain('10.00 h at max');
    expect(offset.settlementId).toBe(result.settlementId);
    expect(offset.isLocked).toBe(false);
    // Cap fold metadata for the "maxed out" display treatment.
    expect(offset.sourceData?._variant).toBe('POST_CALC_ADJUSTMENT');
    if (offset.sourceData?._variant === 'POST_CALC_ADJUSTMENT') {
      expect(offset.sourceData.capComponentId).toBe(hwComp);
      expect(offset.sourceData.capThresholdQty).toBe(40);
    }

    // The offset component was lazily seeded from the catalog template.
    const comp = await t.run(async (ctx) => ctx.db.get(offset.componentId));
    expect(comp?.code).toBe('PAY_CAP_OFFSET');
    expect(comp?.bucket).toBe('DEDUCTION');
    expect(comp?.sign).toBe('DEBIT');
    expect(comp?.workosOrgId).toBe(ORG);

    // Totals: earnings 88 h × $5.55 = $488.40; adjustment −$55.50 → net $432.90.
    const s = await t.run(async (ctx) => ctx.db.get(result.settlementId!));
    expect(s?.totals.earningsCents).toBe(48840n);
    expect(s?.totals.adjustmentsCents).toBe(-5550n);
    expect(s?.totals.netCents).toBe(43290n);
  });

  it('re-running is idempotent — same row, no duplicates, no churn', async () => {
    const t = convexTest(schema);
    const { driverId } = await seed(t);
    await aggregate(t, driverId);
    const first = (await capOffsets(t, driverId)).filter((o) => !o.isVoided);
    await aggregate(t, driverId);
    const second = (await capOffsets(t, driverId)).filter((o) => !o.isVoided);
    expect(second).toHaveLength(1);
    expect(second[0]._id).toBe(first[0]._id);
    expect(second[0].updatedAt).toBe(first[0].updatedAt); // untouched, not re-patched
  });

  it('patches the offset in place when the basis hours change', async () => {
    const t = convexTest(schema);
    const { driverId, itemW1a } = await seed(t);
    await aggregate(t, driverId);
    const before = (await capOffsets(t, driverId)).filter((o) => !o.isVoided)[0];

    // Week 1 grows 30 → 35 h (55 h total → 15 h over).
    await t.run(async (ctx) => {
      await ctx.db.patch(itemW1a, { quantity: 35, amountCents: BigInt(35 * 555) });
    });
    await aggregate(t, driverId);
    const after = (await capOffsets(t, driverId)).filter((o) => !o.isVoided);
    expect(after).toHaveLength(1);
    expect(after[0]._id).toBe(before._id);
    expect(after[0].amountCents).toBe(8325n); // 15 h × $5.55
    expect(after[0].quantity).toBe(15);
  });

  it('voids the offset when hours drop back under the cap', async () => {
    const t = convexTest(schema);
    const { driverId, itemW1b } = await seed(t);
    await aggregate(t, driverId);

    await t.run(async (ctx) => {
      await ctx.db.patch(itemW1b, { quantity: 5, amountCents: BigInt(5 * 555) });
    });
    const result = await aggregate(t, driverId);
    const offsets = await capOffsets(t, driverId);
    expect(offsets).toHaveLength(1);
    expect(offsets[0].isVoided).toBe(true);
    expect(offsets[0].settlementId).toBeUndefined(); // detached from the statement

    const s = await t.run(async (ctx) => ctx.db.get(result.settlementId!));
    expect(s?.totals.adjustmentsCents).toBe(0n);
  });

  it('a reviewer-locked offset survives recompute untouched', async () => {
    const t = convexTest(schema);
    const { driverId, itemW1b } = await seed(t);
    await aggregate(t, driverId);
    const offset = (await capOffsets(t, driverId)).filter((o) => !o.isVoided)[0];

    // Reviewer locks the adjustment, then the basis changes under it.
    await t.run(async (ctx) => { await ctx.db.patch(offset._id, { isLocked: true }); });
    await t.run(async (ctx) => {
      await ctx.db.patch(itemW1b, { quantity: 5, amountCents: BigInt(5 * 555) });
    });
    await aggregate(t, driverId);
    const after = await capOffsets(t, driverId);
    expect(after).toHaveLength(1);
    expect(after[0].isVoided).toBe(false);
    expect(after[0].amountCents).toBe(5550n); // reviewer's number, not the recompute
  });

  it('converges sourceData on rows written before the cap-fold metadata existed', async () => {
    const t = convexTest(schema);
    const { driverId, hwComp, profileId } = await seed(t);
    await aggregate(t, driverId);
    const offset = (await capOffsets(t, driverId)).filter((o) => !o.isVoided)[0];

    // Simulate a row from the earlier engine version: no cap metadata.
    await t.run(async (ctx) => {
      await ctx.db.patch(offset._id, {
        sourceData: {
          _variant: 'POST_CALC_ADJUSTMENT' as const,
          postCalcRuleName: 'H&W weekly cap',
          profileIdSnapshot: profileId,
        },
      });
    });
    await aggregate(t, driverId);
    const after = (await capOffsets(t, driverId)).filter((o) => !o.isVoided)[0];
    expect(after._id).toBe(offset._id);
    expect(after.sourceData?._variant).toBe('POST_CALC_ADJUSTMENT');
    if (after.sourceData?._variant === 'POST_CALC_ADJUSTMENT') {
      expect(after.sourceData.capComponentId).toBe(hwComp);
      expect(after.sourceData.capThresholdQty).toBe(40);
    }
  });

  it('emits nothing (and stays clean) for a payee with no post-calc rules', async () => {
    const t = convexTest(schema);
    const { driverId, profileId } = await seed(t);
    await t.run(async (ctx) => { await ctx.db.patch(profileId, { postCalcRules: undefined }); });
    const result = await aggregate(t, driverId);
    expect(result.action).toBe('created');
    expect(await capOffsets(t, driverId)).toHaveLength(0);
    const s = await t.run(async (ctx) => ctx.db.get(result.settlementId!));
    expect(s?.totals.adjustmentsCents).toBe(0n);
    expect(s?.totals.netCents).toBe(48840n);
  });
});
