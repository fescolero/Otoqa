'use client';

import { useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/utils/format';
import { exportToCSV } from '@/lib/csv-export';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

import { ReportTableLayout } from '../shared/report-table-layout';
import { ReportIntelligenceSidebar } from '../shared/report-intelligence-sidebar';
import { ReportDataTable, getSelectColumn, SortableHeader } from '../shared/report-data-table';
import { SummaryStat } from '../shared/summary-stat';
import type { TabComponentProps, QuickFilter } from '../shared/types';

// ============================================
// TYPES
// ============================================

interface ProfitabilityRow {
  loadId: string;
  orderNumber: string;
  customerName: string;
  laneLabel: string;
  miles: number;
  revenue: number;
  driverPay: number;
  carrierPay: number;
  fuelCost: number;
  fuelSource: string;
  profit: number;
  margin: number;
  loadType: string;
  isHeld: boolean;
  firstStopDate: string | null;
  hasInvoice: boolean;
}

// ============================================
// QUICK FILTERS
// ============================================

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All', value: 'all' },
  { label: 'High Margin (>20%)', value: 'high' },
  { label: 'Low Margin (<10%)', value: 'low' },
  { label: 'Negative', value: 'negative' },
];

// ============================================
// COLUMNS
// ============================================

const columns: ColumnDef<ProfitabilityRow, unknown>[] = [
  getSelectColumn<ProfitabilityRow>(),
  {
    accessorKey: 'orderNumber',
    header: 'Load #',
    cell: ({ row }) => (
      <div className="flex items-center gap-1">
        <span className="font-medium">{row.original.orderNumber}</span>
        {row.original.isHeld && (
          <Badge variant="outline" className="text-xs">
            Held
          </Badge>
        )}
        {!row.original.hasInvoice && (
          <Badge variant="destructive" className="text-xs">
            No Invoice
          </Badge>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'customerName',
    header: 'Customer',
  },
  {
    accessorKey: 'laneLabel',
    header: 'Lane',
    cell: ({ row }) => <span className="max-w-[200px] truncate block">{row.original.laneLabel}</span>,
  },
  {
    accessorKey: 'miles',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Miles
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatNumber(row.original.miles)}</span>,
  },
  {
    accessorKey: 'revenue',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Revenue
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.revenue)}</span>,
  },
  {
    accessorKey: 'driverPay',
    header: 'Driver Pay',
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.driverPay)}</span>,
  },
  {
    accessorKey: 'carrierPay',
    header: 'Carrier Pay',
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.carrierPay)}</span>,
  },
  {
    accessorKey: 'fuelCost',
    header: 'Fuel',
    cell: ({ row }) => (
      <span className="text-right block text-muted-foreground">
        {row.original.fuelCost > 0 ? formatCurrency(row.original.fuelCost) : '-'}
        {row.original.fuelSource === 'ESTIMATED' && (
          <span className="ml-1 text-xs text-yellow-600" title="Estimated from truck cost-per-mile">
            ~
          </span>
        )}
      </span>
    ),
  },
  {
    accessorKey: 'profit',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Profit
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className={cn('text-right block font-semibold', row.original.profit > 0 ? 'text-green-600' : 'text-red-600')}
      >
        {formatCurrency(row.original.profit)}
      </span>
    ),
  },
  {
    accessorKey: 'margin',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Margin
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const m = row.original.margin;
      return (
        <span
          className={cn(
            'text-right block font-semibold',
            m > 20 && 'text-green-600',
            m >= 10 && m <= 20 && 'text-yellow-600',
            m >= 0 && m < 10 && 'text-orange-600',
            m < 0 && 'text-red-600',
          )}
        >
          {formatPercent(m)}
        </span>
      );
    },
  },
];

// ============================================
// COMPONENT
// ============================================

export function ProfitabilityTab({ organizationId, dateRange, searchQuery }: TabComponentProps) {
  const [quickFilter, setQuickFilter] = useState('all');

  const profitSummary = useAuthQuery(api.accountingReports.getProfitabilitySummary, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const profitByLoad = useAuthQuery(api.accountingReports.getProfitabilityByLoad, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const isLoading = !profitSummary || !profitByLoad;

  // Apply quick filter
  const filteredData = useMemo(() => {
    if (!profitByLoad) return [];
    switch (quickFilter) {
      case 'high':
        return profitByLoad.loads.filter((r) => r.margin > 20);
      case 'low':
        return profitByLoad.loads.filter((r) => r.margin >= 0 && r.margin < 10);
      case 'negative':
        return profitByLoad.loads.filter((r) => r.margin < 0);
      default:
        return profitByLoad.loads;
    }
  }, [profitByLoad, quickFilter]);

  const handleExport = () => {
    if (!profitByLoad) return;
    exportToCSV(
      profitByLoad.loads,
      [
        { header: 'Load #', accessor: (r) => r.orderNumber },
        { header: 'Customer', accessor: (r) => r.customerName },
        { header: 'Lane', accessor: (r) => r.laneLabel },
        { header: 'Miles', accessor: (r) => r.miles },
        { header: 'Revenue', accessor: (r) => r.revenue },
        { header: 'Driver Pay', accessor: (r) => r.driverPay },
        { header: 'Carrier Pay', accessor: (r) => r.carrierPay },
        { header: 'Fuel Cost', accessor: (r) => r.fuelCost },
        { header: 'Fuel Source', accessor: (r) => r.fuelSource },
        { header: 'Profit', accessor: (r) => r.profit },
        { header: 'Margin %', accessor: (r) => r.margin },
      ],
      'profitability-by-load',
    );
    toast.success('CSV exported');
  };

  // Compute margin distribution for sidebar
  const marginDistribution = useMemo(() => {
    if (!profitByLoad) return null;
    const loads = profitByLoad.loads;
    const negative = loads.filter((l) => l.margin < 0).length;
    const low = loads.filter((l) => l.margin >= 0 && l.margin < 10).length;
    const medium = loads.filter((l) => l.margin >= 10 && l.margin <= 20).length;
    const high = loads.filter((l) => l.margin > 20).length;
    const total = loads.length || 1;
    return {
      negative: { count: negative, pct: ((negative / total) * 100).toFixed(1) },
      low: { count: low, pct: ((low / total) * 100).toFixed(1) },
      medium: { count: medium, pct: ((medium / total) * 100).toFixed(1) },
      high: { count: high, pct: ((high / total) * 100).toFixed(1) },
    };
  }, [profitByLoad]);

  // ============================================
  // SIDEBAR
  // ============================================

  const sidebar = (
    <ReportIntelligenceSidebar
      subtitle="Load-level profit analysis and margin distribution"
      dateRange={dateRange}
      onExport={handleExport}
    >
      {profitSummary && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryStat label="Revenue" value={formatCurrency(profitSummary.totalRevenue)} />
            <SummaryStat label="Total Costs" value={formatCurrency(profitSummary.totalCosts)} />
            <SummaryStat label="Gross Profit" value={formatCurrency(profitSummary.grossProfit)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <SummaryStat label="Profit Margin" value={formatPercent(profitSummary.profitMargin)} />
            <SummaryStat label="Fuel Cost" value={formatCurrency(profitSummary.totalFuel)} />
          </div>

          {/* Margin distribution */}
          {marginDistribution && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Margin Distribution</h4>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-green-600">High ({'>'}20%)</span>
                  <span className="font-medium">
                    {marginDistribution.high.count} loads ({marginDistribution.high.pct}%)
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-yellow-600">Medium (10-20%)</span>
                  <span className="font-medium">
                    {marginDistribution.medium.count} loads ({marginDistribution.medium.pct}%)
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-orange-600">Low (0-10%)</span>
                  <span className="font-medium">
                    {marginDistribution.low.count} loads ({marginDistribution.low.pct}%)
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-red-600">Negative</span>
                  <span className="font-medium">
                    {marginDistribution.negative.count} loads ({marginDistribution.negative.pct}%)
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Cost composition */}
          {profitSummary.totalCosts > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Cost Composition</h4>
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Driver Pay</span>
                  <span className="font-medium">
                    {formatPercent((profitSummary.totalDriverPay / profitSummary.totalCosts) * 100)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Carrier Pay</span>
                  <span className="font-medium">
                    {formatPercent((profitSummary.totalCarrierPay / profitSummary.totalCosts) * 100)}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Fuel + DEF</span>
                  <span className="font-medium">
                    {formatPercent(
                      ((profitSummary.totalFuel + profitSummary.totalDef) / profitSummary.totalCosts) * 100,
                    )}
                  </span>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {profitByLoad && (
        <div className="text-xs text-muted-foreground">
          Showing {profitByLoad.showing} of {profitByLoad.totalLoads} loads
          {profitByLoad.hasMore && ' (narrow date range for more)'}
        </div>
      )}
    </ReportIntelligenceSidebar>
  );

  return (
    <ReportTableLayout sidebar={sidebar}>
      <ReportDataTable<ProfitabilityRow>
        columns={columns}
        data={filteredData as ProfitabilityRow[]}
        searchQuery={searchQuery}
        quickFilters={QUICK_FILTERS}
        activeQuickFilter={quickFilter}
        onQuickFilterChange={setQuickFilter}
        isLoading={isLoading}
        emptyMessage="No profitability data found for the selected date range."
      />
    </ReportTableLayout>
  );
}
