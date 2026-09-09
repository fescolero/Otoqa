import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api } from './_generated/api';

/**
 * Tests for fuelReports.reportSummary — the server-side aggregate behind
 * the fuel reports overview. Buckets, totals, shares and exception
 * counts must all reflect the same filtered pool.
 */

const ORG = 'org_rs_test';
const USER = 'user_rs_test';

const DAY = 86_400_000;
const T0 = 1_700_000_000_000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedVendor(ctx: any, name: string): Promise<Id<'fuelVendors'>> {
  const now = Date.now();
  return await ctx.db.insert('fuelVendors', {
    organizationId: ORG,
    name,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedDriver(ctx: any, first: string): Promise<Id<'drivers'>> {
  const now = Date.now();
  return await ctx.db.insert('drivers', {
    firstName: first, lastName: 'Driver', email: `${first}@t.co`, phone: '+15550000003',
    licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
    hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
    organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
  });
}

async function insertFuel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  opts: {
    vendorId: Id<'fuelVendors'>;
    entryDate: number;
    gallons: number;
    ppg: number;
    driverId?: Id<'drivers'>;
    loadId?: Id<'loadInformation'>;
    paymentMethod?: 'FUEL_CARD' | 'CASH';
    receiptStorageId?: Id<'_storage'>;
  },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('fuelEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    vendorId: opts.vendorId,
    driverId: opts.driverId,
    loadId: opts.loadId,
    gallons: opts.gallons,
    pricePerGallon: opts.ppg,
    totalCost: opts.gallons * opts.ppg,
    paymentMethod: opts.paymentMethod,
    receiptStorageId: opts.receiptStorageId,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

async function insertDef(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  opts: { vendorId: Id<'fuelVendors'>; entryDate: number; gallons: number; ppg: number },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('defEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    vendorId: opts.vendorId,
    gallons: opts.gallons,
    pricePerGallon: opts.ppg,
    totalCost: opts.gallons * opts.ppg,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

describe('reportSummary', () => {
  it('buckets rows by the caller-supplied starts, split by product', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx, 'Pilot'));
    await t.run(async (ctx) => {
      // Week 1: 100 gal diesel @ $4 and 10 gal DEF @ $3.
      await insertFuel(ctx, { vendorId, entryDate: T0 + 1 * DAY, gallons: 100, ppg: 4 });
      await insertDef(ctx, { vendorId, entryDate: T0 + 2 * DAY, gallons: 10, ppg: 3 });
      // Week 2: empty. Week 3: 50 gal diesel @ $4.
      await insertFuel(ctx, { vendorId, entryDate: T0 + 15 * DAY, gallons: 50, ppg: 4 });
      // Exactly on a bucket boundary lands in that bucket, not the prior one.
      await insertFuel(ctx, { vendorId, entryDate: T0 + 7 * DAY, gallons: 1, ppg: 4 });
    });

    const res = await t.query(api.fuelReports.reportSummary, {
      organizationId: ORG,
      dateRangeStart: T0,
      dateRangeEnd: T0 + 21 * DAY - 1,
      bucketStarts: [T0, T0 + 7 * DAY, T0 + 14 * DAY],
    });

    expect(res.buckets.map((b) => b.entries)).toEqual([2, 1, 1]);
    expect(res.buckets[0].spend).toBeCloseTo(430);
    expect(res.buckets[0].spendByType).toEqual({ DIESEL: 400, DEF: 30 });
    expect(res.buckets[0].gallonsByType).toEqual({ DIESEL: 100, DEF: 10 });
    expect(res.buckets[1].spend).toBeCloseTo(4);
    expect(res.buckets[2].spend).toBeCloseTo(200);

    expect(res.totals.entries).toBe(4);
    expect(res.totals.gallons).toBeCloseTo(161);
    // DEF is never a taxable gallon.
    expect(res.totals.fuelGallons).toBeCloseTo(151);
    expect(res.prior).toBeNull();

    expect(res.byType.map((x) => x.fuelType)).toEqual(['DIESEL', 'DEF']);
    expect(res.byVendor).toHaveLength(1);
    expect(res.byVendor[0].vendorName).toBe('Pilot');
    expect(res.byVendor[0].avgPricePerGallon).toBeCloseTo(634 / 161);
  });

  it('applies chip filters to buckets, totals, shares, exceptions and prior period alike', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const { pilot, loves, ada, bob } = await t.run(async (ctx) => ({
      pilot: await seedVendor(ctx, 'Pilot'),
      loves: await seedVendor(ctx, "Love's"),
      ada: await seedDriver(ctx, 'Ada'),
      bob: await seedDriver(ctx, 'Bob'),
    }));
    await t.run(async (ctx) => {
      // Current period.
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 1 * DAY, gallons: 100, ppg: 4, driverId: ada });
      await insertFuel(ctx, { vendorId: loves, entryDate: T0 + 2 * DAY, gallons: 100, ppg: 4, driverId: bob });
      // Unassigned fill: excluded once a driver chip is active.
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 + 3 * DAY, gallons: 100, ppg: 4 });
      // Prior period.
      await insertFuel(ctx, { vendorId: pilot, entryDate: T0 - 5 * DAY, gallons: 40, ppg: 4, driverId: ada });
      await insertFuel(ctx, { vendorId: loves, entryDate: T0 - 4 * DAY, gallons: 40, ppg: 4, driverId: bob });
    });

    const args = {
      organizationId: ORG,
      dateRangeStart: T0,
      dateRangeEnd: T0 + 7 * DAY - 1,
      priorStart: T0 - 7 * DAY,
      priorEnd: T0 - 1,
      bucketStarts: [T0],
    };

    const all = await t.query(api.fuelReports.reportSummary, args);
    expect(all.totals.entries).toBe(3);
    expect(all.prior?.entries).toBe(2);
    expect(all.byVendor.map((v) => v.entries).sort()).toEqual([1, 2]);

    const adaOnly = await t.query(api.fuelReports.reportSummary, { ...args, driverIds: [ada] });
    expect(adaOnly.totals.entries).toBe(1);
    expect(adaOnly.totals.spend).toBeCloseTo(400);
    expect(adaOnly.buckets[0].entries).toBe(1);
    expect(adaOnly.byVendor).toHaveLength(1);
    expect(adaOnly.byVendor[0].vendorName).toBe('Pilot');
    expect(adaOnly.prior?.entries).toBe(1);
    expect(adaOnly.prior?.spend).toBeCloseTo(160);
    // No receipts and no loads on any row → both rules count the one row.
    expect(adaOnly.exceptions.receipt).toBe(1);
    expect(adaOnly.exceptions.unlink).toBe(1);

    const defOnly = await t.query(api.fuelReports.reportSummary, { ...args, fuelTypes: ['DEF'] });
    expect(defOnly.totals.entries).toBe(0);
    expect(defOnly.buckets[0].spend).toBe(0);
    expect(defOnly.byType).toEqual([]);
  });

  it('classifies exceptions per rule with price anomalies judged within a product', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx, 'Pilot'));
    await t.run(async (ctx) => {
      const receipt = await ctx.storage.store(new Blob(['r']));
      const now = Date.now();
      const customerId: Id<'customers'> = await ctx.db.insert('customers', {
        name: 'Cust', companyType: 'Shipper', status: 'Active',
        addressLine1: '1', city: 'C', state: 'S', zip: 'Z', country: 'US',
        workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      } as never);
      const loadId: Id<'loadInformation'> = await ctx.db.insert('loadInformation', {
        internalId: 'LD-1', orderNumber: 'ORD-1', status: 'Open',
        trackingStatus: 'Pending', customerId, fleet: 'Default', units: 'Pallets',
        workosOrgId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      });
      // Baseline diesel @ $4, fuel card, receipt, load: clean.
      for (let i = 0; i < 4; i++) {
        await insertFuel(ctx, {
          vendorId, entryDate: T0 + i * DAY, gallons: 100, ppg: 4,
          paymentMethod: 'FUEL_CARD', receiptStorageId: receipt, loadId,
        });
      }
      // Outlier diesel @ $4.50 (> avg + 0.20), cash, no receipt, no load.
      await insertFuel(ctx, {
        vendorId, entryDate: T0 + 5 * DAY, gallons: 10, ppg: 4.5, paymentMethod: 'CASH',
      });
      // DEF @ $3.20 — a different product, must not be judged against diesel's average.
      await insertDef(ctx, { vendorId, entryDate: T0 + 6 * DAY, gallons: 10, ppg: 3.2 });
    });

    const res = await t.query(api.fuelReports.reportSummary, {
      organizationId: ORG,
      dateRangeStart: T0,
      dateRangeEnd: T0 + 7 * DAY,
      bucketStarts: [T0],
    });

    expect(res.exceptions.price).toBe(1);
    expect(res.exceptions.offcard).toBe(1);
    // The DEF row has no receipt or load either.
    expect(res.exceptions.receipt).toBe(2);
    expect(res.exceptions.unlink).toBe(2);
    expect(res.exceptions.total).toBe(6);
  });

  it('drops rows dated before the first bucket from the chart but not the totals', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx, 'Pilot'));
    await t.run(async (ctx) => {
      await insertFuel(ctx, { vendorId, entryDate: T0, gallons: 10, ppg: 4 });
      await insertFuel(ctx, { vendorId, entryDate: T0 + DAY, gallons: 10, ppg: 4 });
    });
    const res = await t.query(api.fuelReports.reportSummary, {
      organizationId: ORG,
      dateRangeStart: T0,
      dateRangeEnd: T0 + 2 * DAY,
      bucketStarts: [T0 + DAY],
    });
    expect(res.buckets[0].entries).toBe(1);
    expect(res.totals.entries).toBe(2);
  });
});
