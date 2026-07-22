import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import type { FuelType } from './lib/fuelTypes';
import { api } from './_generated/api';
import { normalizeFuelTypeCode } from './lib/fuelTypes';

/**
 * Tests for fuelReports.fuelByType — the query behind the "Spend by
 * fuel type" separation on the fuel reports page. Rows saved before the
 * fuelType field existed have no value and must aggregate under DIESEL.
 */

const ORG = 'org_fbt_test';
const USER = 'user_fbt_test';

const RANGE_START = 1_700_000_000_000;
const RANGE_END = 1_700_999_999_999;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function seedVendor(ctx: any): Promise<Id<'fuelVendors'>> {
  const now = Date.now();
  return await ctx.db.insert('fuelVendors', {
    organizationId: ORG,
    name: 'Pilot',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

async function insertEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  vendorId: Id<'fuelVendors'>,
  opts: { entryDate: number; gallons: number; totalCost: number; fuelType?: FuelType },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('fuelEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    vendorId,
    fuelType: opts.fuelType,
    gallons: opts.gallons,
    pricePerGallon: opts.totalCost / opts.gallons,
    totalCost: opts.totalCost,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

async function insertDefEntry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  vendorId: Id<'fuelVendors'>,
  opts: { entryDate: number; gallons: number; totalCost: number },
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert('defEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    vendorId,
    gallons: opts.gallons,
    pricePerGallon: opts.totalCost / opts.gallons,
    totalCost: opts.totalCost,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

describe('fuelByType', () => {
  it('separates spend by fuel type and counts untyped legacy rows as DIESEL', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx));
    await t.run(async (ctx) => {
      // Legacy row: no fuelType → DIESEL bucket.
      await insertEntry(ctx, vendorId, { entryDate: RANGE_START + 1_000, gallons: 100, totalCost: 400 });
      await insertEntry(ctx, vendorId, {
        entryDate: RANGE_START + 2_000,
        gallons: 50,
        totalCost: 200,
        fuelType: 'DIESEL',
      });
      await insertEntry(ctx, vendorId, {
        entryDate: RANGE_START + 3_000,
        gallons: 80,
        totalCost: 240,
        fuelType: 'DYED_DIESEL',
      });
      await insertEntry(ctx, vendorId, {
        entryDate: RANGE_START + 4_000,
        gallons: 10,
        totalCost: 35,
        fuelType: 'GASOLINE',
      });
      // DEF lives in its own table and must surface as the DEF bucket.
      await insertDefEntry(ctx, vendorId, {
        entryDate: RANGE_START + 5_000,
        gallons: 20,
        totalCost: 70,
      });
      // Out of range — must be ignored.
      await insertEntry(ctx, vendorId, {
        entryDate: RANGE_END + 100_000,
        gallons: 999,
        totalCost: 9_999,
        fuelType: 'GASOLINE',
      });
      await insertDefEntry(ctx, vendorId, {
        entryDate: RANGE_END + 100_000,
        gallons: 999,
        totalCost: 9_999,
      });
    });

    const results = await t.query(api.fuelReports.fuelByType, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(results.map((r) => r.fuelType)).toEqual(['DIESEL', 'DYED_DIESEL', 'DEF', 'GASOLINE']);

    const diesel = results[0];
    expect(diesel.gallons).toBe(150); // 100 legacy + 50 typed
    expect(diesel.totalCost).toBe(600);
    expect(diesel.entries).toBe(2);
    expect(diesel.avgPricePerGallon).toBe(4);

    const dyed = results[1];
    expect(dyed.gallons).toBe(80);
    expect(dyed.totalCost).toBe(240);
    expect(dyed.entries).toBe(1);

    const def = results[2];
    expect(def.gallons).toBe(20);
    expect(def.totalCost).toBe(70);
    expect(def.entries).toBe(1);
    expect(def.avgPricePerGallon).toBe(3.5);

    const gas = results[3];
    expect(gas.totalCost).toBe(35);
    expect(gas.entries).toBe(1);
  });

  it('rejects callers whose identity org does not match', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: 'some_other_org' });
    await expect(
      t.query(api.fuelReports.fuelByType, {
        organizationId: ORG,
        dateRangeStart: RANGE_START,
        dateRangeEnd: RANGE_END,
      }),
    ).rejects.toThrow(/Not authorized/);
  });
});

describe('normalizeFuelTypeCode', () => {
  it('maps receipt product codes to canonical fuel types', () => {
    expect(normalizeFuelTypeCode('DSL')).toBe('DIESEL');
    expect(normalizeFuelTypeCode('ulsd')).toBe('DIESEL');
    expect(normalizeFuelTypeCode('Ultra-Low Sulfur Diesel')).toBe('DIESEL');
    expect(normalizeFuelTypeCode('Dyed Diesel')).toBe('DYED_DIESEL');
    expect(normalizeFuelTypeCode('reefer')).toBe('DYED_DIESEL');
    expect(normalizeFuelTypeCode('B20')).toBe('BIODIESEL');
    expect(normalizeFuelTypeCode('UNL')).toBe('GASOLINE');
    expect(normalizeFuelTypeCode('Premium')).toBe('GASOLINE');
    expect(normalizeFuelTypeCode('DEF')).toBe('DEF');
    expect(normalizeFuelTypeCode('Diesel Exhaust Fluid')).toBe('DEF');
  });

  it('falls back to OTHER for unknown or empty values', () => {
    expect(normalizeFuelTypeCode('JET-A')).toBe('OTHER');
    expect(normalizeFuelTypeCode('')).toBe('OTHER');
    expect(normalizeFuelTypeCode('  ')).toBe('OTHER');
  });
});
