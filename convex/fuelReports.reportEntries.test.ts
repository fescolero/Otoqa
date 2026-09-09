import { convexTest } from 'convex-test';
import { describe, it, expect } from 'vitest';
import schema from './schema';
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { api } from './_generated/api';
import { MAX_RANGE_ROWS } from './fuelReports';

/**
 * Tests for fuelReports.reportEntries — the unpaginated row feed behind
 * the fuel reports chart, exception counts and purchases table. It
 * replaced a 500-row page of fuelEntries.listCombined, so the property
 * that matters most is that every entry in the range comes back.
 */

const ORG = 'org_re_test';
const OTHER_ORG = 'org_re_other';
const USER = 'user_re_test';

const RANGE_START = 1_700_000_000_000;
const RANGE_END = 1_700_999_999_999;
async function seedVendor(ctx: MutationCtx, org = ORG): Promise<Id<'fuelVendors'>> {
  const now = Date.now();
  return await ctx.db.insert('fuelVendors', {
    organizationId: org,
    name: 'Pilot',
    isActive: true,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

async function insertFuel(
  ctx: MutationCtx,
  vendorId: Id<'fuelVendors'>,
  opts: {
    entryDate: number;
    gallons?: number;
    org?: string;
    receiptStorageId?: Id<'_storage'>;
    driverId?: Id<'drivers'>;
    truckId?: Id<'trucks'>;
  },
): Promise<Id<'fuelEntries'>> {
  const now = Date.now();
  const gallons = opts.gallons ?? 100;
  return await ctx.db.insert('fuelEntries', {
    organizationId: opts.org ?? ORG,
    entryDate: opts.entryDate,
    vendorId,
    driverId: opts.driverId,
    truckId: opts.truckId,
    gallons,
    pricePerGallon: 4,
    totalCost: gallons * 4,
    receiptStorageId: opts.receiptStorageId,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

async function insertDef(
  ctx: MutationCtx,
  vendorId: Id<'fuelVendors'>,
  opts: { entryDate: number },
): Promise<Id<'defEntries'>> {
  const now = Date.now();
  return await ctx.db.insert('defEntries', {
    organizationId: ORG,
    entryDate: opts.entryDate,
    vendorId,
    gallons: 10,
    pricePerGallon: 3,
    totalCost: 30,
    createdAt: now,
    updatedAt: now,
    createdBy: USER,
  });
}

describe('reportEntries', () => {
  it('returns every entry in the range, not a capped page', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx));
    const COUNT = 620; // comfortably past the old 500-row page
    await t.run(async (ctx) => {
      for (let i = 0; i < COUNT; i++) {
        await insertFuel(ctx, vendorId, { entryDate: RANGE_START + i * 60_000 });
      }
    });

    const { rows } = await t.query(api.fuelReports.reportEntries, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(rows).toHaveLength(COUNT);
    // Newest first, like listCombined.
    expect(rows[0].entryDate).toBe(RANGE_START + (COUNT - 1) * 60_000);
    expect(rows[rows.length - 1].entryDate).toBe(RANGE_START);
  });

  it('bounds the read at MAX_RANGE_ROWS per table, keeping the newest rows and flagging it', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx));
    const COUNT = MAX_RANGE_ROWS + 5;
    await t.run(async (ctx) => {
      for (let i = 0; i < COUNT; i++) {
        await insertFuel(ctx, vendorId, { entryDate: RANGE_START + i * 1000 });
      }
      // DEF is bounded independently and is nowhere near the cap.
      await insertDef(ctx, vendorId, { entryDate: RANGE_START });
      // Fills just AFTER the range feed the anomaly benchmark only. Being
      // newest they must never displace requested in-range rows.
      for (let i = 0; i < 10; i++) {
        await insertFuel(ctx, vendorId, { entryDate: RANGE_END + 1 + i * 1000 });
      }
    });

    const res = await t.query(api.fuelReports.reportEntries, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(res.truncated).toBe(true);
    expect(res.rows).toHaveLength(MAX_RANGE_ROWS + 1);
    expect(res.rows.every((r) => r.entryDate <= RANGE_END)).toBe(true);
    // The oldest fuel rows are the ones dropped.
    const fuelDates = res.rows.filter((r) => r.type === 'fuel').map((r) => r.entryDate);
    expect(Math.min(...fuelDates)).toBe(RANGE_START + 5 * 1000);
    expect(Math.max(...fuelDates)).toBe(RANGE_START + (COUNT - 1) * 1000);

    const summary = await t.query(api.fuelReports.reportSummary, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
      bucketStarts: [RANGE_START],
    });
    expect(summary.truncated).toBe(true);
    expect(summary.totals.entries).toBe(MAX_RANGE_ROWS + 1);
  });

  it('merges fuel and DEF rows, tags the source, and projects lookups', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const { vendorId, driverId, truckId } = await t.run(async (ctx) => {
      const vendorId = await seedVendor(ctx);
      const now = Date.now();
      const driverId: Id<'drivers'> = await ctx.db.insert('drivers', {
        firstName: 'Ada', lastName: 'Lovelace', email: 'ada@t.co', phone: '+15550000002',
        licenseState: 'CA', licenseExpiration: '2030-01-01', licenseClass: 'A',
        hireDate: '2024-01-01', employmentStatus: 'Active', employmentType: 'Full-time',
        organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      });
      const truckId: Id<'trucks'> = await ctx.db.insert('trucks', {
        unitId: 'T-42', vin: 'VIN-RE-1', status: 'Active',
        organizationId: ORG, createdBy: USER, createdAt: now, updatedAt: now,
      });
      return { vendorId, driverId, truckId };
    });

    await t.run(async (ctx) => {
      await insertFuel(ctx, vendorId, { entryDate: RANGE_START + 1, driverId, truckId });
      await insertDef(ctx, vendorId, { entryDate: RANGE_START + 2 });
    });

    const { rows } = await t.query(api.fuelReports.reportEntries, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(rows.map((r) => r.type)).toEqual(['def', 'fuel']);
    const def = rows[0];
    expect(def.fuelType).toBe('DEF');
    expect(def.vendorName).toBe('Pilot');
    const fuel = rows[1];
    // Untyped legacy fuel rows count as diesel.
    expect(fuel.fuelType).toBe('DIESEL');
    expect(fuel.driverId).toBe(driverId);
    expect(fuel.driverName).toBe('Ada Lovelace');
    expect(fuel.truckId).toBe(truckId);
    expect(fuel.truckUnitId).toBe('T-42');
  });

  it('reports receipt presence as a boolean', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const vendorId = await t.run(async (ctx) => seedVendor(ctx));
    await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(['receipt']));
      await insertFuel(ctx, vendorId, { entryDate: RANGE_START + 1, receiptStorageId: storageId });
      await insertFuel(ctx, vendorId, { entryDate: RANGE_START + 2 });
    });

    const { rows } = await t.query(api.fuelReports.reportEntries, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(rows.map((r) => r.hasReceipt)).toEqual([false, true]);
  });

  it('excludes rows outside the range and rows from other orgs', async () => {
    const t = convexTest(schema).withIdentity({ subject: USER, org_id: ORG });
    const { vendorId, otherVendorId } = await t.run(async (ctx) => ({
      vendorId: await seedVendor(ctx),
      otherVendorId: await seedVendor(ctx, OTHER_ORG),
    }));
    await t.run(async (ctx) => {
      await insertFuel(ctx, vendorId, { entryDate: RANGE_START - 1 });
      await insertFuel(ctx, vendorId, { entryDate: RANGE_START });
      await insertFuel(ctx, vendorId, { entryDate: RANGE_END });
      await insertFuel(ctx, vendorId, { entryDate: RANGE_END + 1 });
      await insertFuel(ctx, otherVendorId, { entryDate: RANGE_START + 5, org: OTHER_ORG });
    });

    const { rows } = await t.query(api.fuelReports.reportEntries, {
      organizationId: ORG,
      dateRangeStart: RANGE_START,
      dateRangeEnd: RANGE_END,
    });

    expect(rows.map((r) => r.entryDate).sort()).toEqual([RANGE_START, RANGE_END]);
  });
});
