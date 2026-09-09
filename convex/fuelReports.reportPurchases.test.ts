import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api } from './_generated/api';

/**
 * Tests for fuelReports.reportPurchases — the paginated, server-sorted
 * feed behind the Fuel purchases table — and for the filter args on
 * reportEntries, its CSV export counterpart.
 */

const ORG = 'org_rp_test';
const USER = 'user_rp_test';
const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedVendor(ctx: any, name: string): Promise<Id<'fuelVendors'>> {
  const now = Date.now();
  return await ctx.db.insert('fuelVendors', {
    organizationId: ORG, name, isActive: true,
    createdAt: now, updatedAt: now, createdBy: USER,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedDriver(ctx: any, first: string): Promise<Id<'drivers'>> {
  const now = Date.now();
  return await ctx.db.insert('drivers', {
    firstName: first, lastName: 'Driver', email: `${first}@t.co`, phone: '+15550000004',
    licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
    hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
    organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
}

async function insertFuel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  opts: { vendorId: Id<'fuelVendors'>; entryDate: number; gallons: number; ppg?: number; driverId?: Id<'drivers'> },
): Promise<void> {
  const now = Date.now();
  const ppg = opts.ppg ?? 4;
  await ctx.db.insert('fuelEntries', {
    organizationId: ORG, entryDate: opts.entryDate, vendorId: opts.vendorId,
    driverId: opts.driverId, gallons: opts.gallons, pricePerGallon: ppg,
    totalCost: opts.gallons * ppg, createdAt: now, updatedAt: now, createdBy: USER,
  });
}

async function insertDef(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  opts: { vendorId: Id<'fuelVendors'>; entryDate: number; gallons: number },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('defEntries', {
    organizationId: ORG, entryDate: opts.entryDate, vendorId: opts.vendorId,
    gallons: opts.gallons, pricePerGallon: 3, totalCost: opts.gallons * 3,
    createdAt: now, updatedAt: now, createdBy: USER,
  });
}

const RANGE = { organizationId: ORG, dateRangeStart: T0, dateRangeEnd: T0 + 30 * DAY };

describe('reportPurchases', () => {
  it('pages through the sorted pool with an offset cursor', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx, 'Pilot'));
    await t.run(async (ctx) => {
      for (let i = 0; i < 7; i++) {
        await insertFuel(ctx, { vendorId, entryDate: T0 + i * DAY, gallons: 10 + i });
      }
    });

    const first = await t.query(api.fuelReports.reportPurchases, {
      ...RANGE, sortKey: 'date', sortDir: 'desc',
      paginationOpts: { numItems: 3, cursor: null },
    });
    expect(first.page.map((r) => r.gallons)).toEqual([16, 15, 14]);
    expect(first.isDone).toBe(false);

    const second = await t.query(api.fuelReports.reportPurchases, {
      ...RANGE, sortKey: 'date', sortDir: 'desc',
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect(second.page.map((r) => r.gallons)).toEqual([13, 12, 11]);
    expect(second.isDone).toBe(false);

    const third = await t.query(api.fuelReports.reportPurchases, {
      ...RANGE, sortKey: 'date', sortDir: 'desc',
      paginationOpts: { numItems: 3, cursor: second.continueCursor },
    });
    expect(third.page.map((r) => r.gallons)).toEqual([10]);
    expect(third.isDone).toBe(true);
  });

  it('sorts by name columns and product order server-side, newest first on ties', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const { pilot, loves, ada, bob } = await t.run(async (ctx) => ({
      pilot: await seedVendor(ctx, 'Pilot'),
      loves: await seedVendor(ctx, 'Loves'),
      ada: await seedDriver(ctx, 'Ada'),
      bob: await seedDriver(ctx, 'Bob'),
    }));
    await t.run(async (ctx) => {
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 1 * DAY, gallons: 1, driverId: bob });
      await insertFuel(ctx, { vendorId: loves, entryDate: T0 + 2 * DAY, gallons: 2, driverId: ada });
      await insertDef(ctx, { vendorId: pilot, entryDate: T0 + 3 * DAY, gallons: 3 });
      // Same vendor as the first row, newer → wins the tie under vendor sort.
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 4 * DAY, gallons: 4 });
    });
    const q = (sortKey: 'vendor' | 'driver' | 'type', sortDir: 'asc' | 'desc') =>
      t.query(api.fuelReports.reportPurchases, {
        ...RANGE, sortKey, sortDir, paginationOpts: { numItems: 10, cursor: null },
      });

    const byVendor = await q('vendor', 'asc');
    expect(byVendor.page.map((r) => [r.vendorName, r.gallons])).toEqual([
      ['Loves', 2], ['Pilot', 4], ['Pilot', 3], ['Pilot', 1],
    ]);

    // Unassigned drivers sort as empty strings: first ascending.
    const byDriver = await q('driver', 'asc');
    expect(byDriver.page.map((r) => r.driverName ?? null)).toEqual([null, null, 'Ada Driver', 'Bob Driver']);

    // Canonical product order: Diesel before DEF, not alphabetical.
    const byType = await q('type', 'asc');
    expect(byType.page.map((r) => r.fuelType)).toEqual(['DIESEL', 'DIESEL', 'DIESEL', 'DEF']);
  });

  it('applies the same chip filters as the aggregate', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const { pilot, loves, ada } = await t.run(async (ctx) => ({
      pilot: await seedVendor(ctx, 'Pilot'),
      loves: await seedVendor(ctx, 'Loves'),
      ada: await seedDriver(ctx, 'Ada'),
    }));
    await t.run(async (ctx) => {
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 1 * DAY, gallons: 1, driverId: ada });
      await insertFuel(ctx, { vendorId: loves, entryDate: T0 + 2 * DAY, gallons: 2, driverId: ada });
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 3 * DAY, gallons: 3 });
      await insertDef(ctx, { vendorId: pilot, entryDate: T0 + 4 * DAY, gallons: 4 });
    });

    const pilotAda = await t.query(api.fuelReports.reportPurchases, {
      ...RANGE, vendorIds: [pilot], driverIds: [ada],
      sortKey: 'date', sortDir: 'desc', paginationOpts: { numItems: 10, cursor: null },
    });
    expect(pilotAda.page.map((r) => r.gallons)).toEqual([1]);
    expect(pilotAda.isDone).toBe(true);

    const defOnly = await t.query(api.fuelReports.reportEntries, { ...RANGE, fuelTypes: ['DEF'] });
    expect(defOnly.map((r) => r.gallons)).toEqual([4]);

    const summary = await t.query(api.fuelReports.reportSummary, {
      ...RANGE, vendorIds: [pilot], driverIds: [ada], bucketStarts: [T0],
    });
    expect(summary.totals.entries).toBe(pilotAda.page.length);
  });
});
