// dedupeOverlappingDrafts — period-boundary drift cleanup.
//
// The generation sweep used to dedupe the current period by EXACT
// periodStart/periodEnd equality, so a change in boundary conventions forked
// parallel DRAFT statements for the same pay period. The cleanup clusters a
// driver's DRAFTs by midpoint-overlap, keeps the earliest-created row,
// re-points payables, deletes the duplicates, and removes their mirrored
// new-ledger settlements (unstamping payItems).
import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import { internal } from './_generated/api';

const ORG = 'org_dedupe_test';
const USER = 'user_dedupe_test';
const DAY = 86_400_000;

describe('dedupeOverlappingDrafts', () => {
  it('merges drifted duplicates, keeps the original, cleans the mirror, spares neighbors', async () => {
    const t = convexTest(schema);
    const now = Date.now();

    const w = await t.run(async (ctx) => {
      const driverId = await ctx.db.insert('drivers', {
        firstName: 'J', lastName: 'R', email: 'j@x.co', phone: '1',
        licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
        hireDate: '2020-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
        organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      });

      // The same bi-weekly period under three boundary conventions: the
      // original (UTC-ish), and two drifted rows a few hours off either edge.
      const base = now - 7 * DAY;
      const mkLegacy = (periodStart: number, periodEnd: number, statementNumber: string, createdAt: number) =>
        ctx.db.insert('driverSettlements', {
          driverId, workosOrgId: ORG, periodStart, periodEnd,
          status: 'DRAFT', statementNumber, createdAt, createdBy: USER, updatedAt: createdAt,
        });
      const keeperId = await mkLegacy(base, base + 14 * DAY, 'SET-040', now - 5 * DAY);
      const dupeAId = await mkLegacy(base + 7 * 3_600_000, base + 14 * DAY - 3_600_000, 'SET-045', now - DAY);
      const dupeBId = await mkLegacy(base - 7 * 3_600_000, base + 14 * DAY - 7 * 3_600_000, 'SET-046', now);
      // A genuinely different (next) period — must survive untouched.
      const nextId = await mkLegacy(base + 14 * DAY + 1, base + 28 * DAY, 'SET-050', now);

      // A payable stranded on a duplicate.
      const payableId = await ctx.db.insert('loadPayables', {
        driverId, description: 'Shift', quantity: 0.2, rate: 30, totalAmount: 6,
        sourceType: 'SYSTEM', isLocked: false, settlementId: dupeAId,
        workosOrgId: ORG, createdAt: now, createdBy: USER,
      });

      // Mirrored new-ledger row for dupe A, with a stamped payItem.
      const comp = await ctx.db.insert('chargeComponents', {
        workosOrgId: ORG, code: 'WAGE', displayName: 'Wage', bucket: 'BASE_WAGE',
        sign: 'CREDIT', taxability: 'NONE', appliesTo: ['PAY'],
        isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
      });
      const totals = {
        earningsCents: 0n, bonusesCents: 0n, creditsCents: 0n, deductionsCents: 0n,
        taxWithholdingCents: 0n, garnishmentsCents: 0n, adjustmentsCents: 0n,
        grossCents: 0n, netCents: 0n, holdbackTotalCents: 0n, itemCount: 0,
      };
      const mirrorAId = await ctx.db.insert('settlements', {
        workosOrgId: ORG, statementNumber: 'SET-045', payeeType: 'DRIVER', payeeId: driverId,
        periodStart: base + 7 * 3_600_000, periodEnd: base + 14 * DAY - 3_600_000,
        currency: 'USD', status: 'OPEN', totals, componentTotals: [],
        createdAt: now, updatedAt: now, createdBy: USER,
      });
      const itemId = await ctx.db.insert('payItems', {
        workosOrgId: ORG, payeeType: 'DRIVER', payeeId: driverId, kind: 'EARNING',
        componentId: comp, lifecycleStatus: 'APPLIED', description: 'Shift', quantity: 0.2,
        rateMicroCents: 3_000_000n, amountCents: 600n, currency: 'USD',
        periodAnchorAt: base + DAY, settlementId: mirrorAId,
        sourceRef: { kind: 'RATE_RULE', id: 'r' },
        isLocked: false, isVoided: false, createdAt: now, updatedAt: now, createdBy: USER,
      });

      return { driverId, keeperId, dupeAId, dupeBId, nextId, payableId, mirrorAId, itemId };
    });

    const result = await t.mutation(internal.driverSettlements.dedupeOverlappingDrafts, {
      workosOrgId: ORG,
    });
    expect(result.duplicatesRemoved).toBe(2);
    expect(result.payablesRepointed).toBe(1);
    expect(result.mirrorsRemoved).toBe(1);

    await t.run(async (ctx) => {
      // Keeper and the genuinely-different next period survive; dupes gone.
      expect(await ctx.db.get(w.keeperId)).not.toBeNull();
      expect(await ctx.db.get(w.nextId)).not.toBeNull();
      expect(await ctx.db.get(w.dupeAId)).toBeNull();
      expect(await ctx.db.get(w.dupeBId)).toBeNull();
      // Payable moved to the keeper.
      expect((await ctx.db.get(w.payableId))!.settlementId).toBe(w.keeperId);
      // Mirror deleted, its payItem unstamped (free for re-aggregation).
      expect(await ctx.db.get(w.mirrorAId)).toBeNull();
      expect((await ctx.db.get(w.itemId))!.settlementId).toBeUndefined();
    });

    // Idempotent — a second run finds nothing.
    const again = await t.mutation(internal.driverSettlements.dedupeOverlappingDrafts, {
      workosOrgId: ORG,
    });
    expect(again.duplicatesRemoved).toBe(0);
    expect(again.payablesRepointed).toBe(0);
    expect(again.mirrorsRemoved).toBe(0);
  });
});
