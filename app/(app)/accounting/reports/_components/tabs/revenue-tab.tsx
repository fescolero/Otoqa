'use client';

import { useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from 'recharts';
import { formatCurrency, formatNumber, formatPercent } from '@/lib/utils/format';
import { exportToCSV } from '@/lib/csv-export';
import { toast } from 'sonner';

import { ReportTableLayout } from '../shared/report-table-layout';
import { ReportIntelligenceSidebar } from '../shared/report-intelligence-sidebar';
import { ReportDataTable, getSelectColumn, SortableHeader } from '../shared/report-data-table';
import { SummaryStat } from '../shared/summary-stat';
import type { TabComponentProps, QuickFilter } from '../shared/types';

// ============================================
// TYPES
// ============================================

interface RevenueByCustomerRow {
  customerId: string;
  name: string;
  invoiceCount: number;
  totalRevenue: number;
  avgInvoice: number;
  avgRevenuePerMile: number;
  percentOfTotal: number;
}

// ============================================
// QUICK FILTERS
// ============================================

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All', value: 'all' },
  { label: 'Top 10', value: 'top10' },
  { label: 'Bottom 10', value: 'bottom10' },
];

const CHART_COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))'];

// ============================================
// COLUMNS
// ============================================

const columns: ColumnDef<RevenueByCustomerRow, unknown>[] = [
  getSelectColumn<RevenueByCustomerRow>(),
  {
    accessorKey: 'name',
    header: 'Customer',
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: 'invoiceCount',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Invoices
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatNumber(row.original.invoiceCount)}</span>,
  },
  {
    accessorKey: 'totalRevenue',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Total Revenue
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.totalRevenue)}</span>,
  },
  {
    accessorKey: 'avgInvoice',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Avg Invoice
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.avgInvoice)}</span>,
  },
  {
    accessorKey: 'avgRevenuePerMile',
    header: 'Avg Rev/Mile',
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.avgRevenuePerMile)}</span>,
  },
  {
    accessorKey: 'percentOfTotal',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        % of Total
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatPercent(row.original.percentOfTotal)}</span>,
  },
];

// ============================================
// COMPONENT
// ============================================

export function RevenueTab({ organizationId, dateRange, searchQuery }: TabComponentProps) {
  const [quickFilter, setQuickFilter] = useState('all');

  const revenueSummary = useAuthQuery(api.accountingReports.getRevenueSummary, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const revenueByCustomer = useAuthQuery(api.accountingReports.getRevenueByCustomer, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const revenueOverTime = useAuthQuery(api.accountingReports.getRevenueOverTime, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const isLoading = !revenueSummary || !revenueByCustomer;

  // Apply quick filter
  const filteredData = useMemo(() => {
    if (!revenueByCustomer) return [];
    switch (quickFilter) {
      case 'top10':
        return revenueByCustomer.slice(0, 10);
      case 'bottom10':
        return [...revenueByCustomer].reverse().slice(0, 10);
      default:
        return revenueByCustomer;
    }
  }, [revenueByCustomer, quickFilter]);

  const handleExport = () => {
    if (!revenueByCustomer) return;
    exportToCSV(
      revenueByCustomer,
      [
        { header: 'Customer', accessor: (r) => r.name },
        { header: 'Invoices', accessor: (r) => r.invoiceCount },
        { header: 'Total Revenue', accessor: (r) => r.totalRevenue },
        { header: 'Avg Invoice', accessor: (r) => r.avgInvoice },
        { header: 'Avg Rev/Mile', accessor: (r) => r.avgRevenuePerMile },
        { header: '% of Total', accessor: (r) => r.percentOfTotal },
      ],
      'revenue-by-customer',
    );
    toast.success('CSV exported');
  };

  // ============================================
  // SIDEBAR
  // ============================================

  const sidebar = (
    <ReportIntelligenceSidebar
      subtitle="Revenue streams, customer mix, and billing analytics"
      dateRange={dateRange}
      onExport={handleExport}
    >
      {revenueSummary && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryStat label="Total Revenue" value={formatCurrency(revenueSummary.totalRevenue)} />
            <SummaryStat label="Revenue/Mile" value={formatCurrency(revenueSummary.revenuePerMile)} />
            <SummaryStat label="Avg Invoice" value={formatCurrency(revenueSummary.avgInvoice)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <SummaryStat label="Invoice Count" value={formatNumber(revenueSummary.invoiceCount)} />
            <SummaryStat label="Collected" value={formatCurrency(revenueSummary.totalCollected)} />
          </div>

          {/* Revenue Over Time Chart */}
          {revenueOverTime && revenueOverTime.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Revenue Over Time</h4>
              <ChartContainer
                config={{
                  totalInvoiced: { label: 'Invoiced', color: CHART_COLORS[0] },
                  totalCollected: { label: 'Collected', color: CHART_COLORS[1] },
                }}
                className="h-[180px] w-full"
              >
                <LineChart data={revenueOverTime} margin={{ left: -15 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                  <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 10 }} width={50} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line
                    type="monotone"
                    dataKey="totalInvoiced"
                    stroke="var(--color-totalInvoiced)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="totalCollected"
                    stroke="var(--color-totalCollected)"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ChartContainer>
            </div>
          )}

          {/* Top Customers */}
          {revenueByCustomer && revenueByCustomer.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Top Customers</h4>
              <div className="space-y-2">
                {revenueByCustomer.slice(0, 5).map((c) => (
                  <div key={c.customerId} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate mr-2">{c.name}</span>
                    <span className="font-medium shrink-0">{formatPercent(c.percentOfTotal)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </ReportIntelligenceSidebar>
  );

  return (
    <ReportTableLayout sidebar={sidebar}>
      <ReportDataTable<RevenueByCustomerRow>
        columns={columns}
        data={filteredData as RevenueByCustomerRow[]}
        searchQuery={searchQuery}
        quickFilters={QUICK_FILTERS}
        activeQuickFilter={quickFilter}
        onQuickFilterChange={setQuickFilter}
        isLoading={isLoading}
        emptyMessage="No revenue data found for the selected date range."
      />
    </ReportTableLayout>
  );
}
