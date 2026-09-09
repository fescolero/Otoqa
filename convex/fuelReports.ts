import { v } from 'convex/values';
import { query, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { loadReferenceOf } from './lib/loadReference';
import { assertCallerOwnsOrg } from './lib/auth';
import { DEFAULT_FUEL_TYPE, type FuelProduct } from './lib/fuelTypes';

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

async function loadRangeRows(
  ctx: QueryCtx,
  organizationId: string,
  dateRangeStart: number,
  dateRangeEnd: number,
): Promise<RangeRow[]> {
  const [fuelEntries, defEntriesList] = await Promise.all([
    ctx.db
      .query('fuelEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', organizationId)
          .gte('entryDate', dateRangeStart)
          .lte('entryDate', dateRangeEnd)
      )
      .collect(),
    ctx.db
      .query('defEntries')
      .withIndex('by_organization_and_date', (q) =>
        q.eq('organizationId', organizationId)
          .gte('entryDate', dateRangeStart)
          .lte('entryDate', dateRangeEnd)
      )
      .collect(),
  ]);
  return [
    ...fuelEntries.map((entry) => ({
      entry,
      type: 'fuel' as const,
      product: (entry.fuelType ?? DEFAULT_FUEL_TYPE) as FuelProduct,
    })),
    ...defEntriesList.map((entry) => ({
      entry,
      type: 'def' as const,
      product: 'DEF' as FuelProduct,
    })),
  ];
}

/** Filter-chip args shared by the report queries. Each list is `is any of`. */
const reportFilterArgs = {
  driverIds: v.optional(v.array(v.string())),
  carrierIds: v.optional(v.array(v.string())),
  truckIds: v.optional(v.array(v.string())),
  vendorIds: v.optional(v.array(v.string())),
  fuelTypes: v.optional(v.array(v.string())),
};

type ReportFilters = {
  driverIds?: string[];
  carrierIds?: string[];
  truckIds?: string[];
  vendorIds?: string[];
  fuelTypes?: string[];
};

/**
 * Narrow the pool to rows matching every active chip. A chip on an
 * optional relation (driver / carrier / truck) excludes rows that have
 * no value — "Driver is any of X" should not show unassigned fills.
 */
function applyReportFilters(rows: RangeRow[], f: ReportFilters): RangeRow[] {
  const driver = f.driverIds?.length ? new Set(f.driverIds) : null;
  const carrier = f.carrierIds?.length ? new Set(f.carrierIds) : null;
  const truck = f.truckIds?.length ? new Set(f.truckIds) : null;
  const vendor = f.vendorIds?.length ? new Set(f.vendorIds) : null;
  const product = f.fuelTypes?.length ? new Set(f.fuelTypes) : null;
  if (!driver && !carrier && !truck && !vendor && !product) return rows;
  return rows.filter(({ entry, product: p }) => {
    if (driver && (!entry.driverId || !driver.has(entry.driverId))) return false;
    if (carrier && (!entry.carrierId || !carrier.has(entry.carrierId))) return false;
    if (truck && (!entry.truckId || !truck.has(entry.truckId))) return false;
    if (vendor && !vendor.has(entry.vendorId)) return false;
    if (product && !product.has(p)) return false;
    return true;
  });
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
    const [rangeRows, priorRows] = await Promise.all([
      loadRangeRows(ctx, args.organizationId, args.dateRangeStart, args.dateRangeEnd),
      hasPrior
        ? loadRangeRows(ctx, args.organizationId, args.priorStart!, args.priorEnd!)
        : Promise.resolve([] as RangeRow[]),
    ]);
    const rows = applyReportFilters(rangeRows, args);
    const prior = hasPrior ? sumRows(applyReportFilters(priorRows, args)) : null;

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

    // Price anomalies compare within the SAME product — DEF runs a
    // different price band than diesel, so a blended average would flag
    // normal entries as soon as multiple products are in scope.
    const avgByType = new Map<FuelProduct, number>();
    for (const [t, agg] of byType) {
      avgByType.set(t, agg.gallons > 0 ? agg.totalCost / agg.gallons : 0);
    }
    const exceptions = { receipt: 0, offcard: 0, price: 0, unlink: 0, total: 0 };
    for (const { entry, product } of rows) {
      if (!entry.receiptStorageId) exceptions.receipt++;
      if (entry.paymentMethod && entry.paymentMethod !== 'FUEL_CARD') exceptions.offcard++;
      const typeAvg = avgByType.get(product) ?? 0;
      if (typeAvg > 0 && entry.pricePerGallon > typeAvg + 0.2) exceptions.price++;
      if (!entry.loadId) exceptions.unlink++;
    }
    exceptions.total =
      exceptions.receipt + exceptions.offcard + exceptions.price + exceptions.unlink;

    const vendorDocs = await Promise.all(
      [...byVendor.keys()].map((id) => ctx.db.get(id as Id<'fuelVendors'>)),
    );
    const vendorName = new Map<string, string>();
    for (const doc of vendorDocs) if (doc) vendorName.set(doc._id, doc.name);

    return {
      totals: sumRows(rows),
      prior,
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

/**
 * Every fuel + DEF entry in the range, projected down to the fields the
 * reports page needs — no pagination, no per-row lookups.
 *
 * The reports page used to pull its raw rows from `fuelEntries.listCombined`
 * with a single 500-row page. The chart, exception counts, vendor / fuel
 * type shares and the purchases table were all fed from that page, so any
 * range holding more than 500 entries was silently truncated: the newest
 * 500 rows made it in, everything older fell off the left edge of the
 * chart, and applying a filter chip narrowed the truncated pool rather
 * than the real one.
 *
 * This query returns the whole range instead. It stays cheap because:
 *   - lookups (vendor / driver / carrier / truck / load) are fetched once
 *     per distinct id, not once per row;
 *   - no storage URLs are resolved — the page only needs to know whether a
 *     receipt is on file;
 *   - only the columns the page reads are returned.
 *
 * Rows are sorted newest first, matching `listCombined`.
 */
export const reportEntries = query({
  args: {
    organizationId: v.string(),
    dateRangeStart: v.number(),
    dateRangeEnd: v.number(),
  },
  handler: async (ctx, args) => {
    await assertCallerOwnsOrg(ctx, args.organizationId);
    const all = await loadRangeRows(ctx, args.organizationId, args.dateRangeStart, args.dateRangeEnd);

    // One lookup per distinct id across the whole range.
    const vendorIds = new Set<Id<'fuelVendors'>>();
    const driverIds = new Set<Id<'drivers'>>();
    const carrierIds = new Set<Id<'carrierPartnerships'>>();
    const truckIds = new Set<Id<'trucks'>>();
    const loadIds = new Set<Id<'loadInformation'>>();
    for (const { entry } of all) {
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

    const vendorName = new Map<string, string>();
    for (const v of vendors) if (v) vendorName.set(v._id, v.name);
    const driverName = new Map<string, string>();
    for (const d of drivers) if (d) driverName.set(d._id, `${d.firstName} ${d.lastName}`);
    const carrierName = new Map<string, string>();
    for (const c of carriers) if (c) carrierName.set(c._id, c.carrierName);
    const truckUnit = new Map<string, string>();
    for (const t of trucks) if (t) truckUnit.set(t._id, t.unitId);
    const loadRef = new Map<string, string | undefined>();
    for (const l of loads) if (l) loadRef.set(l._id, loadReferenceOf(l));

    return all
      .map(({ entry, type, product }) => ({
        _id: entry._id as string,
        type,
        entryDate: entry.entryDate,
        fuelType: product,
        vendorId: entry.vendorId as string,
        vendorName: vendorName.get(entry.vendorId) ?? 'Unknown',
        driverId: entry.driverId as string | undefined,
        driverName: entry.driverId ? driverName.get(entry.driverId) : undefined,
        carrierId: entry.carrierId as string | undefined,
        carrierName: entry.carrierId ? carrierName.get(entry.carrierId) : undefined,
        truckId: entry.truckId as string | undefined,
        truckUnitId: entry.truckId ? truckUnit.get(entry.truckId) : undefined,
        loadId: entry.loadId as string | undefined,
        loadReference: entry.loadId ? loadRef.get(entry.loadId) : undefined,
        gallons: entry.gallons,
        pricePerGallon: entry.pricePerGallon,
        totalCost: entry.totalCost,
        location: entry.location,
        paymentMethod: entry.paymentMethod,
        fuelCardNumber: entry.fuelCardNumber,
        hasReceipt: entry.receiptStorageId !== undefined,
      }))
      .sort((a, b) => b.entryDate - a.entryDate);
  },
});
