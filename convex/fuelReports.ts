import { v } from 'convex/values';
import { query } from './_generated/server';
import { Id } from './_generated/dataModel';
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
