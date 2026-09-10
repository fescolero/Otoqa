import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { api } from './_generated/api';

/**
 * fuelReports.entryPriceCheck — the price check behind one entry's detail
 * page. It must use the same benchmark the reports use, hand back the
 * fills behind it, and name the entry error that would explain an
 * outlier.
 */

const ORG = 'org_pc_test';
const USER = 'user_pc_test';
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

async function seedVendor(ctx: MutationCtx, name: string): Promise<Id<'fuelVendors'>> {
  const now = Date.now();
  return await ctx.db.insert('fuelVendors', {
    organizationId: ORG, name, isActive: true, createdAt: now, updatedAt: now, createdBy: USER,
  });
}

async function insertFuel(
  ctx: MutationCtx,
  opts: { vendorId: Id<'fuelVendors'>; entryDate: number; gallons: number; ppg: number; state?: string; city?: string },
): Promise<Id<'fuelEntries'>> {
  const now = Date.now();
  return await ctx.db.insert('fuelEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    vendorId: opts.vendorId,
    gallons: opts.gallons,
    pricePerGallon: opts.ppg,
    totalCost: opts.gallons * opts.ppg,
    location: opts.state ? { city: opts.city ?? 'Redding', state: opts.state } : undefined,
    createdAt: now, updatedAt: now, createdBy: USER,
  });
}

async function insertDef(
  ctx: MutationCtx,
  opts: { vendorId: Id<'fuelVendors'>; entryDate: number; gallons: number; ppg: number; state?: string },
): Promise<Id<'defEntries'>> {
  const now = Date.now();
  return await ctx.db.insert('defEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    vendorId: opts.vendorId,
    gallons: opts.gallons,
    pricePerGallon: opts.ppg,
    totalCost: opts.gallons * opts.ppg,
    location: opts.state ? { city: 'Redding', state: opts.state } : undefined,
    createdAt: now, updatedAt: now, createdBy: USER,
  });
}

describe('entryPriceCheck', () => {
  it('benchmarks against same-state fills within the window and lists them nearest first', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const { me, ids } = await t.run(async (ctx) => {
      const pilot = await seedVendor(ctx, 'Pilot');
      const loves = await seedVendor(ctx, "Love's");
      const me = await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 5 * DAY, gallons: 32, ppg: 7.69, state: 'CA' });
      const ids = {
        a: await insertFuel(ctx, { vendorId: loves, entryDate: T0 + 4 * DAY, gallons: 100, ppg: 4.1, state: 'CA', city: 'Sacramento' }),
        b: await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 7 * DAY, gallons: 100, ppg: 4.3, state: 'CA' }),
        c: await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 5.5 * DAY, gallons: 100, ppg: 4.2, state: 'CA' }),
      };
      // Other state and outside the window: not peers for a state-tier fill.
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 5 * DAY, gallons: 100, ppg: 3.9, state: 'TX' });
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 20 * DAY, gallons: 100, ppg: 4.0, state: 'CA' });
      return { me, ids };
    });

    const res = await t.query(api.fuelReports.entryPriceCheck, { type: 'fuel', entryId: me });
    expect(res).not.toBeNull();
    expect(res!.product).toBe('DIESEL');
    expect(res!.assessment.tier).toBe('state');
    expect(res!.assessment.peers).toBe(3);
    expect(res!.assessment.benchmark).toBeCloseTo(4.2);
    expect(res!.assessment.flagged).toBe(true);
    expect(res!.impact).toBeCloseTo((7.69 - 4.2) * 32);
    expect(res!.peers.map((p) => p.id)).toEqual([ids.c, ids.a, ids.b]);
    expect(res!.peers[1].vendorName).toBe("Love's");
    expect(res!.peers[1].city).toBe('Sacramento');
    expect(res!.peerRange).toEqual({ min: 4.1, max: 4.3 });
    expect(res!.peersCapped).toBe(false);
    // $7.69 is simply high: no entry error explains it.
    expect(res!.causes).toEqual(['none']);
    expect(res!.review).toBeNull();
  });

  it('names a DEF fill logged as diesel, using the other product as the second benchmark', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const me = await t.run(async (ctx) => {
      const v = await seedVendor(ctx, 'Pilot');
      for (const d of [1, 2, 3]) {
        await insertFuel(ctx, { vendorId: v, entryDate: T0 + d * DAY, gallons: 100, ppg: 4.2, state: 'CA' });
        await insertDef(ctx, { vendorId: v, entryDate: T0 + d * DAY, gallons: 10, ppg: 2.9, state: 'CA' });
      }
      // A DEF entry at diesel money: far above the DEF fills, right on
      // the diesel ones — the pump was diesel, the product was mislogged.
      return await insertDef(ctx, { vendorId: v, entryDate: T0 + 2 * DAY, gallons: 10, ppg: 4.19, state: 'CA' });
    });

    const res = await t.query(api.fuelReports.entryPriceCheck, { type: 'def', entryId: me });
    expect(res!.product).toBe('DEF');
    expect(res!.otherProduct).toBe('DIESEL');
    expect(res!.assessment.flagged).toBe(true);
    expect(res!.otherBenchmark).toBeCloseTo(4.2);
    expect(res!.causes).toEqual(['product']);
  });

  it('reports nothing to compare against when the fill is alone', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const me = await t.run(async (ctx) => {
      const v = await seedVendor(ctx, 'Pilot');
      return await insertFuel(ctx, { vendorId: v, entryDate: T0, gallons: 100, ppg: 4.2 });
    });
    const res = await t.query(api.fuelReports.entryPriceCheck, { type: 'fuel', entryId: me });
    expect(res!.assessment.tier).toBe('none');
    expect(res!.assessment.benchmark).toBeNull();
    expect(res!.peers).toEqual([]);
    expect(res!.causes).toEqual([]);
  });

  it('agrees with the reports in a window busier than the reports\' side-window cap', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const me = await t.run(async (ctx) => {
      const v = await seedVendor(ctx, 'Pilot');
      const me = await insertFuel(ctx, { vendorId: v, entryDate: T0, gallons: 100, ppg: 4.6 });
      // 260 fills at $4 the next day and 260 at $9 two days on — more on
      // one side than SIDE_WINDOW_ROWS. The reports see all 520 (they are
      // in range) and land on a $6.50 median: not flagged. A detail read
      // capped at 250 would keep only the $4 fills and flag it.
      for (let i = 0; i < 260; i++) {
        await insertFuel(ctx, { vendorId: v, entryDate: T0 + DAY + 60_000 * (i + 1), gallons: 100, ppg: 4 });
        await insertFuel(ctx, { vendorId: v, entryDate: T0 + 2 * DAY + 60_000 * (i + 1), gallons: 100, ppg: 9 });
      }
      return me;
    });

    const report = await t.query(api.fuelReports.reportEntries, {
      organizationId: ORG, dateRangeStart: T0, dateRangeEnd: T0 + 3 * DAY,
    });
    const mine = report.rows.find((r) => r._id === me)!;
    const detail = await t.query(api.fuelReports.entryPriceCheck, { type: 'fuel', entryId: me });
    expect(mine.priceBenchmark).toBeCloseTo(6.5);
    expect(mine.exceptions).not.toContain('price');
    expect(detail!.assessment.benchmark).toBeCloseTo(mine.priceBenchmark!);
    expect(detail!.assessment.peers).toBe(mine.pricePeers);
    expect(detail!.assessment.flagged).toBe(false);
    expect(detail!.peersCapped).toBe(false);
  });

  it('hides entries of other organizations and unknown ids', async () => {
    const t = convexTest(schema);
    const other = await t.run(async (ctx) => {
      const now = Date.now();
      const v = await ctx.db.insert('fuelVendors', {
        organizationId: 'org_other', name: 'X', isActive: true, createdAt: now, updatedAt: now, createdBy: 'u',
      });
      return await ctx.db.insert('fuelEntries', {
        organizationId: 'org_other', entryDate: T0, vendorId: v, gallons: 1, pricePerGallon: 4, totalCost: 4,
        createdAt: now, updatedAt: now, createdBy: 'u',
      });
    });
    const asUser = t.withIdentity({ subject: USER, org_id: ORG });
    expect(await asUser.query(api.fuelReports.entryPriceCheck, { type: 'fuel', entryId: other })).toBeNull();
    expect(await asUser.query(api.fuelReports.entryPriceCheck, { type: 'fuel', entryId: 'nope' })).toBeNull();
  });
});
