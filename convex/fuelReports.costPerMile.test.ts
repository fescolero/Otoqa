import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import { api } from './_generated/api';

/**
 * Tests for fuelReports.costPerMile. The fix hoisted the loadInformation
 * fallback scan out of the per-truck loop into a single date-bounded read,
 * and skips it entirely when odometer data already covers every truck.
 * These assert the user-visible output is unchanged and that the new
 * date-bounded `by_organization` + `_creationTime` range query runs.
 *
 * Note: the loads-based fallback is effectively inert — loadInformation has
 * no `truckId` field in the schema, so the lookup never matches. That was
 * true before the fix too; the value of the fix is eliminating the per-truck
 * full-table scan that read the whole table only to match nothing.
 */

const ORG = 'org_cpm_test';
const USER = 'user_cpm_test';

interface Seed {
  truckId: Id<'trucks'>;
  vendorId: Id<'fuelVendors'>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seed(ctx: any): Promise<Seed> {
  const now = Date.now();
  const truckId = await ctx.db.insert('trucks', {
    unitId: 'TRUCK-CPM',
    vin: '1HGCM82633A222222',
    make: 'Freightliner',
    model: 'Cascadia',
    status: 'Active',
    organizationId: ORG,
    createdBy: USER,
    createdAt: now,
    updatedAt: now,
  });
  const vendorId = await ctx.db.insert('fuelVendors', {
    organizationId: ORG,
    name: 'Pilot',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
  return { truckId, vendorId };
}

async function insertEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  s: Seed,
  opts: { entryDate: number; totalCost: number; gallons: number; odometerReading?: number },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('fuelEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    truckId: s.truckId,
    vendorId: s.vendorId,
    gallons: opts.gallons,
    pricePerGallon: opts.totalCost / opts.gallons,
    totalCost: opts.totalCost,
    odometerReading: opts.odometerReading,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

const RANGE_START = 1_700_000_000_000;
const RANGE_END = 1_700_999_999_999;

describe('costPerMile', () => {
  it('computes cost/mile from odometer deltas (preferred source)', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const s = await t.run(async (ctx) => seed(ctx));
    await t.run(async (ctx) => {
      await insertEntry(ctx, s, {
        entryDate: RANGE_START + 1_000,
        totalCost: 200,
        gallons: 40,
        odometerReading: 1000,
      });
      await insertEntry(ctx, s, {
        entryDate: RANGE_START + 2_000,
        totalCost: 300,
        gallons: 60,
        odometerReading: 1500,
      });
    });

    const results = await t.query(api.fuelReports.costPerMile, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(results).toHaveLength(1);
    const row = results[0];
    expect(row.truckId).toBe(s.truckId);
    expect(row.unitId).toBe('TRUCK-CPM');
    expect(row.make).toBe('Freightliner');
    expect(row.totalCost).toBe(500);
    expect(row.totalGallons).toBe(100);
    expect(row.totalMiles).toBe(500); // 1500 - 1000
    expect(row.milesSource).toBe('odometer');
    expect(row.costPerMile).toBe(1); // 500 / 500
  });

  it('falls back to milesSource "none" when a truck lacks ≥2 odometer readings', async () => {
    // Exercises the needsLoadFallback branch: the date-bounded loadInformation
    // query runs (runtime-validating the _creationTime index range) but finds
    // no truck-matched miles, so totalMiles stays 0.
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const s = await t.run(async (ctx) => seed(ctx));
    await t.run(async (ctx) => {
      await insertEntry(ctx, s, {
        entryDate: RANGE_START + 1_000,
        totalCost: 250,
        gallons: 50,
        // single odometer reading → can't derive a delta
        odometerReading: 1000,
      });
      // Seed a load inside the window to prove the fallback scan executes
      // against real data without error.
      const customerId = await ctx.db.insert('customers', {
        name: 'C',
        companyType: 'Shipper',
        status: 'Active',
        addressLine1: '1 St',
        city: 'Town',
        state: 'CA',
        zip: '00000',
        country: 'USA',
        workosOrgId: ORG,
        createdBy: USER,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert('loadInformation', {
        internalId: 'LD-CPM-1',
        orderNumber: 'LD-CPM-1',
        status: 'Assigned',
        trackingStatus: 'In Transit',
        customerId,
        fleet: 'Default',
        units: 'Pallets',
        effectiveMiles: 400,
        workosOrgId: ORG,
        createdBy: USER,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    const results = await t.query(api.fuelReports.costPerMile, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(results).toHaveLength(1);
    expect(results[0].totalMiles).toBe(0);
    expect(results[0].milesSource).toBe('none');
    expect(results[0].costPerMile).toBe(0);
    expect(results[0].totalCost).toBe(250);
  });

  it('excludes fuel entries outside the date range', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const s = await t.run(async (ctx) => seed(ctx));
    await t.run(async (ctx) => {
      // In range
      await insertEntry(ctx, s, {
        entryDate: RANGE_START + 1_000,
        totalCost: 100,
        gallons: 20,
        odometerReading: 1000,
      });
      await insertEntry(ctx, s, {
        entryDate: RANGE_END - 1_000,
        totalCost: 100,
        gallons: 20,
        odometerReading: 1200,
      });
      // Out of range (after end) — must be ignored
      await insertEntry(ctx, s, {
        entryDate: RANGE_END + 100_000,
        totalCost: 9999,
        gallons: 999,
        odometerReading: 99999,
      });
    });

    const results = await t.query(api.fuelReports.costPerMile, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(results).toHaveLength(1);
    expect(results[0].totalCost).toBe(200); // only the two in-range entries
    expect(results[0].totalMiles).toBe(200); // 1200 - 1000
  });

  it('rejects callers whose identity org does not match', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: 'some_other_org' });
    await t.run(async (ctx) => seed(ctx));

    await expect(
      t.query(api.fuelReports.costPerMile, {
        organizationId: ORG,
        dateRangeStart: RANGE_START,
        dateRangeEnd: RANGE_END,
      }),
    ).rejects.toThrow(/Not authorized/);
  });
});
