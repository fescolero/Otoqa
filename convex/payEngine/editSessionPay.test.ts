// Tests for the review/edit layer on the new ledger (M5.2).
//
// Tier 1 — pure `correctedShiftHours` (the shift-hours math).
// Tier 2 — edit / re-edit / revert / finalized-guard against a real payItem,
//          proving the append-only contract (void + supersede, never mutate).
// Tier 3 — the EDIT-AWARE session recalc: a locked reviewer edit survives a
//          recalc, is never duplicated (no double-pay), and drift is
//          flagged/cleared as the engine diverges/converges.
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { api, internal } from '../_generated/api';
import { correctedShiftHours } from './editSessionPay';

type T = TestConvex<typeof schema>;

const ORG = 'org_edit_test';
const USER = 'user_edit_test';
const HOUR = 3_600_000;

// ── Tier 1: pure hours math ──────────────────────────────────────────────────
describe('correctedShiftHours', () => {
  it('full span, no break → whole hours', () => {
    expect(correctedShiftHours(0, 8 * HOUR, 0)).toBe(8);
  });
  it('deducts the break', () => {
    expect(correctedShiftHours(0, 8 * HOUR, 60)).toBe(7); // 8h − 1h
  });
  it('rounds to 0.01h (100 min → 1.67h)', () => {
    expect(correctedShiftHours(0, 100 * 60_000, 0)).toBe(1.67);
  });
  it('floors at 0 when break exceeds span', () => {
    expect(correctedShiftHours(0, 30 * 60_000, 60)).toBe(0);
  });
  it('auto-timeout correction (reviewer sets real 7.97h span)', () => {
    expect(correctedShiftHours(0, Math.round(7.97 * HOUR), 0)).toBe(7.97);
  });
});

// ── seeding: full pay config + completed session + one Base Wage payItem ──────
// $20/h × 8h shift → $160.00 = 16000 cents.
const RATE_MICRO_CENTS = 2_000_000n; // $20.00/h in micro-cents
const START_AT = 1_700_000_000_000;

async function setup(t: T) {
  return t.run(async (ctx) => {
    const now = Date.now();
    const driverId = await ctx.db.insert('drivers', {
      firstName: 'A', lastName: 'B', email: 'a@b.c', phone: '1',
      licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
      hireDate: '2020-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const truckId = await ctx.db.insert('trucks', {
      unitId: 'T1', vin: 'VIN1', status: 'Active',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const componentId = await ctx.db.insert('chargeComponents', {
      workosOrgId: ORG, code: 'BASE_WAGE', displayName: 'Base Wage',
      bucket: 'BASE_WAGE', sign: 'CREDIT', taxability: 'TAXABLE_WAGE',
      appliesTo: ['PAY'], isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
    });
    const profileId = await ctx.db.insert('payProfiles', {
      workosOrgId: ORG, name: 'Hourly', payeeType: 'DRIVER', payBasis: 'HOURLY',
      currency: 'USD', isDefault: true, isActive: true,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    await ctx.db.insert('payRules', {
      profileId, name: 'Shift wage', componentId,
      trigger: { source: 'session.activeMinutes', transform: 'HOURS_FROM_MINUTES' },
      rateAmountMicroCents: RATE_MICRO_CENTS,
      isActive: true, sortOrder: 1, createdAt: now, updatedAt: now, createdBy: USER,
    });
    await ctx.db.insert('payeeProfileAssignments', {
      workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId, profileId,
      isDefault: true, selectionStrategy: 'ALWAYS_ACTIVE', isActive: true,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    const sessionId = await ctx.db.insert('driverSessions', {
      driverId, truckId, organizationId: ORG,
      startedAt: START_AT, endedAt: START_AT + 8 * HOUR,
      status: 'completed', totalActiveMinutes: 480, endReason: 'driver_manual',
    });
    return { driverId, sessionId, componentId };
  });
}

/** Non-voided payItems for a session. */
async function liveItems(t: T, sessionId: Id<'driverSessions'>) {
  return t.run(async (ctx) =>
    ctx.db
      .query('payItems')
      .withIndex('by_session', (q) => q.eq('sourceRef.sessionId', sessionId).eq('isVoided', false))
      .collect(),
  );
}

async function calcSession(t: T, sessionId: Id<'driverSessions'>) {
  return t.mutation(internal.payEngine.calculatePayForSession.calculatePayForSession, {
    sessionId, userId: USER,
  });
}

describe('editPayItem (append-only edit)', () => {
  it('generates one $160 Base Wage line, then edits it down with a break', async () => {
    const t = convexTest(schema);
    const { sessionId } = await setup(t);
    await calcSession(t, sessionId);

    let items = await liveItems(t, sessionId);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(8);
    expect(items[0].amountCents).toBe(16000n);
    const originalId = items[0]._id;

    // Reviewer deducts a 60-min break → 7h → $140.
    const at = t.withIdentity({ subject: USER, org_id: ORG });
    const res = await at.mutation(api.payEngine.editSessionPay.editPayItem, {
      payItemId: originalId, breakMinutes: 60, reason: 'lunch break',
    });
    expect(res.quantity).toBe(7);
    expect(res.amountCents).toBe(14000n);

    // Append-only: the original is voided + superseded; the head is a locked edit.
    items = await liveItems(t, sessionId);
    expect(items).toHaveLength(1);
    const edit = items[0];
    expect(edit._id).not.toBe(originalId);
    expect(edit.isLocked).toBe(true);
    expect(edit.quantity).toBe(7);
    expect(edit.amountCents).toBe(14000n);
    expect(edit.reviewerEdit?.originalQuantity).toBe(8);
    expect(edit.reviewerEdit?.originalAmountCents).toBe(16000n);
    expect(edit.reviewerEdit?.breakMinutes).toBe(60);
    expect(edit.reviewerEdit?.editedBy).toBe(USER);
    expect(edit.reviewerEdit?.supersedesPayItemId).toBe(originalId);
    expect(edit.sourceData?._variant).toBe('EARNING'); // traceability preserved

    const voided = await t.run(async (ctx) => ctx.db.get(originalId));
    expect(voided?.isVoided).toBe(true);
    expect(voided?.supersededByPayItemId).toBe(edit._id);
  });

  it('re-edit preserves the first-edit original snapshot', async () => {
    const t = convexTest(schema);
    const { sessionId } = await setup(t);
    await calcSession(t, sessionId);
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const id1 = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: id1, breakMinutes: 60 });
    const id2 = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: id2, breakMinutes: 120 });

    const edit = (await liveItems(t, sessionId))[0];
    expect(edit.quantity).toBe(6); // 8h − 2h
    expect(edit.amountCents).toBe(12000n); // $120
    expect(edit.reviewerEdit?.originalQuantity).toBe(8); // still the ORIGINAL, not 7
    expect(edit.reviewerEdit?.originalAmountCents).toBe(16000n);
  });

  it('revert restores the original as a fresh UNLOCKED line', async () => {
    const t = convexTest(schema);
    const { sessionId } = await setup(t);
    await calcSession(t, sessionId);
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const id1 = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: id1, breakMinutes: 60 });
    const editId = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.revertPayItemEdit, { payItemId: editId });

    const items = await liveItems(t, sessionId);
    expect(items).toHaveLength(1);
    expect(items[0].quantity).toBe(8);
    expect(items[0].amountCents).toBe(16000n);
    expect(items[0].isLocked).toBe(false);
    expect(items[0].reviewerEdit).toBeUndefined();
  });

  it('rejects edits on a finalized (VERIFIED) settlement', async () => {
    const t = convexTest(schema);
    const { sessionId } = await setup(t);
    await calcSession(t, sessionId);
    const itemId = (await liveItems(t, sessionId))[0]._id;

    // Attach the item to a VERIFIED settlement.
    await t.run(async (ctx) => {
      const settlementId = await ctx.db.insert('settlements', {
        workosOrgId: ORG, statementNumber: 'SET-1', payeeType: 'DRIVER', payeeId: 'd',
        periodStart: START_AT, periodEnd: START_AT + 14 * 24 * HOUR, currency: 'USD',
        status: 'VERIFIED',
        totals: {
          earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
          taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
          grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
        },
        componentTotals: [], createdAt: Date.now(), updatedAt: Date.now(), createdBy: USER,
      });
      await ctx.db.patch(itemId, { settlementId });
    });

    const at = t.withIdentity({ subject: USER, org_id: ORG });
    await expect(
      at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: itemId, breakMinutes: 30 }),
    ).rejects.toThrow(/finalized/i);
  });
});

describe('edit-aware session recalc (no double-pay + drift flag)', () => {
  it('a locked edit survives recalc without a duplicate, and drift is flagged', async () => {
    const t = convexTest(schema);
    const { sessionId } = await setup(t);
    await calcSession(t, sessionId);
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    // Reviewer corrects to 7h / $140.
    const id1 = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: id1, breakMinutes: 60 });

    // Recalc runs again (e.g. session re-ended / backfill). Engine still says
    // $160/8h — but the edit must WIN: exactly ONE live line, and it's the edit.
    const recalc = await calcSession(t, sessionId);
    expect(recalc.inserted).toBe(0); // no duplicate inserted
    expect(recalc.driftFlagged).toBe(1);

    const items = await liveItems(t, sessionId);
    expect(items).toHaveLength(1);
    expect(items[0].amountCents).toBe(14000n); // still the reviewer's $140
    expect(items[0].isLocked).toBe(true);
    // Drift flag: engine would pay $160.
    expect(items[0].reviewerEdit?.engineAmountCents).toBe(16000n);
    expect(items[0].reviewerEdit?.engineDivergedAt).toBeDefined();
  });

  it('drift clears when the edit converges back to the engine amount', async () => {
    const t = convexTest(schema);
    const { sessionId } = await setup(t);
    await calcSession(t, sessionId);
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    // Edit away, recalc (drift set), then edit back to exactly $160/8h.
    const id1 = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: id1, breakMinutes: 60 });
    await calcSession(t, sessionId);
    const id2 = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: id2, breakMinutes: 0 });

    const recalc = await calcSession(t, sessionId);
    expect(recalc.driftFlagged).toBe(0);

    const item = (await liveItems(t, sessionId))[0];
    expect(item.amountCents).toBe(16000n);
    expect(item.reviewerEdit?.engineAmountCents).toBeUndefined(); // drift cleared
    expect(item.reviewerEdit?.engineDivergedAt).toBeUndefined();
  });

  it('adoptEnginePayItem replaces the edit with the fresh engine line', async () => {
    const t = convexTest(schema);
    const { sessionId } = await setup(t);
    await calcSession(t, sessionId);
    const at = t.withIdentity({ subject: USER, org_id: ORG });

    const id1 = (await liveItems(t, sessionId))[0]._id;
    await at.mutation(api.payEngine.editSessionPay.editPayItem, { payItemId: id1, breakMinutes: 60 });
    await calcSession(t, sessionId); // flags drift
    const editId = (await liveItems(t, sessionId))[0]._id;

    await at.mutation(api.payEngine.editSessionPay.adoptEnginePayItem, { payItemId: editId });

    const items = await liveItems(t, sessionId);
    expect(items).toHaveLength(1);
    expect(items[0].amountCents).toBe(16000n); // engine value adopted
    expect(items[0].isLocked).toBe(false); // rules own it again
    expect(items[0].reviewerEdit).toBeUndefined();
  });
});
