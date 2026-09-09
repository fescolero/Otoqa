import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { loadReferenceOf } from './lib/loadReference';
import { assertCallerOwnsOrg } from './lib/auth';
import { DEFAULT_FUEL_TYPE, FUEL_PRODUCT_ORDER, type FuelProduct } from './lib/fuelTypes';
import {
  assessPrices,
  isTotalMismatch,
  PRICE_ANOMALY,
  type PriceAssessment,
  type PriceTier,
} from './lib/fuelAnomaly';

export const fuelByDriver = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const entries = await ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', args.organizationId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd)
      )
      .collect();

    const byDriver: Record<string, { gallons: number; totalCost: number; entries: number }> = {};

    for (const entry of entries) {
      if (!entry.driverId) continue;
      const key = entry.driverId as string;
      if (!byDriver[key]) {
        byDriver[key] = { gallons: 0, totalCost: 0, entries: 0 };
      }
      byDriver[key].gallons += entry.gallons;
      byDriver[key].totalCost += entry.totalCost;
      byDriver[key].entries += 1;
    }

    const results = await Promise.all(
      Object.entries(byDriver).map(async ([driverId, data]) => {
        const driver = await ctx.db.get(driverId as Id<'drivers'>);
        return {
          driverId,
          driverName: driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown',
          gallons: Math.round(data.gallons * 100) / 100,
          totalCost: Math.round(data.totalCost * 100) / 100,
          avgPricePerGallon: data.gallons > 0 ? Math.round((data.totalCost / data.gallons) * 1000) / 1000 : 0,
          entries: data.entries,
        };
      })
    );

    return results.sort((a, b) => b.totalCost - a.totalCost);
  },
});

export const fuelByCarrier = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const entries = await ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', args.organizationId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd)
      )
      .collect();

    const byCarrier: Record<string, { gallons: number; totalCost: number; entries: number }> = {};

    for (const entry of entries) {
      if (!entry.carrierId) continue;
      const key = entry.carrierId as string;
      if (!byCarrier[key]) {
        byCarrier[key] = { gallons: 0, totalCost: 0, entries: 0 };
      }
      byCarrier[key].gallons += entry.gallons;
      byCarrier[key].totalCost += entry.totalCost;
      byCarrier[key].entries += 1;
    }

    const results = await Promise.all(
      Object.entries(byCarrier).map(async ([carrierId, data]) => {
        const carrier = await ctx.db.get(carrierId as Id<'carrierPartnerships'>);
        return {
          carrierId,
          carrierName: carrier?.carrierName ?? 'Unknown',
          gallons: Math.round(data.gallons * 100) / 100,
          totalCost: Math.round(data.totalCost * 100) / 100,
          avgPricePerGallon: data.gallons > 0 ? Math.round((data.totalCost / data.gallons) * 1000) / 1000 : 0,
          entries: data.entries,
        };
      })
    );

    return results.sort((a, b) => b.totalCost - a.totalCost);
  },
});

export const fuelByTruck = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const entries = await ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', args.organizationId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd)
      )
      .collect();

    const byTruck: Record<string, { gallons: number; totalCost: number; entries: number }> = {};

    for (const entry of entries) {
      if (!entry.truckId) continue;
      const key = entry.truckId as string;
      if (!byTruck[key]) {
        byTruck[key] = { gallons: 0, totalCost: 0, entries: 0 };
      }
      byTruck[key].gallons += entry.gallons;
      byTruck[key].totalCost += entry.totalCost;
      byTruck[key].entries += 1;
    }

    const results = await Promise.all(
      Object.entries(byTruck).map(async ([truckId, data]) => {
        const truck = await ctx.db.get(truckId as Id<'trucks'>);
        return {
          truckId,
          unitId: truck?.unitId ?? 'Unknown',
          make: truck?.make,
          model: truck?.model,
          gallons: Math.round(data.gallons * 100) / 100,
          totalCost: Math.round(data.totalCost * 100) / 100,
          avgPricePerGallon: data.gallons > 0 ? Math.round((data.totalCost / data.gallons) * 1000) / 1000 : 0,
          entries: data.entries,
        };
      })
    );

    return results.sort((a, b) => b.totalCost - a.totalCost);
  },
});

export const fuelByVendor = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    // Vendor spend covers every product bought at the pump — fuel AND
    // DEF — so the card's total matches the report's headline spend.
    const [fuelEntriesList, defEntriesList] = await Promise.all([
      ctx.db
        .query('fuelEntries')
        .withIndex('by_organization_and_date', (q) =>
          q.eq('organizationId', args.organizationId)
            .gte('entryDate', args.dateRangeStart)
            .lte('entryDate', args.dateRangeEnd)
        )
        .collect(),
      ctx.db
        .query('defEntries')
        .withIndex('by_organization_and_date', (q) =>
          q.eq('organizationId', args.organizationId)
            .gte('entryDate', args.dateRangeStart)
            .lte('entryDate', args.dateRangeEnd)
        )
        .collect(),
    ]);
    const entries = [...fuelEntriesList, ...defEntriesList];

    const byVendor: Record<string, { gallons: number; totalCost: number; entries: number }> = {};

    for (const entry of entries) {
      const key = entry.vendorId as string;
      if (!byVendor[key]) {
        byVendor[key] = { gallons: 0, totalCost: 0, entries: 0 };
      }
      byVendor[key].gallons += entry.gallons;
      byVendor[key].totalCost += entry.totalCost;
      byVendor[key].entries += 1;
    }

    const results = await Promise.all(
      Object.entries(byVendor).map(async ([vendorId, data]) => {
        const vendor = await ctx.db.get(vendorId as Id<'fuelVendors'>);
        return {
          vendorId,
          vendorName: vendor?.name ?? 'Unknown',
          gallons: Math.round(data.gallons * 100) / 100,
          totalCost: Math.round(data.totalCost * 100) / 100,
          avgPricePerGallon: data.gallons > 0 ? Math.round((data.totalCost / data.gallons) * 1000) / 1000 : 0,
          entries: data.entries,
        };
      })
    );

    return results.sort((a, b) => b.totalCost - a.totalCost);
  },
});

export const fuelByType = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const [entries, defEntriesList] = await Promise.all([
      ctx.db
        .query('fuelEntries')
        .withIndex('by_organization_and_date', (q) =>
          q.eq('organizationId', args.organizationId)
            .gte('entryDate', args.dateRangeStart)
            .lte('entryDate', args.dateRangeEnd)
        )
        .collect(),
      ctx.db
        .query('defEntries')
        .withIndex('by_organization_and_date', (q) =>
          q.eq('organizationId', args.organizationId)
            .gte('entryDate', args.dateRangeStart)
            .lte('entryDate', args.dateRangeEnd)
        )
        .collect(),
    ]);

    // Rows created before the fuelType field existed count as diesel.
    // DEF has no fuelType column at all — its table IS the type.
    const byType: Record<string, { gallons: number; totalCost: number; entries: number }> = {};
    const bump = (key: FuelProduct, gallons: number, totalCost: number) => {
      if (!byType[key]) {
        byType[key] = { gallons: 0, totalCost: 0, entries: 0 };
      }
      byType[key].gallons += gallons;
      byType[key].totalCost += totalCost;
      byType[key].entries += 1;
    };

    for (const entry of entries) {
      bump(entry.fuelType ?? DEFAULT_FUEL_TYPE, entry.gallons, entry.totalCost);
    }
    for (const entry of defEntriesList) {
      bump('DEF', entry.gallons, entry.totalCost);
    }

    return Object.entries(byType)
      .map(([fuelType, data]) => ({
        fuelType: fuelType as FuelProduct,
        gallons: Math.round(data.gallons * 100) / 100,
        totalCost: Math.round(data.totalCost * 100) / 100,
        avgPricePerGallon: data.gallons > 0 ? Math.round((data.totalCost / data.gallons) * 1000) / 1000 : 0,
        entries: data.entries,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);
  },
});

export const costPerMile = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const entries = await ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', args.organizationId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd)
      )
      .collect();

    const byTruck: Record<string, {
      totalCost: number;
      gallons: number;
      odometerReadings: Array<{ date: number; reading: number }>;
    }> = {};

    for (const entry of entries) {
      if (!entry.truckId) continue;
      const key = entry.truckId as string;
      if (!byTruck[key]) {
        byTruck[key] = { totalCost: 0, gallons: 0, odometerReadings: [] };
      }
      byTruck[key].totalCost += entry.totalCost;
      byTruck[key].gallons += entry.gallons;
      if (entry.odometerReading) {
        byTruck[key].odometerReadings.push({
          date: entry.entryDate,
          reading: entry.odometerReading,
        });
      }
    }

    // Odometer-derived miles per truck (the preferred source). Computed up
    // front so we can tell whether ANY truck needs the loads-based fallback
    // before deciding to read loadInformation at all.
    const odometerMilesByTruck: Record<string, number> = {};
    for (const [truckId, data] of Object.entries(byTruck)) {
      if (data.odometerReadings.length >= 2) {
        const sorted = data.odometerReadings.sort((a, b) => a.date - b.date);
        odometerMilesByTruck[truckId] = sorted[sorted.length - 1].reading - sorted[0].reading;
      } else {
        odometerMilesByTruck[truckId] = 0;
      }
    }

    // Loads-based fallback miles per truck. Previously this scanned the FULL
    // loadInformation table once PER truck inside the result loop — O(trucks ×
    // org loads) reads, which is what neared the per-query bytes/documents
    // read limit. Now it's a single date-bounded scan (the by_organization
    // index implicitly orders by _creationTime, so the range trims the read to
    // the report window) grouped by truck, and only when a truck actually
    // lacks usable odometer data.
    const loadMilesByTruck: Record<string, number> = {};
    const needsLoadFallback = Object.values(odometerMilesByTruck).some((m) => m <= 0);
    if (needsLoadFallback) {
      const loads = await ctx.db
        .query('loadInformation')
        .withIndex('by_organization', (q) =>
          q
            .eq('workosOrgId', args.organizationId)
            .gte('_creationTime', args.dateRangeStart)
            .lte('_creationTime', args.dateRangeEnd)
        )
        .collect();

      for (const load of loads) {
        const loadTruckId = (load as Record<string, unknown>).truckId as string | undefined;
        if (!loadTruckId || !load.effectiveMiles) continue;
        loadMilesByTruck[loadTruckId] = (loadMilesByTruck[loadTruckId] ?? 0) + load.effectiveMiles;
      }
    }

    const results = await Promise.all(
      Object.entries(byTruck).map(async ([truckId, data]) => {
        const truck = await ctx.db.get(truckId as Id<'trucks'>);

        let totalMiles = odometerMilesByTruck[truckId] ?? 0;
        let milesSource: 'odometer' | 'loads' | 'none' =
          data.odometerReadings.length >= 2 ? 'odometer' : 'none';

        if (totalMiles <= 0) {
          totalMiles += loadMilesByTruck[truckId] ?? 0;
          if (totalMiles > 0) milesSource = 'loads';
        }

        const costPerMileValue = totalMiles > 0
          ? Math.round((data.totalCost / totalMiles) * 1000) / 1000
          : 0;

        return {
          truckId,
          unitId: truck?.unitId ?? 'Unknown',
          make: truck?.make,
          model: truck?.model,
          totalCost: Math.round(data.totalCost * 100) / 100,
          totalGallons: Math.round(data.gallons * 100) / 100,
          totalMiles: Math.round(totalMiles),
          costPerMile: costPerMileValue,
          milesSource,
        };
      })
    );

    return results.sort((a, b) => b.totalCost - a.totalCost);
  },
});

export const defUsage = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
    groupBy: v.optional(v.union(v.literal('driver'), v.literal('carrier'), v.literal('truck'))),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const entries = await ctx.db
      .query('defEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', args.organizationId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd)
      )
      .collect();

    const groupBy = args.groupBy ?? 'driver';
    const grouped: Record<string, { gallons: number; totalCost: number; entries: number }> = {};

    for (const entry of entries) {
      let key: string | undefined;
      if (groupBy === 'driver' && entry.driverId) key = entry.driverId as string;
      else if (groupBy === 'carrier' && entry.carrierId) key = entry.carrierId as string;
      else if (groupBy === 'truck' && entry.truckId) key = entry.truckId as string;

      if (!key) continue;
      if (!grouped[key]) {
        grouped[key] = { gallons: 0, totalCost: 0, entries: 0 };
      }
      grouped[key].gallons += entry.gallons;
      grouped[key].totalCost += entry.totalCost;
      grouped[key].entries += 1;
    }

    const results = await Promise.all(
      Object.entries(grouped).map(async ([id, data]) => {
        let name = 'Unknown';
        if (groupBy === 'driver') {
          const driver = await ctx.db.get(id as Id<'drivers'>);
          name = driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown';
        } else if (groupBy === 'carrier') {
          const carrier = await ctx.db.get(id as Id<'carrierPartnerships'>);
          name = carrier?.carrierName ?? 'Unknown';
        } else if (groupBy === 'truck') {
          const truck = await ctx.db.get(id as Id<'trucks'>);
          name = truck?.unitId ?? 'Unknown';
        }

        return {
          id,
          name,
          groupBy,
          gallons: Math.round(data.gallons * 100) / 100,
          totalCost: Math.round(data.totalCost * 100) / 100,
          avgPricePerGallon: data.gallons > 0 ? Math.round((data.totalCost / data.gallons) * 1000) / 1000 : 0,
          entries: data.entries,
        };
      })
    );

    return results.sort((a, b) => b.totalCost - a.totalCost);
  },
});

export const monthlySummary = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const fuelEntries = await ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', args.organizationId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd)
      )
      .collect();

    const defEntriesList = await ctx.db
      .query('defEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', args.organizationId)
          .gte('entryDate', args.dateRangeStart)
          .lte('entryDate', args.dateRangeEnd)
      )
      .collect();

    const monthly: Record<string, {
      fuelGallons: number;
      fuelCost: number;
      fuelEntries: number;
      defGallons: number;
      defCost: number;
      defEntries: number;
    }> = {};

    const getMonthKey = (timestamp: number) => {
      const d = new Date(timestamp);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };

    for (const entry of fuelEntries) {
      const key = getMonthKey(entry.entryDate);
      if (!monthly[key]) {
        monthly[key] = { fuelGallons: 0, fuelCost: 0, fuelEntries: 0, defGallons: 0, defCost: 0, defEntries: 0 };
      }
      monthly[key].fuelGallons += entry.gallons;
      monthly[key].fuelCost += entry.totalCost;
      monthly[key].fuelEntries += 1;
    }

    for (const entry of defEntriesList) {
      const key = getMonthKey(entry.entryDate);
      if (!monthly[key]) {
        monthly[key] = { fuelGallons: 0, fuelCost: 0, fuelEntries: 0, defGallons: 0, defCost: 0, defEntries: 0 };
      }
      monthly[key].defGallons += entry.gallons;
      monthly[key].defCost += entry.totalCost;
      monthly[key].defEntries += 1;
    }

    const totals = {
      totalFuelGallons: 0,
      totalFuelCost: 0,
      totalFuelEntries: 0,
      totalDefGallons: 0,
      totalDefCost: 0,
      totalDefEntries: 0,
      avgFuelPricePerGallon: 0,
      avgDefPricePerGallon: 0,
    };

    for (const data of Object.values(monthly)) {
      totals.totalFuelGallons += data.fuelGallons;
      totals.totalFuelCost += data.fuelCost;
      totals.totalFuelEntries += data.fuelEntries;
      totals.totalDefGallons += data.defGallons;
      totals.totalDefCost += data.defCost;
      totals.totalDefEntries += data.defEntries;
    }

    totals.avgFuelPricePerGallon = totals.totalFuelGallons > 0
      ? Math.round((totals.totalFuelCost / totals.totalFuelGallons) * 1000) / 1000
      : 0;
    totals.avgDefPricePerGallon = totals.totalDefGallons > 0
      ? Math.round((totals.totalDefCost / totals.totalDefGallons) * 1000) / 1000
      : 0;

    const months = Object.entries(monthly)
      .map(([month, data]) => ({
        month,
        fuelGallons: Math.round(data.fuelGallons * 100) / 100,
        fuelCost: Math.round(data.fuelCost * 100) / 100,
        fuelEntries: data.fuelEntries,
        avgFuelPrice: data.fuelGallons > 0 ? Math.round((data.fuelCost / data.fuelGallons) * 1000) / 1000 : 0,
        defGallons: Math.round(data.defGallons * 100) / 100,
        defCost: Math.round(data.defCost * 100) / 100,
        defEntries: data.defEntries,
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return {
      totals: {
        ...totals,
        totalFuelGallons: Math.round(totals.totalFuelGallons * 100) / 100,
        totalFuelCost: Math.round(totals.totalFuelCost * 100) / 100,
        totalDefGallons: Math.round(totals.totalDefGallons * 100) / 100,
        totalDefCost: Math.round(totals.totalDefCost * 100) / 100,
      },
      months,
    };
  },
});

// ─── Shared range loading + chip filters ──────────────────────────────
// The reports page has one pool of rows (fuel + DEF in the date range)
// and one set of filter chips. Both the row feed (reportEntries) and the
// aggregate (reportSummary) load and filter that pool the same way so the
// chart, KPIs and purchases table can never disagree about scope.

type RangeRow = {
  entry: Doc<'fuelEntries'> | Doc<'defEntries'>;
  type: 'fuel' | 'def';
  /** DEF rows come from their own table; untyped fuel rows are diesel. */
  product: FuelProduct;
};

/**
 * Upper bound on rows read per product table per range. A Convex query
 * may scan a bounded number of documents per transaction; reportSummary
 * reads two tables for the range AND two for the prior period, plus
 * lookups, so the cap keeps the worst case well inside that budget.
 * Reads run newest-first, so when a range exceeds the cap it is the
 * OLDEST rows that fall out, and every caller surfaces `truncated` so
 * the page can say the figures are partial rather than silently
 * under-report.
 */
export const MAX_RANGE_ROWS = 3000;

async function loadRangeRows(
  ctx: QueryCtx,
  organizationId: string,
  dateRangeStart: number,
  dateRangeEnd: number,
  cap: number = MAX_RANGE_ROWS,
  /** Which end survives the cap: 'desc' keeps the newest rows, 'asc' the oldest. */
  order: 'desc' | 'asc' = 'desc',
): Promise<{ rows: RangeRow[]; truncated: boolean }> {
  const [fuelEntries, defEntriesList] = await Promise.all([
    ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', organizationId)
          .gte('entryDate', dateRangeStart)
          .lte('entryDate', dateRangeEnd)
      )
      .order(order)
      .take(cap + 1),
    ctx.db
      .query('defEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', organizationId)
          .gte('entryDate', dateRangeStart)
          .lte('entryDate', dateRangeEnd)
      )
      .order(order)
      .take(cap + 1),
  ]);
  const truncated = fuelEntries.length > cap || defEntriesList.length > cap;
  return {
    truncated,
    rows: [
      ...fuelEntries.slice(0, cap).map((entry) => ({
        entry,
        type: 'fuel' as const,
        product: (entry.fuelType ?? DEFAULT_FUEL_TYPE) as FuelProduct,
      })),
      ...defEntriesList.slice(0, cap).map((entry) => ({
        entry,
        type: 'def' as const,
        product: 'DEF' as FuelProduct,
      })),
    ],
  };
}

/** Filter-chip args shared by the report queries. Each list is `is any of`. */
const reportFilterArgs = {
  driverIds: v.optional(v.array(v.string())),
  carrierIds: v.optional(v.array(v.string())),
  truckIds: v.optional(v.array(v.string())),
  vendorIds: v.optional(v.array(v.string())),
  fuelTypes: v.optional(v.array(v.string())),
  /** Exception rule ids (see EXCEPTION_IDS); a row matches if ANY applies. */
  exceptions: v.optional(v.array(v.string())),
};

type ReportFilters = {
  driverIds?: string[];
  carrierIds?: string[];
  truckIds?: string[];
  vendorIds?: string[];
  fuelTypes?: string[];
  exceptions?: string[];
};

/** The five exception rules the reports page can count and filter by. */
export const EXCEPTION_IDS = ['receipt', 'offcard', 'price', 'unlink', 'mismatch'] as const;
export type ExceptionId = (typeof EXCEPTION_IDS)[number];

/** Which rules a row trips. `price` needs its assessment. */
function exceptionsFor(row: RangeRow, price: PriceAssessment | undefined): ExceptionId[] {
  const { entry } = row;
  const out: ExceptionId[] = [];
  if (!entry.receiptStorageId) out.push('receipt');
  if (entry.paymentMethod && entry.paymentMethod !== 'FUEL_CARD') out.push('offcard');
  if (price?.flagged) out.push('price');
  if (!entry.loadId) out.push('unlink');
  if (isTotalMismatch(entry)) out.push('mismatch');
  return out;
}

/**
 * Narrow the pool to rows matching every active chip. A chip on an
 * optional relation (driver / carrier / truck) excludes rows that have
 * no value — "Driver is any of X" should not show unassigned fills.
 * The exception chip needs the price assessments (built from the
 * UNFILTERED pool, so filtering never moves the benchmark).
 */
function applyReportFilters(
  rows: RangeRow[],
  f: ReportFilters,
  assess?: Map<string, PriceAssessment>,
): RangeRow[] {
  const driver = f.driverIds?.length ? new Set(f.driverIds) : null;
  const carrier = f.carrierIds?.length ? new Set(f.carrierIds) : null;
  const truck = f.truckIds?.length ? new Set(f.truckIds) : null;
  const vendor = f.vendorIds?.length ? new Set(f.vendorIds) : null;
  const product = f.fuelTypes?.length ? new Set(f.fuelTypes) : null;
  const exception = f.exceptions?.length ? new Set(f.exceptions) : null;
  if (!driver && !carrier && !truck && !vendor && !product && !exception) return rows;
  return rows.filter((row) => {
    const { entry, product: p } = row;
    if (driver && (!entry.driverId || !driver.has(entry.driverId))) return false;
    if (carrier && (!entry.carrierId || !carrier.has(entry.carrierId))) return false;
    if (truck && (!entry.truckId || !truck.has(entry.truckId))) return false;
    if (vendor && !vendor.has(entry.vendorId)) return false;
    if (product && !product.has(p)) return false;
    if (exception) {
      const hits = exceptionsFor(row, assess?.get(entry._id as string));
      if (!hits.some((id) => exception.has(id))) return false;
    }
    return true;
  });
}

const ANOMALY_WINDOW_MS = PRICE_ANOMALY.windowDays * 86_400_000;

/**
 * Rows read per product table for EACH side window (the anomaly window
 * just before the range and just after it). These rows only serve as
 * benchmark peers, so a small cap is enough — 300 fills in three days is
 * a hundred a day — and it keeps the whole query inside the per-call
 * read budget even when the main range and the prior period are both
 * at MAX_RANGE_ROWS.
 */
const SIDE_WINDOW_ROWS = 300;

/**
 * Rows read per product table for the PRIOR period in reportSummary. The
 * prior period only feeds the KPI deltas, so it gets a smaller cap, and
 * it is price-assessed (with the same side windows as the current
 * range, so both periods share one set of exception semantics) only
 * when the exception chip includes "price". Worst-case document reads
 * for one reportSummary call:
 *
 *   range              2 tables × (MAX_RANGE_ROWS + 1)      6,002
 *   side windows       2 sides × 2 tables × (300 + 1)       1,204
 *   prior              2 tables × (PRIOR_RANGE_ROWS + 1)    4,002
 *   prior side windows (price chip only)                    1,204
 *   vendor lookups                                          tens
 *                                                          ------
 *                                                         ~12,500
 *
 * comfortably inside Convex's per-query document budget.
 */
const PRIOR_RANGE_ROWS = 2000;

/**
 * Load the report range, assess every in-range fill against its peers,
 * and hand back the in-range rows with their assessments.
 *
 * Peers come from the range itself plus the anomaly window on each
 * side, so fills at the range edges still have neighbours. The side
 * windows are read SEPARATELY, each under its own small cap: reading
 * one widened span newest-first would let the after-window's rows
 * consume the main cap and push requested in-range rows out. Each side
 * window is read from the end NEAREST the range — newest-first before
 * it, oldest-first after it — so when a window overflows its cap the
 * rows kept are the closest peers, not the farthest.
 *
 * The pool is never filtered — benchmarks must mean the same thing
 * whatever chips are active.
 */
async function loadAssessedRange(
  ctx: QueryCtx,
  organizationId: string,
  dateRangeStart: number,
  dateRangeEnd: number,
  cap: number = MAX_RANGE_ROWS,
) {
  const [main, before, after] = await Promise.all([
    loadRangeRows(ctx, organizationId, dateRangeStart, dateRangeEnd, cap),
    loadRangeRows(
      ctx, organizationId, dateRangeStart - ANOMALY_WINDOW_MS, dateRangeStart - 1, SIDE_WINDOW_ROWS,
    ),
    loadRangeRows(
      ctx, organizationId, dateRangeEnd + 1, dateRangeEnd + ANOMALY_WINDOW_MS, SIDE_WINDOW_ROWS, 'asc',
    ),
  ]);
  const pool = [...main.rows, ...before.rows, ...after.rows];
  const assess = assessPrices(
    pool.map(({ entry, product }) => ({
      id: entry._id as string,
      product,
      entryDate: entry.entryDate,
      pricePerGallon: entry.pricePerGallon,
      gallons: entry.gallons,
      totalCost: entry.totalCost,
      state: entry.location?.state,
    })),
  );
  return {
    rows: main.rows,
    assess,
    truncated: main.truncated,
    /**
     * A side window overflowed its cap. The nearest SIDE_WINDOW_ROWS
     * fills per table are still there, and in-range fills still supply
     * peers, so benchmarks stay in the right neighbourhood — but a fill
     * close to the range edge may be judged by a coarser tier (fleet
     * instead of same state) than it would with every neighbour loaded.
     */
    peersCapped: before.truncated || after.truncated,
  };
}

function sumRows(rows: RangeRow[]) {
  let spend = 0, gallons = 0, fuelGallons = 0;
  for (const { entry, product } of rows) {
    spend += entry.totalCost;
    gallons += entry.gallons;
    if (product !== 'DEF') fuelGallons += entry.gallons;
  }
  return { spend, gallons, entries: rows.length, fuelGallons };
}

/**
 * Everything the reports overview needs, aggregated server-side under
 * the active filter chips: range totals, prior-period totals for the
 * KPI deltas, chart buckets split by fuel product, fuel type share,
 * vendor share and exception counts.
 *
 * Buckets are defined by the CALLER. The client already enumerates every
 * week / month in the range (so empty periods still draw as zero bars)
 * and it does so in the user's local time zone, which the server cannot
 * know. So it sends the bucket start instants and the server assigns
 * each row to the last bucket that starts on or before its entryDate.
 * Rows before the first bucket are dropped — the client anchors the
 * first bucket at or before the range start, so that never happens in
 * practice.
 *
 * This replaces client-side bucketing over every raw row. The payload is
 * now a few dozen buckets and a short list per share card, regardless of
 * how many entries the range holds.
 */
export const reportSummary = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
    /** Ascending bucket start instants (epoch ms). */
    bucketStarts: v.array(v.number()),
    /** Prior period for KPI deltas, filtered the same way. */
    priorStart: v.optional(v.number()),
    priorEnd: v.optional(v.number()),
    ...reportFilterArgs,
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);

    const hasPrior = args.priorStart !== undefined && args.priorEnd !== undefined;
    const range = await loadAssessedRange(ctx, args.organizationId, args.dateRangeStart, args.dateRangeEnd);
    const rows = applyReportFilters(range.rows, args, range.assess);

    // Prior period for the KPI deltas, filtered by the same chips. It is
    // read under a smaller cap (see PRIOR_RANGE_ROWS). When the Exception
    // chip includes "price" it goes through loadAssessedRange like the
    // current range — same side windows, same benchmark semantics — so
    // both periods flag the same way; otherwise the assessment is never
    // consulted and the plain read is enough. Skipped when the main range
    // is truncated (a delta against a partial period is meaningless), and
    // dropped when the prior window itself overflows its cap.
    let prior: ReturnType<typeof sumRows> | null = null;
    if (hasPrior && !range.truncated) {
      const needsPrice = args.exceptions?.includes('price') ?? false;
      const p = needsPrice
        ? await loadAssessedRange(
            ctx, args.organizationId, args.priorStart!, args.priorEnd!, PRIOR_RANGE_ROWS,
          )
        : { ...(await loadRangeRows(
            ctx, args.organizationId, args.priorStart!, args.priorEnd!, PRIOR_RANGE_ROWS,
          )), assess: undefined };
      if (!p.truncated) prior = sumRows(applyReportFilters(p.rows, args, p.assess));
    }

    // ── Buckets ──
    const starts = [...args.bucketStarts].sort((a, b) => a - b);
    const buckets = starts.map((start) => ({
      start,
      spend: 0,
      gallons: 0,
      entries: 0,
      spendByType: {} as Partial<Record<FuelProduct, number>>,
      gallonsByType: {} as Partial<Record<FuelProduct, number>>,
    }));
    const bucketIndex = (t: number): number => {
      // Last start <= t, by binary search.
      let lo = 0, hi = starts.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    };

    // ── Shares + exceptions accumulate in the same pass ──
    const byType = new Map<FuelProduct, { gallons: number; totalCost: number; entries: number }>();
    const byVendor = new Map<string, { gallons: number; totalCost: number; entries: number }>();

    for (const { entry, product } of rows) {
      const i = bucketIndex(entry.entryDate);
      if (i >= 0) {
        const b = buckets[i];
        b.spend += entry.totalCost;
        b.gallons += entry.gallons;
        b.entries += 1;
        b.spendByType[product] = (b.spendByType[product] ?? 0) + entry.totalCost;
        b.gallonsByType[product] = (b.gallonsByType[product] ?? 0) + entry.gallons;
      }
      const t = byType.get(product) ?? { gallons: 0, totalCost: 0, entries: 0 };
      t.gallons += entry.gallons; t.totalCost += entry.totalCost; t.entries += 1;
      byType.set(product, t);
      const vKey = entry.vendorId as string;
      const vAgg = byVendor.get(vKey) ?? { gallons: 0, totalCost: 0, entries: 0 };
      vAgg.gallons += entry.gallons; vAgg.totalCost += entry.totalCost; vAgg.entries += 1;
      byVendor.set(vKey, vAgg);
    }

    // Exceptions are counted over the rows IN SCOPE, but the price
    // benchmark behind `price` came from the unfiltered pool (see
    // loadAssessedRange), so a flag means the same thing at every filter.
    // priceTiers says which peer set judged each flagged fill — the
    // instrumentation for deciding whether an external benchmark is worth
    // adding.
    const exceptions = { receipt: 0, offcard: 0, price: 0, unlink: 0, mismatch: 0, total: 0 };
    const priceTiers: Record<PriceTier, number> = { state: 0, fleet: 0, range: 0, none: 0 };
    for (const row of rows) {
      const a = range.assess.get(row.entry._id as string);
      for (const id of exceptionsFor(row, a)) exceptions[id]++;
      if (a?.flagged) priceTiers[a.tier]++;
    }
    exceptions.total =
      exceptions.receipt + exceptions.offcard + exceptions.price + exceptions.unlink + exceptions.mismatch;

    const vendorDocs = await Promise.all(
      [...byVendor.keys()].map((id) => ctx.db.get(id as Id<'fuelVendors'>)),
    );
    const vendorName = new Map<string, string>();
    for (const doc of vendorDocs) if (doc) vendorName.set(doc._id, doc.name);

    return {
      totals: sumRows(rows),
      prior,
      /** The range exceeded MAX_RANGE_ROWS; figures cover the newest rows only. */
      truncated: range.truncated,
      /** Benchmark peers near the range edges were capped; see loadAssessedRange. */
      peersCapped: range.peersCapped,
      priceTiers,
      priceRule: {
        windowDays: PRICE_ANOMALY.windowDays,
        minPeers: PRICE_ANOMALY.minPeers,
        pct: PRICE_ANOMALY.pct,
        floor: PRICE_ANOMALY.floor,
      },
      buckets,
      byType: [...byType.entries()]
        .map(([fuelType, d]) => ({
          fuelType,
          gallons: d.gallons,
          totalCost: d.totalCost,
          avgPricePerGallon: d.gallons > 0 ? d.totalCost / d.gallons : 0,
          entries: d.entries,
        }))
        .sort((a, b) => b.totalCost - a.totalCost),
      byVendor: [...byVendor.entries()]
        .map(([vendorId, d]) => ({
          vendorId,
          vendorName: vendorName.get(vendorId) ?? 'Unknown',
          gallons: d.gallons,
          totalCost: d.totalCost,
          avgPricePerGallon: d.gallons > 0 ? d.totalCost / d.gallons : 0,
          entries: d.entries,
        }))
        .sort((a, b) => b.totalCost - a.totalCost),
      exceptions,
    };
  },
});

// ─── Row projection ───────────────────────────────────────────────────
// Both row feeds (the paginated purchases table and the CSV export)
// return the same lean shape. Lookups are resolved once per distinct id
// across the rows handed in, never once per row.

async function resolveRowNames(ctx: QueryCtx, rows: RangeRow[]) {
  const vendorIds = new Set<Id<'fuelVendors'>>();
  const driverIds = new Set<Id<'drivers'>>();
  const carrierIds = new Set<Id<'carrierPartnerships'>>();
  const truckIds = new Set<Id<'trucks'>>();
  const loadIds = new Set<Id<'loadInformation'>>();
  for (const { entry } of rows) {
    vendorIds.add(entry.vendorId);
    if (entry.driverId) driverIds.add(entry.driverId);
    if (entry.carrierId) carrierIds.add(entry.carrierId);
    if (entry.truckId) truckIds.add(entry.truckId);
    if (entry.loadId) loadIds.add(entry.loadId);
  }
  const [vendors, drivers, carriers, trucks, loads] = await Promise.all([
    Promise.all([...vendorIds].map((id) => ctx.db.get(id))),
    Promise.all([...driverIds].map((id) => ctx.db.get(id))),
    Promise.all([...carrierIds].map((id) => ctx.db.get(id))),
    Promise.all([...truckIds].map((id) => ctx.db.get(id))),
    Promise.all([...loadIds].map((id) => ctx.db.get(id))),
  ]);
  const names = {
    vendor: new Map<string, string>(),
    driver: new Map<string, string>(),
    carrier: new Map<string, string>(),
    truck: new Map<string, string>(),
    load: new Map<string, string | undefined>(),
  };
  for (const v of vendors) if (v) names.vendor.set(v._id, v.name);
  for (const d of drivers) if (d) names.driver.set(d._id, `${d.firstName} ${d.lastName}`);
  for (const c of carriers) if (c) names.carrier.set(c._id, c.carrierName);
  for (const t of trucks) if (t) names.truck.set(t._id, t.unitId);
  for (const l of loads) if (l) names.load.set(l._id, loadReferenceOf(l));
  return names;
}

type RowNames = Awaited<ReturnType<typeof resolveRowNames>>;

function projectRow(row: RangeRow, names: RowNames, price: PriceAssessment | undefined) {
  const { entry, type, product } = row;
  return {
    _id: entry._id as string,
    type,
    entryDate: entry.entryDate,
    fuelType: product,
    vendorId: entry.vendorId as string,
    vendorName: names.vendor.get(entry.vendorId) ?? 'Unknown',
    driverId: entry.driverId as string | undefined,
    driverName: entry.driverId ? names.driver.get(entry.driverId) : undefined,
    carrierId: entry.carrierId as string | undefined,
    carrierName: entry.carrierId ? names.carrier.get(entry.carrierId) : undefined,
    truckId: entry.truckId as string | undefined,
    truckUnitId: entry.truckId ? names.truck.get(entry.truckId) : undefined,
    loadId: entry.loadId as string | undefined,
    loadReference: entry.loadId ? names.load.get(entry.loadId) : undefined,
    gallons: entry.gallons,
    pricePerGallon: entry.pricePerGallon,
    totalCost: entry.totalCost,
    location: entry.location,
    paymentMethod: entry.paymentMethod,
    fuelCardNumber: entry.fuelCardNumber,
    hasReceipt: entry.receiptStorageId !== undefined,
    /** Peer benchmark this fill was judged against (null: no peers). */
    priceBenchmark: price?.benchmark ?? null,
    priceDelta: price?.delta ?? 0,
    pricePct: price?.pct ?? 0,
    priceTier: (price?.tier ?? 'none') as PriceTier,
    pricePeers: price?.peers ?? 0,
    /** Every exception rule this row trips. */
    exceptions: exceptionsFor(row, price),
  };
}

/**
 * Every fuel + DEF entry in the range under the active chips, projected
 * down to the fields the reports page needs. No pagination — this is the
 * CSV export source, fetched once on click, not a live subscription.
 * Rows are sorted newest first; `truncated` says the range exceeded
 * MAX_RANGE_ROWS and only the newest rows are included.
 */
export const reportEntries = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
    ...reportFilterArgs,
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const range = await loadAssessedRange(ctx, args.organizationId, args.dateRangeStart, args.dateRangeEnd);
    const rows = applyReportFilters(range.rows, args, range.assess);
    const names = await resolveRowNames(ctx, rows);
    return {
      rows: rows
        .map((r) => projectRow(r, names, range.assess.get(r.entry._id as string)))
        .sort((a, b) => b.entryDate - a.entryDate),
      truncated: range.truncated,
    };
  },
});

export const purchaseSortKeyValidator = v.union(
  v.literal('date'),
  v.literal('vendor'),
  v.literal('type'),
  v.literal('driver'),
  v.literal('gallons'),
  v.literal('ppg'),
  v.literal('total'),
  v.literal('payment'),
);
export type PurchaseSortKey = typeof purchaseSortKeyValidator.type;

/**
 * The Fuel purchases table: one page of rows under the active chips,
 * sorted server-side by any column.
 *
 * The pool is fuel + DEF merged and sortable by vendor or driver NAME,
 * so no index can serve the order directly. The query sorts the filtered
 * range in memory and pages by offset, the same cursor scheme
 * `fuelEntries.listCombined` uses. Only vendor and driver names are
 * resolved for the whole pool (they are sort keys); trucks and loads are
 * resolved for the page alone.
 *
 * Ties break newest first so equal keys keep a stable, useful order
 * across pages.
 */
export const reportPurchases = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
    ...reportFilterArgs,
    sortKey: purchaseSortKeyValidator,
    sortDir: v.union(v.literal('asc'), v.literal('desc')),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const range = await loadAssessedRange(ctx, args.organizationId, args.dateRangeStart, args.dateRangeEnd);
    const rows = applyReportFilters(range.rows, args, range.assess);

    // Names needed to sort. Cheap: one get per distinct vendor / driver.
    const vendorIds = new Set(rows.map((r) => r.entry.vendorId));
    const driverIds = new Set(rows.flatMap((r) => (r.entry.driverId ? [r.entry.driverId] : [])));
    const [vendors, drivers] = await Promise.all([
      Promise.all([...vendorIds].map((id) => ctx.db.get(id))),
      Promise.all([...driverIds].map((id) => ctx.db.get(id))),
    ]);
    const vendorName = new Map<string, string>();
    for (const doc of vendors) if (doc) vendorName.set(doc._id, doc.name);
    const driverName = new Map<string, string>();
    for (const doc of drivers) if (doc) driverName.set(doc._id, `${doc.firstName} ${doc.lastName}`);

    const dir = args.sortDir === 'asc' ? 1 : -1;
    const cmp = (a: RangeRow, b: RangeRow): number => {
      switch (args.sortKey) {
        case 'date':    return a.entry.entryDate - b.entry.entryDate;
        case 'vendor':  return (vendorName.get(a.entry.vendorId) ?? '').localeCompare(vendorName.get(b.entry.vendorId) ?? '');
        // Canonical product order (Diesel, DEF, …) rather than
        // alphabetical, so the grouping matches the rest of the page.
        case 'type':    return FUEL_PRODUCT_ORDER.indexOf(a.product) - FUEL_PRODUCT_ORDER.indexOf(b.product);
        case 'driver':  return (a.entry.driverId ? driverName.get(a.entry.driverId) ?? '' : '').localeCompare(b.entry.driverId ? driverName.get(b.entry.driverId) ?? '' : '');
        case 'gallons': return a.entry.gallons - b.entry.gallons;
        case 'ppg':     return a.entry.pricePerGallon - b.entry.pricePerGallon;
        case 'total':   return a.entry.totalCost - b.entry.totalCost;
        case 'payment': return (a.entry.paymentMethod ?? '').localeCompare(b.entry.paymentMethod ?? '');
      }
    };
    rows.sort((a, b) => {
      const c = cmp(a, b);
      return c !== 0 ? dir * c : b.entry.entryDate - a.entry.entryDate;
    });

    const offset = args.paginationOpts.cursor ? Number(args.paginationOpts.cursor) : 0;
    const pageRows = rows.slice(offset, offset + args.paginationOpts.numItems);
    const nextOffset = offset + pageRows.length;
    const names = await resolveRowNames(ctx, pageRows);

    return {
      page: pageRows.map((r) => projectRow(r, names, range.assess.get(r.entry._id as string))),
      isDone: nextOffset >= rows.length,
      continueCursor: nextOffset >= rows.length ? '' : String(nextOffset),
      splitCursor: null,
      pageStatus: null,
    };
  },
});
