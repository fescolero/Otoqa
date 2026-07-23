// Completed-work gate on calculatePayForLeg.
//
// The recalc cascade prices legs on assignment; before the gate this put
// money on accruing settlements for loads that hadn't run. Contract now:
//   - a leg that isn't COMPLETED carries no live payItems (a gated run
//     voids prior unlocked rows — the rollback/cleanup path);
//   - a DRIVER leg inside a still-open shift (leg.sessionId active) stays
//     empty until the shift ends, so a shift's session layers and load
//     premiums land on the settlement together;
//   - a completed leg with no session (or an ended one) pays immediately.
import { convexTest, type TestConvex } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from '../schema';
import type { Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { microCentsFromDecimalString, rawMicroCents } from '../lib/money';

type T = TestConvex<typeof schema>;
const ORG = 'org_leg_gate';
const USER = 'user_leg_gate';
const mc = (d: string) => rawMicroCents(microCentsFromDecimalString(d, 'USD'));

async function seedWorld(t: T, legStatus: 'PENDING' | 'ACTIVE' | 'COMPLETED' | 'CANCELED') {
  return t.run(async (ctx) => {
    const now = Date.now();
    const customerId = await ctx.db.insert('customers', {
      name: 'C', companyType: 'Shipper', status: 'Active', addressLine1: '1 St',
      city: 'T', state: 'CA', zip: '00000', country: 'USA',
      workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const driverId = await ctx.db.insert('drivers', {
      firstName: 'G', lastName: 'D', email: 'g@x.co', phone: '1',
      licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
      hireDate: '2020-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const truckId = await ctx.db.insert('trucks', {
      unitId: 'T1', vin: 'VIN1', status: 'Active',
      organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const componentId = await ctx.db.insert('chargeComponents', {
      workosOrgId: ORG, code: 'PAY', displayName: 'Pay', bucket: 'ACCESSORIAL',
      sign: 'CREDIT', taxability: 'TAXABLE_WAGE', appliesTo: ['PAY'],
      isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
    });
    const profileId = await ctx.db.insert('payProfiles', {
      workosOrgId: ORG, name: 'P', payeeType: 'DRIVER', payBasis: 'HYBRID',
      currency: 'USD', isDefault: true, isActive: true,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    await ctx.db.insert('payRules', {
      profileId, name: 'per-mile', componentId,
      trigger: { source: 'leg.legLoadedMiles' },
      rateAmountMicroCents: mc('0.60'),
      isActive: true, sortOrder: 0, createdAt: now, updatedAt: now, createdBy: USER,
    });
    await ctx.db.insert('payeeProfileAssignments', {
      workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId, profileId,
      isDefault: true, selectionStrategy: 'ALWAYS_ACTIVE', isActive: true,
      createdAt: now, updatedAt: now, createdBy: USER,
    });
    const loadId = await ctx.db.insert('loadInformation', {
      internalId: 'LD-G1', orderNumber: 'O-G1', status: 'Assigned',
      trackingStatus: 'In Transit', customerId, fleet: 'Default',
      units: 'Pallets', workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
    });
    const stopId = await ctx.db.insert('loadStops', {
      loadId, internalId: 'LD-G1', sequenceNumber: 1, stopType: 'PICKUP',
      loadingType: 'APPT', address: '1 Main', workosOrgId: ORG,
      createdAt: now, updatedAt: now,
    });
    const legId = await ctx.db.insert('dispatchLegs', {
      loadId, driverId, sequence: 1, startStopId: stopId, endStopId: stopId,
      legLoadedMiles: 100, legEmptyMiles: 0,
      status: legStatus, workosOrgId: ORG, createdAt: now, updatedAt: now,
    });
    return { driverId, truckId, loadId, legId };
  });
}

async function liveItems(t: T, loadId: Id<'loadInformation'>, driverId: Id<'drivers'>) {
  const rows = await t.run(async (ctx) =>
    ctx.db
      .query('payItems')
      .withIndex('by_load_payee', (q) =>
        q.eq('sourceRef.loadId', loadId).eq('payeeType', 'DRIVER').eq('payeeId', driverId))
      .collect(),
  );
  return rows.filter((r) => !r.isVoided);
}

const recalc = (t: T, legId: Id<'dispatchLegs'>) =>
  t.mutation(internal.payEngine.calculatePayForLeg.calculatePayForLeg, { legId, userId: USER });

describe('calculatePayForLeg completed-work gate', () => {
  it('writes nothing for a PENDING leg (assignment pricing)', async () => {
    const t = convexTest(schema);
    const w = await seedWorld(t, 'PENDING');
    const result = await recalc(t, w.legId);
    expect(result.emitted).toBe(0);
    expect(result.warnings).toContain('DEFERRED_LEG_NOT_COMPLETED');
    expect(await liveItems(t, w.loadId, w.driverId)).toHaveLength(0);
  });

  it('pays a COMPLETED leg with no session immediately', async () => {
    const t = convexTest(schema);
    const w = await seedWorld(t, 'COMPLETED');
    const result = await recalc(t, w.legId);
    expect(result.emitted).toBe(1);
    const live = await liveItems(t, w.loadId, w.driverId);
    expect(live).toHaveLength(1);
    expect(live[0].amountCents).toBe(6000n); // 100 mi @ $0.60
  });

  it('voids prior items when a leg rolls back out of COMPLETED', async () => {
    const t = convexTest(schema);
    const w = await seedWorld(t, 'COMPLETED');
    await recalc(t, w.legId);
    expect(await liveItems(t, w.loadId, w.driverId)).toHaveLength(1);

    // Rollback (e.g. unassign/reopen): the gated run cleans the ledger.
    await t.run(async (ctx) => ctx.db.patch(w.legId, { status: 'ACTIVE' }));
    const result = await recalc(t, w.legId);
    expect(result.emitted).toBe(0);
    expect(result.voided).toBe(1);
    expect(await liveItems(t, w.loadId, w.driverId)).toHaveLength(0);
  });

  it('handles an orphan leg (parent load deleted) by voiding, not throwing', async () => {
    const t = convexTest(schema);
    const w = await seedWorld(t, 'COMPLETED');
    await recalc(t, w.legId);
    expect(await liveItems(t, w.loadId, w.driverId)).toHaveLength(1);

    // Hard-delete the parent load (pre-cascade orphans look like this).
    await t.run(async (ctx) => ctx.db.delete(w.loadId));

    const result = await recalc(t, w.legId);
    expect(result.warnings).toContain('LOAD_NOT_FOUND');
    expect(result.emitted).toBe(0);
    expect(result.voided).toBe(1);
    expect(await liveItems(t, w.loadId, w.driverId)).toHaveLength(0);
  });

  it('suppresses the fresh spec when a locked reviewer edit survives (no double-pay)', async () => {
    const t = convexTest(schema);
    const w = await seedWorld(t, 'COMPLETED');
    await recalc(t, w.legId);
    const [item] = await liveItems(t, w.loadId, w.driverId);

    // Reviewer locks the line (approval freeze / edit both set isLocked).
    await t.run(async (ctx) => ctx.db.patch(item._id, { isLocked: true }));

    const result = await recalc(t, w.legId);
    expect(result.emitted).toBe(0); // locked survivor wins — no duplicate
    expect(result.voided).toBe(0);
    const live = await liveItems(t, w.loadId, w.driverId);
    expect(live).toHaveLength(1);
    expect(live[0]._id).toBe(item._id);
  });

  it('rolls the anchor onto the next open period when the natural period is finalized', async () => {
    const t = convexTest(schema);
    const w = await seedWorld(t, 'COMPLETED');
    const workAt = await t.run(async (ctx) => (await ctx.db.get(w.legId))!.createdAt);
    const DAY = 86_400_000;
    // Natural period finalized (VERIFIED) + a later open period.
    await t.run(async (ctx) => {
      const base = {
        workosOrgId: ORG, payeeType: 'DRIVER' as const, payeeId: w.driverId as string,
        currency: 'USD' as const,
        totals: {
          earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
          taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
          grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
        },
        componentTotals: [], createdAt: workAt, updatedAt: workAt, createdBy: USER,
      };
      await ctx.db.insert('settlements', {
        ...base, statementNumber: 'SET-1', status: 'VERIFIED',
        periodStart: workAt - DAY, periodEnd: workAt + DAY,
      });
      await ctx.db.insert('settlements', {
        ...base, statementNumber: 'SET-2', status: 'OPEN',
        periodStart: workAt + DAY + 1, periodEnd: workAt + 15 * DAY,
      });
    });

    await recalc(t, w.legId);
    const live = await liveItems(t, w.loadId, w.driverId);
    expect(live).toHaveLength(1);
    // Anchored into the next OPEN period, not the finalized one it would orphan in.
    expect(live[0].periodAnchorAt).toBe(workAt + DAY + 1);
  });

  it('defers a completed leg while its shift is open, pays after it ends', async () => {
    const t = convexTest(schema);
    const w = await seedWorld(t, 'COMPLETED');
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert('driverSessions', {
        driverId: w.driverId, truckId: w.truckId, organizationId: ORG,
        startedAt: Date.now() - 3_600_000, status: 'active',
      }),
    );
    await t.run(async (ctx) => ctx.db.patch(w.legId, { sessionId }));

    // Shift still open → held back so the whole shift lands together.
    const deferred = await recalc(t, w.legId);
    expect(deferred.emitted).toBe(0);
    expect(deferred.warnings).toContain('DEFERRED_SHIFT_OPEN');
    expect(await liveItems(t, w.loadId, w.driverId)).toHaveLength(0);

    // Shift ends (endSessionInternal re-schedules this calc) → pay lands.
    await t.run(async (ctx) =>
      ctx.db.patch(sessionId, { status: 'completed', endedAt: Date.now() }),
    );
    const released = await recalc(t, w.legId);
    expect(released.emitted).toBe(1);
    expect(await liveItems(t, w.loadId, w.driverId)).toHaveLength(1);
  });
});
