/**
 * FuelReportsClient — Otoqa Web chassis for the Fuel Reports analytics
 * surface. Mirrors fuel-reports-screen.jsx (v6 design):
 *
 *   SavedViews (Overview · IFTA · By vehicle)
 *   Control strip: time-range select + FilterBar (Fuel type / Driver /
 *   Carrier / Truck / Vendor)
 *   Scrollable canvas:
 *     Overview  — 4 KPI cards (+ sparklines), spend/price combo chart,
 *                 exceptions card, fuel-type share, vendor share,
 *                 IFTA snapshot
 *     IFTA      — hero strip + jurisdiction reconciliation table
 *     By vehicle — KPIs + fuel-economy table
 *
 * Real data: api.fuelReports.monthlySummary / fuelByVendor / fuelByDriver /
 * fuelByTruck / costPerMile, plus driver / truck / carrier / vendor lookups
 * for the FilterBar options. IFTA jurisdiction data + exception classifiers
 * land as a follow-up — those views show banner notes when no real source
 * exists yet.
 */

'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';

import {
  Avatar,
  DSCard,
  FilterBar,
  type FilterChipValue,
  type FilterProperty,
  SavedViews,
  type SavedView,
  WBtn,
  WIcon,
} from '@/components/web';
import { api } from '@/convex/_generated/api';
import {
  DEFAULT_FUEL_TYPE,
  FUEL_PRODUCT_ORDER,
  fuelProductLabel,
  type FuelProduct,
} from '@/convex/lib/fuelTypes';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useOrganizationId } from '@/contexts/organization-context';
import { exportToCSV } from '@/lib/csv-export';

const FLEET_MPG = 6.4;

// Fixed per-product series colors — color follows the entity, so a
// filter that changes which products appear never repaints survivors.
// The set was validated (CVD separation, normal-vision floor, ≥3:1
// contrast) against both app surfaces (#FFFFFF / #12151C) in the
// FUEL_PRODUCT_ORDER stacking order.
const FUEL_PRODUCT_COLORS: Record<FuelProduct, string> = {
  DIESEL: 'var(--accent)', // #2E5CFF in both themes
  DEF: '#008300',
  DYED_DIESEL: '#d55181',
  BIODIESEL: '#c98500',
  GASOLINE: '#199e70',
  OTHER: '#9085e9',
};

// The $/gal overlay is a reference line, not a series — muted ink keeps
// it from competing (or colliding) with the per-product bar hues.
const PRICE_LINE_COLOR = '#898781';

interface RangeOption {
  id: string;
  label: string;
  sub: string;
  start: Date;
  end: Date;
  granularity: 'week' | 'month';
}

// ─── Date-range helpers ────────────────────────────────────────────────
function startOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d: Date) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
}
function startOfQuarter(d: Date) {
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1);
}
function endOfQuarter(d: Date) {
  const startMonth = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), startMonth + 3, 0, 23, 59, 59, 999);
}
function startOfYear(d: Date) {
  return new Date(d.getFullYear(), 0, 1);
}
function endOfYear(d: Date) {
  return new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999);
}
function fmtShort(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Each preset comes with the matching *prior* period so we can deliver
// vs-prior-period deltas on the KPI cards without a separate config.
function buildRanges(now: Date): Array<RangeOption & { priorStart: Date; priorEnd: Date }> {
  const thisMonth = startOfMonth(now);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = endOfMonth(lastMonthStart);
  const monthBefore = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const qStart = startOfQuarter(now);
  const qEnd = endOfQuarter(now);
  const prevQStart = new Date(qStart.getFullYear(), qStart.getMonth() - 3, 1);
  const prevQEnd = endOfQuarter(prevQStart);
  const yStart = startOfYear(now);
  const yEnd = endOfYear(now);
  const prevYStart = new Date(now.getFullYear() - 1, 0, 1);
  const prevYEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);

  return [
    {
      id: 'this-month',
      label: 'This month',
      sub: `${fmtShort(thisMonth)} – ${fmtShort(endOfMonth(now))}, ${now.getFullYear()}`,
      start: thisMonth,
      end: endOfMonth(now),
      granularity: 'week',
      priorStart: lastMonthStart,
      priorEnd: lastMonthEnd,
    },
    {
      id: 'last-month',
      label: 'Last month',
      sub: `${fmtShort(lastMonthStart)} – ${fmtShort(lastMonthEnd)}, ${lastMonthStart.getFullYear()}`,
      start: lastMonthStart,
      end: lastMonthEnd,
      granularity: 'week',
      priorStart: monthBefore,
      priorEnd: endOfMonth(monthBefore),
    },
    {
      id: 'this-quarter',
      label: 'This quarter',
      sub: `${fmtShort(qStart)} – ${fmtShort(qEnd)}, ${now.getFullYear()} · Q${Math.floor(now.getMonth() / 3) + 1}`,
      start: qStart,
      end: qEnd,
      granularity: 'week',
      priorStart: prevQStart,
      priorEnd: prevQEnd,
    },
    {
      id: 'ytd',
      label: 'Year to date',
      sub: `Jan 1 – ${fmtShort(yEnd)}, ${now.getFullYear()}`,
      start: yStart,
      end: yEnd,
      granularity: 'month',
      priorStart: prevYStart,
      priorEnd: prevYEnd,
    },
  ];
}

// ─── Number formatters ─────────────────────────────────────────────────
const frN = (n: number) => Math.round(n).toLocaleString();
const frMoney = (n: number) =>
  (n < 0 ? '−$' : '$') + Math.abs(Math.round(n)).toLocaleString();
const frMoney2 = (n: number) => `$${n.toFixed(2)}`;

// ─── Component ─────────────────────────────────────────────────────────
export function FuelReportsClient() {
  const router = useRouter();
  const organizationId = useOrganizationId();
  const [view, setView] = React.useState<'overview' | 'ifta' | 'vehicle'>('overview');
  const [rangeId, setRangeId] = React.useState('this-quarter');
  const [filters, setFilters] = React.useState<FilterChipValue[]>([]);

  // Frozen "now" so the range bounds don't drift mid-session.
  const now = React.useMemo(() => new Date(), []);
  const ranges = React.useMemo(() => buildRanges(now), [now]);
  const range = ranges.find((r) => r.id === rangeId) ?? ranges[2];

  // Query args. Range bounds → epoch ms.
  const baseArgs = organizationId
    ? {
        organizationId,
        dateRangeStart: range.start.getTime(),
        dateRangeEnd: range.end.getTime(),
      }
    : ('skip' as const);

  const summary = useAuthQuery(api.fuelReports.monthlySummary, baseArgs);
  const byVendor = useAuthQuery(api.fuelReports.fuelByVendor, baseArgs);
  const byFuelType = useAuthQuery(api.fuelReports.fuelByType, baseArgs);
  const byDriver = useAuthQuery(api.fuelReports.fuelByDriver, baseArgs);
  const byTruck = useAuthQuery(api.fuelReports.fuelByTruck, baseArgs);
  const cpm = useAuthQuery(api.fuelReports.costPerMile, baseArgs);

  // Prior-period totals power the "vs prior period" deltas on KPI cards.
  const priorArgs = organizationId
    ? {
        organizationId,
        dateRangeStart: range.priorStart.getTime(),
        dateRangeEnd: range.priorEnd.getTime(),
      }
    : ('skip' as const);
  const priorSummary = useAuthQuery(api.fuelReports.monthlySummary, priorArgs);

  // Individual entries drive: weekly chart bars, exception counts, the
  // Fuel purchases table. The summary query gives us monthly aggregates
  // only — for weekly granularity + per-entry exception classification we
  // need the raw rows. listCombined merges fuelEntries + defEntries and
  // tags each row with its source table. Capped at 500; if the range
  // exceeds that we still get correct totals from the summary query
  // above, and the per-entry surfaces show "showing 500 of N".
  const entriesPage = useAuthQuery(
    api.fuelEntries.listCombined,
    organizationId
      ? ({
          organizationId,
          dateRangeStart: range.start.getTime(),
          dateRangeEnd: range.end.getTime(),
          paginationOpts: { numItems: 500, cursor: null },
        } as never)
      : 'skip',
  );
  const rawEntries = React.useMemo(() => {
    if (!entriesPage) return [];
    return ((entriesPage as { page: Array<Record<string, unknown>> }).page ?? []).map((e) => {
      const entryType = ((e.type as string) ?? 'fuel') as 'fuel' | 'def';
      return {
      _id: e._id as string,
      entryDate: e.entryDate as number,
      // DEF rows come from their own table (no fuelType column) — the
      // table IS the type. Fuel rows created before the fuelType field
      // existed count as diesel.
      type: entryType,
      fuelType: (entryType === 'def'
        ? 'DEF'
        : ((e.fuelType as string) ?? DEFAULT_FUEL_TYPE)) as FuelProduct,
      vendorId: e.vendorId as string,
      vendorName: (e.vendorName as string) ?? 'Unknown',
      driverName: e.driverName as string | undefined,
      driverId: e.driverId as string | undefined,
      // carrierId comes through from the raw entry record — used by the
      // carrier filter chip below.
      carrierId: e.carrierId as string | undefined,
      carrierName: e.carrierName as string | undefined,
      truckUnitId: e.truckUnitId as string | undefined,
      truckId: e.truckId as string | undefined,
      loadId: e.loadId as string | undefined,
      loadReference: e.loadReference as string | undefined,
      gallons: (e.gallons as number) ?? 0,
      pricePerGallon: (e.pricePerGallon as number) ?? 0,
      totalCost: (e.totalCost as number) ?? 0,
      location: e.location as { city: string; state: string } | undefined,
      paymentMethod: e.paymentMethod as string | undefined,
      fuelCardNumber: e.fuelCardNumber as string | undefined,
      receiptUrl: e.receiptUrl as string | undefined,
      receiptStorageId: e.receiptStorageId as string | undefined,
      };
    });
  }, [entriesPage]);

  // Lookup data for the FilterBar options.
  const driversList = useAuthQuery(
    api.drivers.list,
    organizationId ? { organizationId } : 'skip',
  );
  const trucksList = useAuthQuery(
    api.trucks.list,
    organizationId ? { organizationId } : 'skip',
  );
  const carriersList = useAuthQuery(
    api.carrierPartnerships.listForBroker,
    organizationId ? { brokerOrgId: organizationId } : 'skip',
  );
  const vendorsList = useAuthQuery(
    api.fuelVendors.list,
    organizationId ? { organizationId } : 'skip',
  );

  // FilterBar options.
  const filterProps: FilterProperty[] = React.useMemo(() => {
    return [
      {
        id: 'fuelType',
        label: 'Fuel type',
        icon: 'droplet',
        kind: 'enum',
        operator: 'is any of',
        options: FUEL_PRODUCT_ORDER.map((t) => ({
          value: t as string,
          label: fuelProductLabel(t),
        })),
      },
      {
        id: 'driver',
        label: 'Driver',
        icon: 'id-card',
        kind: 'enum',
        operator: 'is any of',
        options: (driversList ?? []).map((d) => ({
          value: d._id,
          label: `${d.firstName} ${d.lastName}`.trim(),
        })),
      },
      {
        id: 'carrier',
        label: 'Carrier',
        icon: 'handshake',
        kind: 'enum',
        operator: 'is any of',
        options: ((carriersList ?? []) as Array<Record<string, unknown>>).map((c) => ({
          value: c._id as string,
          label: ((c.carrierName as string) ?? 'Unknown') as string,
        })),
      },
      {
        id: 'truck',
        label: 'Truck',
        icon: 'truck',
        kind: 'enum',
        operator: 'is any of',
        options: ((trucksList ?? []) as Array<Record<string, unknown>>).map((t) => ({
          value: t._id as string,
          label: ((t.unitId as string) ?? '—') as string,
        })),
      },
      {
        id: 'vendor',
        label: 'Vendor',
        icon: 'fuel',
        kind: 'enum',
        operator: 'is any of',
        options: ((vendorsList ?? []) as Array<Record<string, unknown>>).map((v) => ({
          value: v._id as string,
          label: ((v.name as string) ?? 'Unknown') as string,
        })),
      },
    ];
  }, [driversList, trucksList, carriersList, vendorsList]);

  // ─── Apply filter chips client-side ───────────────────────────────────
  // The Convex queries above pull entries for the whole org in the chosen
  // date range. The Driver/Carrier/Truck/Vendor chips then narrow that
  // pool here so every downstream surface (KPIs, chart, exceptions,
  // vendor share, fuel purchases) reacts to a single set of filters.
  const driverIds = React.useMemo(() => {
    const chip = filters.find((c) => c.propId === 'driver');
    return new Set(chip?.values ?? []);
  }, [filters]);
  const carrierIds = React.useMemo(() => {
    const chip = filters.find((c) => c.propId === 'carrier');
    return new Set(chip?.values ?? []);
  }, [filters]);
  const truckIds = React.useMemo(() => {
    const chip = filters.find((c) => c.propId === 'truck');
    return new Set(chip?.values ?? []);
  }, [filters]);
  const vendorIds = React.useMemo(() => {
    const chip = filters.find((c) => c.propId === 'vendor');
    return new Set(chip?.values ?? []);
  }, [filters]);
  const fuelTypeIds = React.useMemo(() => {
    const chip = filters.find((c) => c.propId === 'fuelType');
    return new Set(chip?.values ?? []);
  }, [filters]);
  const anyChip =
    driverIds.size + carrierIds.size + truckIds.size + vendorIds.size + fuelTypeIds.size > 0;

  // Apply chip filters to the raw entry pool. Each chip operates as
  // `is any of` — match the entry if its id is in the selected set.
  // Vendor / driver / truck / carrier all match on the underlying _id
  // stored on the entry; the chips emit those ids directly.
  const filteredEntries = React.useMemo(() => {
    if (!anyChip) return rawEntries;
    return rawEntries.filter((e) => {
      if (driverIds.size > 0 && (!e.driverId || !driverIds.has(e.driverId))) return false;
      if (vendorIds.size > 0 && !vendorIds.has(e.vendorId)) return false;
      if (truckIds.size > 0 && (!e.truckId || !truckIds.has(e.truckId))) return false;
      if (carrierIds.size > 0 && (!e.carrierId || !carrierIds.has(e.carrierId))) return false;
      if (fuelTypeIds.size > 0 && !fuelTypeIds.has(e.fuelType)) return false;
      return true;
    });
  }, [rawEntries, anyChip, driverIds, vendorIds, truckIds, carrierIds, fuelTypeIds]);

  // ─── KPIs (Overview) ──────────────────────────────────────────────────
  // Headline totals cover EVERY product bought at the pump — fuel AND
  // DEF — so the unfiltered page equals the sum of all Fuel type filter
  // options. When no chips are active we trust the server-side
  // aggregates (they count every entry, not just the 500-row raw page).
  // When chips ARE active we recompute from the filtered raw entries so
  // the KPIs match the visible chart / table.
  const totals = summary?.totals;
  let totalSpend: number;
  let totalGallons: number;
  let totalEntries: number;
  if (anyChip) {
    totalSpend = filteredEntries.reduce((s, e) => s + (e.totalCost ?? 0), 0);
    totalGallons = filteredEntries.reduce((s, e) => s + (e.gallons ?? 0), 0);
    totalEntries = filteredEntries.length;
  } else {
    totalSpend = (totals?.totalFuelCost ?? 0) + (totals?.totalDefCost ?? 0);
    totalGallons = (totals?.totalFuelGallons ?? 0) + (totals?.totalDefGallons ?? 0);
    totalEntries = (totals?.totalFuelEntries ?? 0) + (totals?.totalDefEntries ?? 0);
  }
  // IFTA cares about road fuel only — DEF is an additive, never a
  // taxable gallon, so the IFTA surfaces get a DEF-free figure.
  const iftaGallons = anyChip
    ? filteredEntries.reduce((s, e) => (e.fuelType === 'DEF' ? s : s + (e.gallons ?? 0)), 0)
    : (totals?.totalFuelGallons ?? 0);

  // Prior-period totals → deltas. We can only compare apples-to-apples
  // when no filter is active (the prior summary is org-wide); skip
  // deltas under a filtered scope to avoid misleading numbers.
  const prior = priorSummary?.totals;
  const priorSpend = anyChip ? 0 : (prior?.totalFuelCost ?? 0) + (prior?.totalDefCost ?? 0);
  const priorGallons = anyChip ? 0 : (prior?.totalFuelGallons ?? 0) + (prior?.totalDefGallons ?? 0);
  const priorEntries = anyChip ? 0 : (prior?.totalFuelEntries ?? 0) + (prior?.totalDefEntries ?? 0);
  const spendDeltaPct = priorSpend > 0 ? ((totalSpend - priorSpend) / priorSpend) * 100 : 0;
  const gallonsDeltaPct = priorGallons > 0 ? ((totalGallons - priorGallons) / priorGallons) * 100 : 0;
  const entriesDeltaPct = priorEntries > 0 ? ((totalEntries - priorEntries) / priorEntries) * 100 : 0;

  // ─── Trend buckets ────────────────────────────────────────────────────
  // The chart enumerates EVERY bucket in the selected range up-front so
  // empty weeks/months still render as zero-height bars with their date
  // labels intact. Without this, a sparse month produced just 3-4 bars
  // sitting inside a wide empty card.
  const trendBuckets = React.useMemo(() => {
    type Bucket = {
      key: string;
      label: string;
      spend: number;
      byType: Partial<Record<FuelProduct, number>>;
      gallonsByType: Partial<Record<FuelProduct, number>>;
      entries: number;
    };

    // Step 1 — enumerate every bucket between range.start and range.end.
    const buckets = new Map<string, Bucket>();
    if (range.granularity === 'month') {
      const cur = new Date(range.start.getFullYear(), range.start.getMonth(), 1);
      while (cur <= range.end) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}`;
        const label = cur.toLocaleDateString('en-US', { month: 'short' });
        buckets.set(key, { key, label, spend: 0, byType: {}, gallonsByType: {}, entries: 0 });
        cur.setMonth(cur.getMonth() + 1);
      }
    } else {
      // Anchor to the Monday on/before range.start.
      const cur = new Date(range.start);
      cur.setHours(0, 0, 0, 0);
      const dow = cur.getDay();
      cur.setDate(cur.getDate() - ((dow + 6) % 7));
      while (cur <= range.end) {
        const key = `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, '0')}-${String(cur.getDate()).padStart(2, '0')}`;
        const label = cur.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        buckets.set(key, { key, label, spend: 0, byType: {}, gallonsByType: {}, entries: 0 });
        cur.setDate(cur.getDate() + 7);
      }
    }

    // Step 2 — drop each entry into its bucket, split by product so the
    // chart can stack spend by fuel type.
    for (const e of filteredEntries) {
      const d = new Date(e.entryDate);
      d.setHours(0, 0, 0, 0);
      let key: string;
      if (range.granularity === 'month') {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      } else {
        const dow = d.getDay();
        d.setDate(d.getDate() - ((dow + 6) % 7));
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      const cur = buckets.get(key);
      if (!cur) continue; // entry outside the enumerated range (shouldn't happen).
      cur.spend += e.totalCost;
      cur.byType[e.fuelType] = (cur.byType[e.fuelType] ?? 0) + e.totalCost;
      cur.gallonsByType[e.fuelType] = (cur.gallonsByType[e.fuelType] ?? 0) + e.gallons;
      cur.entries += 1;
    }

    // Step 3 — sort + project to chart shape. Per-product $/gal is
    // gallons-weighted (cost ÷ gallons), one value per product per
    // bucket; products absent from a bucket just have no point there.
    return [...buckets.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((b) => {
        const ppgByType: Partial<Record<FuelProduct, number>> = {};
        for (const [t, gal] of Object.entries(b.gallonsByType) as Array<[FuelProduct, number]>) {
          if (gal > 0) ppgByType[t] = (b.byType[t] ?? 0) / gal;
        }
        return {
          label: b.label,
          spend: b.spend,
          gallons: Object.values(b.gallonsByType).reduce((s, g) => s + (g ?? 0), 0),
          entries: b.entries,
          byType: b.byType,
          ppgByType,
        };
      });
  }, [filteredEntries, range.start, range.end, range.granularity]);

  // Exception classifier — counts per rule, computed from filtered entries.
  // Same rules as the design's <FrExceptions/>:
  //   1. receipt — no receiptUrl AND no receiptStorageId on file
  //   2. offcard — paymentMethod !== 'FUEL_CARD'
  //   3. price   — > $0.20/gal above the period's average
  //   4. unlink  — no loadId on the entry
  const exceptionCounts = React.useMemo(() => {
    if (filteredEntries.length === 0) {
      return { receipt: 0, offcard: 0, price: 0, unlink: 0, total: 0 };
    }
    // Price anomalies compare within the SAME product — DEF runs a
    // different price band than diesel, so a blended average would
    // flag normal entries as soon as multiple products are in scope.
    const typeAgg = new Map<FuelProduct, { cost: number; gallons: number }>();
    for (const e of filteredEntries) {
      const cur = typeAgg.get(e.fuelType) ?? { cost: 0, gallons: 0 };
      cur.cost += e.totalCost ?? 0;
      cur.gallons += e.gallons ?? 0;
      typeAgg.set(e.fuelType, cur);
    }
    const avgByType = new Map<FuelProduct, number>();
    for (const [t, agg] of typeAgg) {
      avgByType.set(t, agg.gallons > 0 ? agg.cost / agg.gallons : 0);
    }
    let receipt = 0, offcard = 0, price = 0, unlink = 0;
    for (const e of filteredEntries) {
      if (!e.receiptUrl && !e.receiptStorageId) receipt++;
      if (e.paymentMethod && e.paymentMethod !== 'FUEL_CARD') offcard++;
      const typeAvg = avgByType.get(e.fuelType) ?? 0;
      if (typeAvg > 0 && e.pricePerGallon > typeAvg + 0.20) price++;
      if (!e.loadId) unlink++;
    }
    return { receipt, offcard, price, unlink, total: receipt + offcard + price + unlink };
  }, [filteredEntries]);

  const filtersActive = filters.some((c) => c.values.length > 0);

  // Vendor share — when chips are active, recompute from filteredEntries so
  // the bars reflect the scoped pool. Otherwise use the server aggregate.
  const vendorShare = React.useMemo(() => {
    if (!anyChip) {
      return ((byVendor ?? []) as Array<{ vendorId: string; vendorName: string; gallons: number; totalCost: number; avgPricePerGallon: number; entries: number }>);
    }
    const m = new Map<string, { vendorId: string; vendorName: string; gallons: number; totalCost: number; ppgSum: number; entries: number }>();
    for (const e of filteredEntries) {
      const cur = m.get(e.vendorId) ?? {
        vendorId: e.vendorId,
        vendorName: e.vendorName,
        gallons: 0,
        totalCost: 0,
        ppgSum: 0,
        entries: 0,
      };
      cur.gallons += e.gallons;
      cur.totalCost += e.totalCost;
      cur.ppgSum += e.pricePerGallon;
      cur.entries += 1;
      m.set(e.vendorId, cur);
    }
    return [...m.values()]
      .map((v) => ({
        vendorId: v.vendorId,
        vendorName: v.vendorName,
        gallons: v.gallons,
        totalCost: v.totalCost,
        avgPricePerGallon: v.entries > 0 ? v.ppgSum / v.entries : 0,
        entries: v.entries,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);
  }, [anyChip, byVendor, filteredEntries]);

  // Fuel-type share — same server/client split as vendor share: trust the
  // org-wide aggregate when no chips are active, recompute from the
  // filtered pool when they are.
  const fuelTypeShare = React.useMemo(() => {
    if (!anyChip) {
      return ((byFuelType ?? []) as Array<{ fuelType: FuelProduct; gallons: number; totalCost: number; avgPricePerGallon: number; entries: number }>);
    }
    const m = new Map<FuelProduct, { fuelType: FuelProduct; gallons: number; totalCost: number; entries: number }>();
    for (const e of filteredEntries) {
      const cur = m.get(e.fuelType) ?? { fuelType: e.fuelType, gallons: 0, totalCost: 0, entries: 0 };
      cur.gallons += e.gallons;
      cur.totalCost += e.totalCost;
      cur.entries += 1;
      m.set(e.fuelType, cur);
    }
    return [...m.values()]
      .map((t) => ({
        fuelType: t.fuelType,
        gallons: t.gallons,
        totalCost: t.totalCost,
        avgPricePerGallon: t.gallons > 0 ? t.totalCost / t.gallons : 0,
        entries: t.entries,
      }))
      .sort((a, b) => b.totalCost - a.totalCost);
  }, [anyChip, byFuelType, filteredEntries]);

  // Sparklines track the ON-SCREEN scope (range + filters) via the trend
  // buckets, so the little curves always agree with the big numbers.
  const spendSpark = trendBuckets.map((b) => b.spend);
  const gallonSpark = trendBuckets.map((b) => b.gallons);
  const entriesSpark = trendBuckets.map((b) => b.entries);

  // Avg $/gal is a RATIO, not a subtotal — blending products (diesel
  // ~$5.50 vs DEF ~$3.50) yields a number that is true for neither and
  // moves with the purchase mix, not with prices. So the card never
  // blends: one product in scope → big number + trend spark; several →
  // one weighted average PER product (ordered by spend).
  const ppgList = fuelTypeShare.map((t) => ({
    fuelType: t.fuelType,
    avg: t.avgPricePerGallon,
  }));
  const singleType = ppgList.length === 1 ? ppgList[0] : null;
  const priceSpark = singleType
    ? trendBuckets
        .map((b) => b.ppgByType[singleType.fuelType])
        .filter((v): v is number => v != null)
    : [];

  // ─── Tab views ────────────────────────────────────────────────────────
  const views: SavedView[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'ifta',     label: 'IFTA filing' },
    { id: 'vehicle',  label: 'By vehicle' },
  ];

  const handleExportFuel = () => {
    if (!byVendor || byVendor.length === 0) {
      return;
    }
    exportToCSV(
      byVendor,
      [
        { header: 'Vendor', accessor: (r) => r.vendorName },
        { header: 'Gallons', accessor: (r) => r.gallons },
        { header: 'Total cost', accessor: (r) => r.totalCost },
        { header: 'Avg $/gal', accessor: (r) => r.avgPricePerGallon },
        { header: 'Entries', accessor: (r) => r.entries },
      ],
      `fuel-vendors-${rangeId}-${format(now, 'yyyy-MM-dd')}`,
    );
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      <SavedViews
        views={views}
        activeId={view}
        onChange={(id) => setView(id as 'overview' | 'ifta' | 'vehicle')}
        actions={
          <>
            <WBtn size="sm" variant="ghost" leading="export" onClick={handleExportFuel}>
              Export
            </WBtn>
            <WBtn size="sm" variant="primary" leading="doc-dollar" onClick={() => setView('ifta')}>
              Generate IFTA filing
            </WBtn>
          </>
        }
      />

      {/* Control strip — range + filters */}
      <div
        className="flex items-center gap-3 flex-wrap shrink-0"
        style={{
          background: 'var(--bg-surface)',
          borderBottom: '1px solid var(--border-hairline)',
          padding: '10px 24px',
        }}
      >
        <RangeSelect ranges={ranges} rangeId={rangeId} onChange={setRangeId} />
        <span
          aria-hidden
          style={{ width: 1, height: 22, background: 'var(--border-hairline-strong)' }}
        />
        <FilterBar properties={filterProps} value={filters} onChange={setFilters} slot="all" />
        <div style={{ flex: 1 }} />
        {filtersActive && (
          <button
            type="button"
            className="focus-ring h-7 px-2 rounded-md bg-transparent border-0 text-[12px] text-[var(--text-tertiary)] hover:text-foreground cursor-pointer"
            onClick={() => setFilters([])}
          >
            Clear filters
          </button>
        )}
      </div>

      <div
        className="scroll-thin flex-1 min-h-0 overflow-auto"
        style={{ background: 'var(--bg-canvas)' }}
      >
        {/* No max-width — the page now fills the available content column.
            The earlier 1360 cap left large gutters on wide displays. */}
        <div style={{ padding: '16px 24px 40px' }}>
          <ScopeLine range={range} filters={filters} filterProps={filterProps} />

          {view === 'overview' && (
            <OverviewView
              range={range}
              totalSpend={totalSpend}
              totalGallons={totalGallons}
              totalEntries={totalEntries}
              iftaGallons={iftaGallons}
              ppgList={ppgList}
              spendDeltaPct={spendDeltaPct}
              gallonsDeltaPct={gallonsDeltaPct}
              entriesDeltaPct={entriesDeltaPct}
              spendSpark={spendSpark}
              gallonSpark={gallonSpark}
              entriesSpark={entriesSpark}
              priceSpark={priceSpark}
              byVendor={vendorShare}
              byFuelType={fuelTypeShare}
              trendBuckets={trendBuckets}
              exceptionCounts={exceptionCounts}
              rawEntries={filteredEntries}
              onOpenEntry={(id, type) => router.push(`/operations/diesel/${id}?type=${type}`)}
              onOpenExceptions={() => setView('overview')}
              loading={summary === undefined}
            />
          )}

          {view === 'ifta' && (
            <IftaView
              range={range}
              totalGallons={iftaGallons}
            />
          )}

          {view === 'vehicle' && (
            <VehicleView
              range={range}
              byTruck={byTruck ?? []}
              byDriver={byDriver ?? []}
              cpm={cpm}
              loading={summary === undefined}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Range select ──────────────────────────────────────────────────────
function RangeSelect({
  ranges,
  rangeId,
  onChange,
}: {
  ranges: RangeOption[];
  rangeId: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const active = ranges.find((r) => r.id === rangeId) ?? ranges[0];

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring inline-flex items-center gap-2 cursor-pointer"
        style={{
          height: 30,
          padding: '0 10px',
          borderRadius: 8,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline-strong)',
          color: 'var(--text-primary)',
          fontSize: 12.5,
          fontWeight: 500,
        }}
      >
        <WIcon name="calendar" size={13} color="var(--text-tertiary)" />
        <span>{active.label}</span>
        <span className="num" style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
          · {active.sub}
        </span>
        <WIcon name="chevron-down" size={11} color="var(--text-tertiary)" />
      </button>
      {open && (
        <div
          className="shadow-[var(--shadow-popover)]"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 50,
            width: 256,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
            borderRadius: 10,
            padding: 4,
          }}
        >
          {ranges.map((r) => {
            const on = r.id === rangeId;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => {
                  onChange(r.id);
                  setOpen(false);
                }}
                className="focus-ring w-full flex items-center gap-2 cursor-pointer text-left"
                style={{
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: 'none',
                  background: on ? 'var(--bg-sidebar-active)' : 'transparent',
                }}
                onMouseEnter={(e) => {
                  if (!on) e.currentTarget.style.background = 'var(--bg-row-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!on) e.currentTarget.style.background = 'transparent';
                }}
              >
                <div className="flex-1 min-w-0 leading-tight">
                  <div className="text-[12.5px] font-medium">{r.label}</div>
                  <div className="num text-[11px] text-[var(--text-tertiary)] mt-px">{r.sub}</div>
                </div>
                {on && <WIcon name="check" size={12} color="var(--accent)" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Scope line ────────────────────────────────────────────────────────
function ScopeLine({
  range,
  filters,
  filterProps,
}: {
  range: RangeOption;
  filters: FilterChipValue[];
  filterProps: FilterProperty[];
}) {
  const parts: string[] = [];
  for (const id of ['fuelType', 'driver', 'carrier', 'truck', 'vendor'] as const) {
    const chip = filters.find((c) => c.propId === id);
    if (!chip || !chip.values.length) continue;
    const prop = filterProps.find((p) => p.id === id);
    if (!prop || !prop.options) continue;
    const labels = chip.values.map(
      (v) => (prop.options ?? []).find((o) => o.value === v)?.label ?? v,
    );
    const shown =
      labels.length <= 2 ? labels.join(', ') : `${labels[0]} +${labels.length - 1}`;
    parts.push(`${prop.label}: ${shown}`);
  }
  return (
    <div
      className="flex items-center gap-2 mb-3.5 flex-wrap"
      style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}
    >
      <span style={{ color: 'var(--text-tertiary)' }}>Fuel summary ·</span>
      <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{range.label}</span>
      <span className="num" style={{ color: 'var(--text-tertiary)' }}>{range.sub}</span>
      {parts.length > 0 && (
        <>
          <span style={{ color: 'var(--border-strong)' }}>·</span>
          <WIcon name="filter" size={12} color="var(--text-tertiary)" />
          <span>{parts.join('  ·  ')}</span>
        </>
      )}
    </div>
  );
}

// ─── Overview ──────────────────────────────────────────────────────────
function OverviewView({
  range,
  totalSpend,
  totalGallons,
  totalEntries,
  iftaGallons,
  ppgList,
  spendDeltaPct,
  gallonsDeltaPct,
  entriesDeltaPct,
  spendSpark,
  gallonSpark,
  entriesSpark,
  priceSpark,
  byVendor,
  byFuelType,
  trendBuckets,
  exceptionCounts,
  rawEntries,
  onOpenEntry,
  onOpenExceptions,
  loading,
}: {
  range: RangeOption;
  totalSpend: number;
  totalGallons: number;
  totalEntries: number;
  iftaGallons: number;
  ppgList: Array<{ fuelType: FuelProduct; avg: number }>;
  spendDeltaPct: number;
  gallonsDeltaPct: number;
  entriesDeltaPct: number;
  spendSpark: number[];
  gallonSpark: number[];
  entriesSpark: number[];
  priceSpark: number[];
  byVendor: Array<{ vendorId: string; vendorName: string; gallons: number; totalCost: number; avgPricePerGallon: number; entries: number }>;
  byFuelType: Array<{ fuelType: FuelProduct; gallons: number; totalCost: number; avgPricePerGallon: number; entries: number }>;
  trendBuckets: Array<{ label: string; spend: number; gallons: number; entries: number; byType: Partial<Record<FuelProduct, number>>; ppgByType: Partial<Record<FuelProduct, number>> }>;
  exceptionCounts: { receipt: number; offcard: number; price: number; unlink: number; total: number };
  rawEntries: RawEntry[];
  onOpenEntry: (id: string, type: 'fuel' | 'def') => void;
  onOpenExceptions: () => void;
  loading: boolean;
}) {
  const fmtPct = (p: number) =>
    `${p > 0 ? '+' : ''}${p.toFixed(1)}% vs prior period`;

  // Products with spend in the visible range — drives both the stack
  // order and the legend, in canonical order (never data-order, so the
  // colors stay stable as filters change).
  const productsInChart = FUEL_PRODUCT_ORDER.filter((t) =>
    trendBuckets.some((b) => (b.byType[t] ?? 0) > 0),
  );

  return (
    <div className="flex flex-col gap-4">
      {/* KPI row — totals only. Spend / gallons / purchases are true
          subtotals: they re-scope cleanly under any filter combination.
          Avg $/gal is the one ratio, and it only shows a value when the
          scope is a single product — a blended figure would give a false
          notion of price. */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Total spend"
          value={frMoney(totalSpend)}
          delta={spendDeltaPct === 0 ? range.label : fmtPct(spendDeltaPct)}
          // Higher spend reads as a negative signal.
          tone={spendDeltaPct === 0 ? 'neutral' : spendDeltaPct > 0 ? 'down' : 'up'}
          spark={spendSpark}
          color="var(--accent)"
        />
        <KpiCard
          label="Gallons purchased"
          value={frN(totalGallons)}
          delta={gallonsDeltaPct === 0 ? 'all products in scope' : fmtPct(gallonsDeltaPct)}
          tone="neutral"
          spark={gallonSpark}
          color="var(--accent)"
        />
        {ppgList.length > 1 ? (
          <PpgBreakdownCard items={ppgList} />
        ) : (
          <KpiCard
            label="Avg price / gal"
            value={ppgList.length === 1 ? `$${ppgList[0].avg.toFixed(3)}` : '—'}
            delta={ppgList.length === 1 ? fuelProductLabel(ppgList[0].fuelType) : 'no purchases in range'}
            tone="neutral"
            spark={priceSpark}
            color="#A66800"
          />
        )}
        <KpiCard
          label="Purchases"
          value={frN(totalEntries)}
          delta={entriesDeltaPct === 0 ? range.label : fmtPct(entriesDeltaPct)}
          tone="neutral"
          spark={entriesSpark}
          color="#0F8C5F"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1.7fr_1fr] gap-4 items-start">
        <DSCard
          title={`Spend & price — ${range.granularity === 'month' ? 'monthly' : 'weekly'}`}
          action={
            <ChartLegend
              items={[
                ...productsInChart.map((t) => ({
                  color: FUEL_PRODUCT_COLORS[t],
                  label: fuelProductLabel(t),
                })),
                { color: PRICE_LINE_COLOR, label: '$/gal', dashed: true },
              ]}
            />
          }
        >
          {/* Buckets always span the range now; treat "no spend in any bucket"
              as the empty state instead of "zero buckets". */}
          {loading ? (
            <p className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">
              Loading…
            </p>
          ) : trendBuckets.every((b) => b.spend === 0) ? (
            <p className="m-0 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">
              No purchases recorded in this range.
            </p>
          ) : (
            <ComboChart data={trendBuckets} products={productsInChart} />
          )}
        </DSCard>
        <DSCard
          title="Exceptions"
          action={
            <span className="num text-[11.5px] text-[var(--text-tertiary)]">
              {exceptionCounts.total} flagged
            </span>
          }
        >
          <ExceptionsCard counts={exceptionCounts} onReview={onOpenExceptions} />
        </DSCard>
      </div>

      <FuelPurchasesTable entries={rawEntries} onOpenEntry={onOpenEntry} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <DSCard title="Spend by fuel type">
          {byFuelType.length === 0 ? (
            <p className="m-0 py-3 text-[12.5px] text-[var(--text-tertiary)]">
              No fuel spend in this period.
            </p>
          ) : (
            <FuelTypeShare types={byFuelType} />
          )}
        </DSCard>
        <DSCard title="Spend by vendor">
          {byVendor.length === 0 ? (
            <p className="m-0 py-3 text-[12.5px] text-[var(--text-tertiary)]">
              No vendor spend in this period.
            </p>
          ) : (
            <VendorShare vendors={byVendor.slice(0, 8)} />
          )}
        </DSCard>
        <DSCard
          title="IFTA — net position"
          action={<span className="text-[11.5px] text-[var(--text-tertiary)]">{range.label}</span>}
        >
          <IftaSnapshot totalGallons={iftaGallons} />
        </DSCard>
      </div>
    </div>
  );
}

// ─── Avg $/gal breakdown card ──────────────────────────────────────────
// KPI-row variant used when the scope holds several fuel products: one
// weighted average PER product (ordered by spend, dot in the product's
// series color) — never a blended figure, which would move with the
// purchase mix rather than with prices. Shows the top three; the full
// list lives in the Spend-by-fuel-type card below.
function PpgBreakdownCard({
  items,
}: {
  items: Array<{ fuelType: FuelProduct; avg: number }>;
}) {
  const shown = items.slice(0, 3);
  const more = items.length - shown.length;
  return (
    <div
      className="rounded-xl border bg-card"
      style={{ borderColor: 'var(--border-hairline)', padding: '14px 16px' }}
    >
      <div className="tw-label text-[10.5px] text-[var(--text-tertiary)] truncate">
        Avg price / gal
      </div>
      <div className="mt-2 flex flex-col gap-1">
        {shown.map((it) => (
          <div key={it.fuelType} className="flex items-center gap-1.5 min-w-0">
            <span
              aria-hidden
              className="shrink-0"
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: FUEL_PRODUCT_COLORS[it.fuelType],
              }}
            />
            <span className="flex-1 text-[11.5px] text-[var(--text-secondary)] truncate">
              {fuelProductLabel(it.fuelType)}
            </span>
            <span className="num text-[13.5px] font-semibold">${it.avg.toFixed(3)}</span>
          </div>
        ))}
        {more > 0 && (
          <div className="text-[11px] text-[var(--text-tertiary)]">
            +{more} more in “Spend by fuel type”
          </div>
        )}
      </div>
    </div>
  );
}

// ─── KPI card ──────────────────────────────────────────────────────────
function KpiCard({
  label,
  value,
  delta,
  tone,
  spark,
  color,
}: {
  label: string;
  value: string;
  delta: string;
  tone: 'up' | 'down' | 'neutral';
  spark: number[];
  color: string;
}) {
  const toneColor =
    tone === 'up' ? '#0F8C5F' : tone === 'down' ? '#C33C3C' : 'var(--text-tertiary)';
  return (
    <div
      className="rounded-xl border bg-card"
      style={{ borderColor: 'var(--border-hairline)', padding: '14px 16px' }}
    >
      <div className="tw-label text-[10.5px] text-[var(--text-tertiary)] truncate">{label}</div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div
            className="num text-[24px] font-semibold tracking-[-0.015em]"
            style={{ lineHeight: '26px' }}
          >
            {value}
          </div>
          <div
            className="num text-[11.5px] font-medium mt-1"
            style={{ color: toneColor }}
          >
            {delta || '—'}
          </div>
        </div>
        <Sparkline data={spark} color={color} />
      </div>
    </div>
  );
}

function Sparkline({
  data,
  color = 'var(--accent)',
  w = 76,
  h = 30,
}: {
  data: number[];
  color?: string;
  w?: number;
  h?: number;
}) {
  // Hook must run unconditionally — keep it above the early return.
  const gid = `sp-${React.useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (data.length < 2) return <div style={{ width: w, height: h }} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - 2 - ((v - min) / span) * (h - 4);
    return [x, y] as const;
  });
  const line = pts
    .map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1))
    .join(' ');
  const area = `${line} L ${w} ${h} L 0 ${h} Z`;
  return (
    <svg width={w} height={h} style={{ flexShrink: 0, display: 'block' }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={2} fill={color} />
    </svg>
  );
}

function ChartLegend({ items }: { items: Array<{ color: string; label: string; dashed?: boolean }> }) {
  return (
    <div className="flex items-center gap-3 flex-wrap justify-end">
      {items.map((it, i) => (
        <span
          key={i}
          className="inline-flex items-center gap-1.5 text-[11px]"
          style={{ color: 'var(--text-tertiary)' }}
        >
          {it.dashed ? (
            <svg width={16} height={6}>
              <line
                x1={0}
                y1={3}
                x2={16}
                y2={3}
                stroke={it.color}
                strokeWidth={2}
                strokeDasharray="3 2"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 2,
                background: it.color,
                display: 'inline-block',
              }}
            />
          )}
          {it.label}
        </span>
      ))}
    </div>
  );
}

// ─── Combo chart (grouped spend bars + per-product price lines) ─────────
// Each bucket renders one bar per fuel product SIDE BY SIDE (grouped, not
// stacked), in fixed FUEL_PRODUCT_ORDER with fixed colors. Every product
// keeps the same position within its group across buckets so the eye can
// track a series even when a bucket skips it. One dashed $/gal trend line
// per product (gallons-weighted, in the product's color) — a blended
// average would move with the product MIX, not with prices. Lines connect
// across buckets where the product wasn't purchased, so sparse data still
// reads as a trend; dots mark the buckets with real data. Buckets with no
// activity at all still render so their x-axis label stays anchored.
function ComboChart({
  data,
  products,
}: {
  data: Array<{ label: string; spend: number; byType: Partial<Record<FuelProduct, number>>; ppgByType: Partial<Record<FuelProduct, number>> }>;
  products: FuelProduct[];
}) {
  const W = 620;
  const H = 188;
  const padT = 10;
  const padL = 4;
  const padR = 4;
  const chartH = H - 22 - padT;
  const chartW = W - padL - padR;
  const n = data.length;
  const seriesCount = Math.max(products.length, 1);
  // Grouped bars scale to the largest SINGLE product value, not the
  // bucket total — each bar starts at the baseline.
  const maxSpend =
    Math.max(...data.flatMap((d) => products.map((t) => d.byType[t] ?? 0))) * 1.1 || 1;
  // Price scale spans every product's observed $/gal so all trend lines
  // share one hidden scale; only real data points contribute.
  const livePpgs = data.flatMap((d) =>
    products
      .map((t) => d.ppgByType[t])
      .filter((v): v is number => v != null),
  );
  const ppgMin = livePpgs.length > 0 ? Math.min(...livePpgs) - 0.06 : 0;
  const ppgMax = livePpgs.length > 0 ? Math.max(...livePpgs) + 0.06 : 1;
  const ppgSpan = ppgMax - ppgMin || 1;
  const slot = chartW / n;
  // Group geometry: the group takes up to 72% of the slot, capped so a
  // lone series doesn't balloon; each product gets an equal sub-slot
  // with a 2px gap between neighbors.
  const groupW = Math.min(slot * 0.72, seriesCount * 16, 96);
  const subSlot = groupW / seriesCount;
  const subBarW = Math.max(subSlot - 2, 2);

  // One trend line per product: collect that product's data points
  // (buckets where it was purchased) and connect them in order — gaps
  // are bridged so the line reads as a continuous trend.
  const priceLines = products.map((t) => {
    const pts = data.flatMap((d, i) => {
      const v = d.ppgByType[t];
      if (v == null) return [];
      return [{
        x: padL + slot * i + slot / 2,
        y: padT + chartH - ((v - ppgMin) / ppgSpan) * chartH,
        label: d.label,
        value: v,
      }];
    });
    const path = pts
      .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(' ');
    return { product: t, pts, path };
  });
  const grid = [0, 0.25, 0.5, 0.75, 1];

  // Density-aware label cadence: with > 8 buckets show every other label
  // so they don't overlap. Always show first and last.
  const labelCadence = n > 8 ? 2 : 1;

  return (
    <div>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ display: 'block', height: 188 }}
      >
        {grid.map((g, i) => (
          <line
            key={i}
            x1={padL}
            y1={padT + chartH * g}
            x2={W - padR}
            y2={padT + chartH * g}
            stroke="var(--border-hairline)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {data.map((d, i) => {
          if (d.spend <= 0) return null;
          const x0 = padL + slot * i + (slot - groupW) / 2;
          return (
            <g key={i}>
              {products.map((t, k) => {
                const v = d.byType[t] ?? 0;
                if (v <= 0) return null;
                const h = Math.max((v / maxSpend) * chartH, 1.5);
                const x = x0 + k * subSlot + (subSlot - subBarW) / 2;
                const y = padT + chartH - h;
                return (
                  <rect
                    key={t}
                    x={x}
                    y={y}
                    width={subBarW}
                    height={h}
                    rx={1.5}
                    fill={FUEL_PRODUCT_COLORS[t]}
                  >
                    <title>{`${d.label} · ${fuelProductLabel(t)}: ${frMoney(v)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        {priceLines.map(({ product, pts, path }) => (
          <g key={product}>
            {pts.length > 1 && (
              <path
                d={path}
                fill="none"
                stroke={FUEL_PRODUCT_COLORS[product]}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {pts.map((p, i) => (
              <circle
                key={i}
                cx={p.x}
                cy={p.y}
                r={2.2}
                fill={FUEL_PRODUCT_COLORS[product]}
                stroke="var(--bg-surface)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              >
                <title>{`${p.label} · ${fuelProductLabel(product)}: $${p.value.toFixed(3)}/gal`}</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div className="flex justify-between mt-1.5">
        {data.map((d, i) => {
          const show = i === 0 || i === n - 1 || i % labelCadence === 0;
          return (
            <div
              key={i}
              className="num text-[9.5px] text-[var(--text-tertiary)] text-center"
              style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}
            >
              {show ? d.label : ''}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Exceptions card ────────────────────────────────────────────────────
// Four rules computed from raw entries upstream: missing receipt scan /
// paid off fuel card / price anomaly / not linked to a load. A row dims
// when its count is zero so the eye picks the active rules first.
function ExceptionsCard({
  counts,
  onReview,
}: {
  counts: { receipt: number; offcard: number; price: number; unlink: number; total: number };
  onReview: () => void;
}) {
  const rows: Array<{
    id: keyof typeof counts;
    icon: 'file-text' | 'doc-dollar' | 'alert' | 'package';
    label: string;
    sub: string;
    tone: 'warn' | 'danger' | 'muted';
  }> = [
    { id: 'receipt', icon: 'file-text',  tone: 'warn',   label: 'Missing receipt scan', sub: 'Required for IFTA' },
    { id: 'offcard', icon: 'doc-dollar', tone: 'warn',   label: 'Paid off fuel card',   sub: 'Reimbursement pending' },
    { id: 'price',   icon: 'alert',      tone: 'danger', label: 'Price anomaly',        sub: '> +$0.20/gal vs lane' },
    { id: 'unlink',  icon: 'package',    tone: 'muted',  label: 'Not linked to a load', sub: 'Local / unassigned' },
  ];
  const toneColor = { warn: '#A66800', danger: '#C33C3C', muted: 'var(--text-tertiary)' } as const;
  const toneBg = {
    warn: 'rgba(245,158,11,0.10)',
    danger: 'rgba(239,68,68,0.10)',
    muted: 'var(--bg-surface-2)',
  } as const;
  return (
    <div className="flex flex-col">
      {rows.map((e, i) => {
        const n = counts[e.id];
        return (
          <div
            key={e.id}
            className="flex items-center gap-2.5"
            style={{
              padding: '9px 0',
              borderTop: i === 0 ? 'none' : '1px solid var(--border-hairline)',
              opacity: n === 0 ? 0.5 : 1,
            }}
          >
            <div
              className="shrink-0 inline-flex items-center justify-center"
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: toneBg[e.tone],
                color: toneColor[e.tone],
              }}
            >
              <WIcon name={e.icon} size={13} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-medium truncate">{e.label}</div>
              <div className="text-[11px] text-[var(--text-tertiary)] mt-0.5">{e.sub}</div>
            </div>
            <span
              className="num text-[15px] font-semibold"
              style={{ color: e.tone === 'muted' ? 'var(--text-secondary)' : toneColor[e.tone] }}
            >
              {n}
            </span>
            {n > 0 && (
              <button
                type="button"
                onClick={onReview}
                className="focus-ring text-[11.5px] font-medium bg-transparent border-0 cursor-pointer"
                style={{ padding: '2px 4px', color: 'var(--accent)' }}
              >
                Review →
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Fuel purchases table ───────────────────────────────────────────────
// Recent transactions for the active range. Click a row to open the
// fuel-entry detail. The footer adds totals across all visible rows.
interface RawEntry {
  _id: string;
  entryDate: number;
  vendorId: string;
  vendorName: string;
  /** Source table — drives the detail-page link. */
  type: 'fuel' | 'def';
  fuelType: FuelProduct;
  driverName?: string;
  driverId?: string;
  truckUnitId?: string;
  loadId?: string;
  loadReference?: string;
  gallons: number;
  pricePerGallon: number;
  totalCost: number;
  location?: { city: string; state: string };
  paymentMethod?: string;
  fuelCardNumber?: string;
  receiptUrl?: string;
  receiptStorageId?: string;
}

type PurchaseSortKey =
  | 'date'
  | 'vendor'
  | 'type'
  | 'driver'
  | 'gallons'
  | 'ppg'
  | 'total'
  | 'payment';

function FuelPurchasesTable({
  entries,
  onOpenEntry,
}: {
  entries: RawEntry[];
  onOpenEntry: (id: string, type: 'fuel' | 'def') => void;
}) {
  // Sortable columns — default newest first. Sorting runs over the FULL
  // loaded pool before the 50-row cap, so "top 50 by total" etc. is
  // meaningful, not just a reorder of the newest 50.
  const [sortKey, setSortKey] = React.useState<PurchaseSortKey>('date');
  const [sortDir, setSortDir] = React.useState<'asc' | 'desc'>('desc');

  const onSort = (key: PurchaseSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Numbers and dates start with the big/new end first; text starts A→Z.
      setSortDir(
        key === 'date' || key === 'gallons' || key === 'ppg' || key === 'total' ? 'desc' : 'asc',
      );
    }
  };

  const rows = React.useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    const cmp = (a: RawEntry, b: RawEntry): number => {
      switch (sortKey) {
        case 'date':    return a.entryDate - b.entryDate;
        case 'vendor':  return a.vendorName.localeCompare(b.vendorName);
        // Canonical product order (Diesel, DEF, …) rather than
        // alphabetical, so the grouping matches the rest of the page.
        case 'type':    return FUEL_PRODUCT_ORDER.indexOf(a.fuelType) - FUEL_PRODUCT_ORDER.indexOf(b.fuelType);
        case 'driver':  return (a.driverName ?? '').localeCompare(b.driverName ?? '');
        case 'gallons': return a.gallons - b.gallons;
        case 'ppg':     return a.pricePerGallon - b.pricePerGallon;
        case 'total':   return a.totalCost - b.totalCost;
        case 'payment': return (a.paymentMethod ?? '').localeCompare(b.paymentMethod ?? '');
      }
    };
    return [...entries]
      .sort((a, b) => {
        const c = cmp(a, b);
        // Tie-break newest first so equal keys stay in a stable, useful order.
        return c !== 0 ? dir * c : b.entryDate - a.entryDate;
      })
      .slice(0, 50);
  }, [entries, sortKey, sortDir]);
  const sumGal = rows.reduce((s, r) => s + r.gallons, 0);
  const sumTotal = rows.reduce((s, r) => s + r.totalCost, 0);

  const grid = '92px 1.5fr 122px 1.4fr 84px 80px 96px 1fr';
  const cols: Array<{ key: PurchaseSortKey; label: string; right?: boolean }> = [
    { key: 'date',    label: 'Date' },
    { key: 'vendor',  label: 'Vendor · location' },
    { key: 'type',    label: 'Type' },
    { key: 'driver',  label: 'Driver · truck' },
    { key: 'gallons', label: 'Gallons', right: true },
    { key: 'ppg',     label: '$/gal',   right: true },
    { key: 'total',   label: 'Total',   right: true },
    { key: 'payment', label: 'Payment' },
  ];

  return (
    <DSCard
      title="Fuel purchases"
      bodyClassName="p-0"
      action={
        <div className="flex items-center gap-3">
          <span className="num text-[11.5px] text-[var(--text-tertiary)]">
            {entries.length > rows.length
              ? `${rows.length} of ${entries.length}`
              : `${rows.length} recent`}
          </span>
          <WBtn size="sm" leading="export">Export</WBtn>
        </div>
      }
    >
      <div
        className="grid"
        style={{
          gridTemplateColumns: grid,
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        {cols.map((c) => {
          const active = sortKey === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => onSort(c.key)}
              title={`Sort by ${c.label}`}
              className="focus-ring flex items-center gap-1 text-[11px] font-semibold uppercase cursor-pointer"
              style={{
                padding: '9px 14px',
                letterSpacing: 0.04,
                justifyContent: c.right ? 'flex-end' : 'flex-start',
                background: 'transparent',
                border: 'none',
                color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
              }}
            >
              {c.label}
              {active && (
                <WIcon name={sortDir === 'asc' ? 'sort-asc' : 'sort-desc'} size={11} />
              )}
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <div className="py-7 text-center text-[12.5px] text-[var(--text-tertiary)]">
          No fuel purchases in this range.
        </div>
      ) : (
        rows.map((r) => {
          const d = new Date(r.entryDate);
          const dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          const timeLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          const locLabel = r.location ? `${r.location.city}, ${r.location.state}` : '';
          const typeLabel = fuelProductLabel(r.fuelType);
          const truckLoad = [r.truckUnitId, r.loadReference ?? (r.loadId ? String(r.loadId).slice(-6) : null)]
            .filter(Boolean)
            .join(' · ');
          const cardLast4 = r.fuelCardNumber ? `****${r.fuelCardNumber.slice(-4)}` : '';
          const methodLabel = r.paymentMethod ? r.paymentMethod.replace(/_/g, ' ') : '—';
          return (
            <button
              key={r._id}
              type="button"
              onClick={() => onOpenEntry(r._id, r.type)}
              className="grid items-center text-left cursor-pointer focus-ring"
              style={{
                gridTemplateColumns: grid,
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--border-hairline)',
                width: '100%',
                minHeight: 44,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-row-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              <div className="px-3.5 py-2">
                <div className="num text-[12px] font-medium">{dateLabel}</div>
                <div className="num text-[10.5px] text-[var(--text-tertiary)] mt-0.5">{timeLabel}</div>
              </div>
              <div className="px-3.5 py-2 flex items-center gap-2 min-w-0">
                <span
                  className="shrink-0 inline-flex items-center justify-center"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: 'rgba(46,92,255,0.10)',
                    color: 'var(--accent)',
                  }}
                >
                  <WIcon name="droplet" size={11} />
                </span>
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium truncate">{r.vendorName}</div>
                  <div className="text-[11px] text-[var(--text-tertiary)] truncate mt-0.5">
                    {locLabel || '—'}
                  </div>
                </div>
              </div>
              <div className="px-3.5 py-2 flex items-center gap-1.5 min-w-0">
                <span
                  aria-hidden
                  className="shrink-0"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: FUEL_PRODUCT_COLORS[r.fuelType],
                  }}
                />
                <span className="text-[12px] font-medium truncate">{typeLabel}</span>
              </div>
              <div className="px-3.5 py-2 flex items-center gap-2 min-w-0">
                {r.driverName ? (
                  <Avatar name={r.driverName} size={20} />
                ) : (
                  <span
                    className="shrink-0 inline-flex items-center justify-center"
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 9999,
                      background: 'var(--bg-surface-2)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    <WIcon name="users" size={11} />
                  </span>
                )}
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium truncate">{r.driverName ?? 'Unassigned'}</div>
                  {truckLoad && (
                    <div className="num text-[11px] text-[var(--text-tertiary)] truncate mt-0.5">
                      {truckLoad}
                    </div>
                  )}
                </div>
              </div>
              <div className="num text-right px-3.5 py-2 text-[12.5px]">{r.gallons.toFixed(1)}</div>
              <div className="num text-right px-3.5 py-2 text-[12.5px] text-[var(--text-secondary)]">
                ${r.pricePerGallon.toFixed(3)}
              </div>
              <div className="num text-right px-3.5 py-2 text-[13px] font-semibold">
                {frMoney(r.totalCost)}
              </div>
              <div className="px-3.5 py-2 min-w-0">
                <div className="text-[12px] font-medium truncate">{methodLabel}</div>
                {cardLast4 && (
                  <div className="num text-[11px] text-[var(--text-tertiary)] truncate mt-0.5">
                    {cardLast4}
                  </div>
                )}
              </div>
            </button>
          );
        })
      )}

      {rows.length > 0 && (
        <div
          className="grid items-center"
          style={{
            gridTemplateColumns: grid,
            background: 'var(--bg-surface-2)',
            minHeight: 40,
          }}
        >
          <div className="px-3.5 py-2 text-[12px] font-bold">Total</div>
          <div />
          <div />
          <div className="px-3.5 py-2 text-right text-[11px] text-[var(--text-tertiary)]">
            {rows.length} purchase{rows.length === 1 ? '' : 's'}
          </div>
          <div className="num text-right px-3.5 py-2 text-[12.5px] font-semibold">
            {sumGal.toFixed(1)}
          </div>
          <div />
          <div className="num text-right px-3.5 py-2 text-[13px] font-bold" style={{ color: 'var(--accent)' }}>
            {frMoney(sumTotal)}
          </div>
          <div />
        </div>
      )}
    </DSCard>
  );
}

// ─── Fuel-type share ───────────────────────────────────────────────────
// One bar per product bought at the pump: Diesel / Dyed diesel /
// Biodiesel / Gasoline / Other from fuelEntries, plus DEF from its own
// defEntries table.
function FuelTypeShare({
  types,
}: {
  types: Array<{ fuelType: FuelProduct; gallons: number; totalCost: number; avgPricePerGallon: number }>;
}) {
  const total = types.reduce((s, t) => s + t.totalCost, 0) || 1;
  const max = Math.max(...types.map((t) => t.totalCost), 1);
  return (
    <div className="flex flex-col gap-3">
      {types.map((t) => {
        const pct = (t.totalCost / total) * 100;
        const widthPct = (t.totalCost / max) * 100;
        return (
          <div key={t.fuelType} className="flex items-center gap-2.5">
            <div className="min-w-0" style={{ width: 132 }}>
              <div className="text-[12px] font-medium truncate">
                {fuelProductLabel(t.fuelType)}
              </div>
              <div className="num text-[10.5px] text-[var(--text-tertiary)] truncate">
                {frN(t.gallons)} gal · ${t.avgPricePerGallon.toFixed(3)}/gal
              </div>
            </div>
            <div
              className="flex-1 overflow-hidden"
              style={{ height: 16, background: 'var(--bg-surface-2)', borderRadius: 4 }}
            >
              <div
                style={{
                  width: `${widthPct}%`,
                  height: '100%',
                  background: FUEL_PRODUCT_COLORS[t.fuelType],
                  opacity: 0.85,
                  borderRadius: 4,
                }}
              />
            </div>
            <div
              className="text-right flex items-baseline justify-end gap-1.5"
              style={{ width: 96 }}
            >
              <span className="num text-[12.5px] font-semibold">{frMoney(t.totalCost)}</span>
              <span className="num text-[11px] text-[var(--text-tertiary)]">{Math.round(pct)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Vendor share ──────────────────────────────────────────────────────
function VendorShare({
  vendors,
}: {
  vendors: Array<{ vendorId: string; vendorName: string; totalCost: number }>;
}) {
  const total = vendors.reduce((s, v) => s + v.totalCost, 0) || 1;
  const max = Math.max(...vendors.map((v) => v.totalCost), 1);
  return (
    <div className="flex flex-col gap-3">
      {vendors.map((v) => {
        const pct = (v.totalCost / total) * 100;
        const widthPct = (v.totalCost / max) * 100;
        return (
          <div key={v.vendorId} className="flex items-center gap-2.5">
            <div className="min-w-0 flex items-center gap-2" style={{ width: 132 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: 'var(--accent)',
                  flexShrink: 0,
                }}
              />
              <span className="text-[12px] font-medium truncate">{v.vendorName}</span>
            </div>
            <div
              className="flex-1 overflow-hidden"
              style={{ height: 16, background: 'var(--bg-surface-2)', borderRadius: 4 }}
            >
              <div
                style={{
                  width: `${widthPct}%`,
                  height: '100%',
                  background: 'var(--accent)',
                  opacity: 0.85,
                  borderRadius: 4,
                }}
              />
            </div>
            <div
              className="text-right flex items-baseline justify-end gap-1.5"
              style={{ width: 96 }}
            >
              <span className="num text-[12.5px] font-semibold">{frMoney(v.totalCost)}</span>
              <span className="num text-[11px] text-[var(--text-tertiary)]">{Math.round(pct)}%</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── IFTA snapshot (Overview) ──────────────────────────────────────────
// Placeholder until per-state mileage feeds in from GPS / route data.
function IftaSnapshot({ totalGallons }: { totalGallons: number }) {
  // We use rough proxy: assume fleet-MPG taxable gallons across the period,
  // and a 50% taxable share. Replace once real state-by-state data lands.
  const placeholderNet = totalGallons * 0.3 * 0.45;
  return (
    <>
      <div
        className="flex items-center justify-between rounded-md mb-3"
        style={{ padding: '10px 12px', background: 'var(--bg-sidebar-active)' }}
      >
        <div>
          <div className="text-[11.5px] text-[var(--text-secondary)]">Estimated net tax due</div>
          <div className="num text-[11px] text-[var(--text-tertiary)] mt-0.5">
            Filed quarterly · estimate
          </div>
        </div>
        <div className="num text-[22px] font-bold" style={{ color: 'var(--accent)' }}>
          {totalGallons > 0 ? frMoney(placeholderNet) : '—'}
        </div>
      </div>
      <p className="m-0 text-[12px] text-[var(--text-tertiary)]">
        State-by-state mileage source coming soon. The full reconciliation
        will appear here once GPS routes feed in.
      </p>
    </>
  );
}

// ─── IFTA view ─────────────────────────────────────────────────────────
function IftaView({ range, totalGallons }: { range: RangeOption; totalGallons: number }) {
  void totalGallons;
  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex items-center gap-5"
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
          borderRadius: 12,
          padding: '16px 20px',
        }}
      >
        <div
          className="shrink-0 inline-flex items-center justify-center"
          style={{
            width: 44,
            height: 44,
            borderRadius: 10,
            background: 'var(--bg-sidebar-active)',
            color: 'var(--accent)',
          }}
        >
          <WIcon name="doc-dollar" size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold">IFTA reconciliation — {range.label}</div>
          <div className="text-[12.5px] text-[var(--text-secondary)] mt-0.5">
            {range.sub} · per-state mileage feed not yet wired
          </div>
        </div>
        <WBtn size="md" variant="primary" leading="doc-dollar" disabled>
          Generate filing
        </WBtn>
      </div>

      <DSCard title="Jurisdiction reconciliation">
        <div
          className="px-3 py-6 text-center rounded-md"
          style={{
            border: '1px dashed var(--border-hairline-strong)',
            color: 'var(--text-tertiary)',
            fontSize: 12.5,
          }}
        >
          IFTA per-state miles + tax rates source coming online. Once trip
          GPS routes feed into the analytics pipeline, this table will
          show: jurisdiction · miles · taxable gallons · tax-paid gallons ·
          net taxable · tax rate · net tax due.
        </div>
      </DSCard>
    </div>
  );
}

// ─── By-vehicle view ───────────────────────────────────────────────────
function VehicleView({
  range,
  byTruck,
  byDriver,
  cpm,
  loading,
}: {
  range: RangeOption;
  byTruck: Array<{ truckId: string; unitId: string; gallons: number; totalCost: number; entries: number }>;
  byDriver: Array<{ driverId: string; driverName: string; gallons: number; totalCost: number; entries: number }>;
  cpm: unknown;
  loading: boolean;
}) {
  void cpm;
  // Pair trucks ↔ drivers by entry count (best available cross-link until
  // we have a per-fill driver+truck join surfaced from the report query).
  const rows = byTruck.map((t) => {
    const matching = byDriver
      .slice()
      .sort((a, b) => b.entries - a.entries)
      .find((d) => Math.round(d.totalCost) === Math.round(t.totalCost));
    return {
      unit: t.unitId,
      driver: matching?.driverName ?? '—',
      gallons: t.gallons,
      spend: t.totalCost,
      entries: t.entries,
    };
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <KpiCard
          label="Fleet economy"
          value={`${FLEET_MPG} mpg`}
          delta={`${range.label} · target 6.6`}
          tone="neutral"
          spark={[6.2, 6.3, 6.2, 6.4, 6.3, 6.5, 6.4, 6.4]}
          color="#0F8C5F"
        />
        <KpiCard
          label="Trucks tracked"
          value={`${byTruck.length}`}
          delta="with fuel activity"
          tone="neutral"
          spark={byTruck.slice(0, 8).map((t) => t.gallons)}
          color="var(--accent)"
        />
        <KpiCard
          label="Drivers tracked"
          value={`${byDriver.length}`}
          delta="with fuel activity"
          tone="neutral"
          spark={byDriver.slice(0, 8).map((d) => d.gallons)}
          color="#A66800"
        />
      </div>

      <DSCard title="Fuel economy by vehicle" bodyClassName="p-0">
        {loading ? (
          <p className="m-0 px-4 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">
            Loading…
          </p>
        ) : rows.length === 0 ? (
          <p className="m-0 px-4 py-6 text-center text-[12.5px] text-[var(--text-tertiary)]">
            No vehicles with fuel activity in this range.
          </p>
        ) : (
          <VehicleTable rows={rows} />
        )}
      </DSCard>

      {byDriver.length > 0 && (
        <DSCard title="Top drivers — fuel" bodyClassName="p-0">
          <DriverTable rows={byDriver.slice(0, 10)} />
        </DSCard>
      )}
    </div>
  );
}

function VehicleTable({
  rows,
}: {
  rows: Array<{ unit: string; driver: string; gallons: number; spend: number; entries: number }>;
}) {
  const cols = ['Unit · driver', 'Gallons', 'Entries', 'Spend', '$/gal'];
  const grid = '1.6fr 1fr 0.8fr 1fr 1fr';
  return (
    <div>
      <div
        className="grid"
        style={{
          gridTemplateColumns: grid,
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        {cols.map((c, i) => (
          <div
            key={c}
            className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase"
            style={{
              padding: '9px 14px',
              letterSpacing: 0.04,
              textAlign: i === 0 ? 'left' : 'right',
            }}
          >
            {c}
          </div>
        ))}
      </div>
      {rows.map((r) => {
        const avg = r.gallons > 0 ? r.spend / r.gallons : 0;
        return (
          <div
            key={r.unit}
            className="grid items-center"
            style={{
              gridTemplateColumns: grid,
              borderBottom: '1px solid var(--border-hairline)',
              minHeight: 44,
            }}
          >
            <div className="flex items-center gap-2.5 px-3.5 py-2 min-w-0">
              <div
                className="shrink-0 inline-flex items-center justify-center"
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: 'rgba(46,92,255,0.10)',
                  color: 'var(--accent)',
                }}
              >
                <WIcon name="truck" size={13} />
              </div>
              <div className="min-w-0">
                <div className="num text-[12.5px] font-semibold">{r.unit}</div>
                <div className="text-[11px] text-[var(--text-tertiary)] truncate">{r.driver}</div>
              </div>
            </div>
            <div className="num text-right px-3.5 py-2 text-[12.5px]">{frN(r.gallons)}</div>
            <div className="num text-right px-3.5 py-2 text-[12.5px]">{r.entries}</div>
            <div className="num text-right px-3.5 py-2 text-[12.5px] font-semibold">{frMoney(r.spend)}</div>
            <div className="num text-right px-3.5 py-2 text-[12.5px] text-[var(--text-secondary)]">
              {avg > 0 ? frMoney2(avg) : '—'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DriverTable({
  rows,
}: {
  rows: Array<{ driverId: string; driverName: string; gallons: number; totalCost: number; entries: number }>;
}) {
  return (
    <div>
      <div
        className="grid"
        style={{
          gridTemplateColumns: '1.8fr 1fr 1fr 1fr',
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        {['Driver', 'Gallons', 'Spend', 'Entries'].map((c, i) => (
          <div
            key={c}
            className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase"
            style={{
              padding: '9px 14px',
              letterSpacing: 0.04,
              textAlign: i === 0 ? 'left' : 'right',
            }}
          >
            {c}
          </div>
        ))}
      </div>
      {rows.map((r) => (
        <div
          key={r.driverId}
          className="grid items-center"
          style={{
            gridTemplateColumns: '1.8fr 1fr 1fr 1fr',
            borderBottom: '1px solid var(--border-hairline)',
            minHeight: 44,
          }}
        >
          <div className="flex items-center gap-2 px-3.5 py-2 min-w-0">
            <Avatar name={r.driverName} size={22} />
            <span className="text-[12.5px] font-medium truncate">{r.driverName}</span>
          </div>
          <div className="num text-right px-3.5 py-2 text-[12.5px]">{frN(r.gallons)}</div>
          <div className="num text-right px-3.5 py-2 text-[12.5px] font-semibold">{frMoney(r.totalCost)}</div>
          <div className="num text-right px-3.5 py-2 text-[12.5px] text-[var(--text-secondary)]">{r.entries}</div>
        </div>
      ))}
    </div>
  );
}
