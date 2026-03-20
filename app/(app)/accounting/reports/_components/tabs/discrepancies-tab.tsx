'use client';

import { useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { usePaginatedQuery } from 'convex/react';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
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

interface DiscrepancyRow {
  _id: string;
  invoiceNumber: string | null;
  customerName: string;
  loadOrderNumber: string;
  invoicedAmount: number;
  paidAmount: number;
  difference: number;
  percentDiff: number;
  paymentDate?: number;
  paymentReference?: string;
}

// ============================================
// QUICK FILTERS
// ============================================

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All', value: 'all' },
  { label: 'Underpaid', value: 'underpaid' },
  { label: 'Overpaid', value: 'overpaid' },
];

const CHART_COLORS = ['hsl(var(--chart-1))'];
const PAGE_SIZE = 100;

// ============================================
// COLUMNS
// ============================================

const columns: ColumnDef<DiscrepancyRow, unknown>[] = [
  getSelectColumn<DiscrepancyRow>(),
  {
    accessorKey: 'invoiceNumber',
    header: 'Invoice #',
    cell: ({ row }) => <span className="font-medium">{row.original.invoiceNumber ?? '-'}</span>,
  },
  {
    accessorKey: 'customerName',
    header: 'Customer',
  },
  {
    accessorKey: 'loadOrderNumber',
    header: 'Load #',
  },
  {
    accessorKey: 'invoicedAmount',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Invoiced
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.invoicedAmount)}</span>,
  },
  {
    accessorKey: 'paidAmount',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Paid
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.paidAmount)}</span>,
  },
  {
    accessorKey: 'difference',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Difference
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <span
        className={cn(
          'text-right block font-semibold',
          row.original.difference < 0 ? 'text-red-600' : 'text-green-600',
        )}
      >
        {formatCurrency(row.original.difference)}
      </span>
    ),
  },
  {
    accessorKey: 'percentDiff',
    header: '% Diff',
    cell: ({ row }) => <span className="text-right block">{formatPercent(row.original.percentDiff)}</span>,
  },
  {
    accessorKey: 'paymentReference',
    header: 'Payment Ref',
    cell: ({ row }) => <span className="text-muted-foreground">{row.original.paymentReference ?? '-'}</span>,
  },
];

// ============================================
// COMPONENT
// ============================================

export function DiscrepanciesTab({ organizationId, dateRange, searchQuery }: TabComponentProps) {
  const [quickFilter, setQuickFilter] = useState('all');

  // Summary query (lightweight, no enrichment)
  const summaryData = useAuthQuery(api.accountingReports.getDiscrepancySummary, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  // Paginated detail query using Convex cursor-based pagination
  const {
    results: paginatedResults,
    status: paginationStatus,
    loadMore,
    isLoading: isPaginationLoading,
  } = usePaginatedQuery(
    api.accountingReports.getDiscrepancyDetail,
    {
      workosOrgId: organizationId,
      dateRangeStart: dateRange.start,
      dateRangeEnd: dateRange.end,
    },
    { initialNumItems: PAGE_SIZE },
  );

  const isLoading = !summaryData || isPaginationLoading;

  // Apply quick filter client-side on the paginated results
  const filteredData = useMemo(() => {
    const data = (paginatedResults ?? []) as DiscrepancyRow[];
    switch (quickFilter) {
      case 'underpaid':
        return data.filter((r) => r.difference < 0);
      case 'overpaid':
        return data.filter((r) => r.difference > 0);
      default:
        return data;
    }
  }, [paginatedResults, quickFilter]);

  const handleExport = () => {
    if (filteredData.length === 0) return;
    exportToCSV(
      filteredData,
      [
        { header: 'Invoice #', accessor: (r) => r.invoiceNumber ?? '' },
        { header: 'Customer', accessor: (r) => r.customerName },
        { header: 'Load #', accessor: (r) => r.loadOrderNumber },
        { header: 'Invoiced', accessor: (r) => r.invoicedAmount },
        { header: 'Paid', accessor: (r) => r.paidAmount },
        { header: 'Difference', accessor: (r) => r.difference },
        { header: '% Diff', accessor: (r) => r.percentDiff },
      ],
      'discrepancies',
    );
    toast.success('CSV exported');
  };

  // ============================================
  // SIDEBAR
  // ============================================

  const sidebar = (
    <ReportIntelligenceSidebar
      subtitle="Payment variance tracking and reconciliation insights"
      dateRange={dateRange}
      onExport={handleExport}
    >
      {summaryData && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-4">
            <SummaryStat label="Net Discrepancy" value={formatCurrency(summaryData.summary.netDiscrepancy)} />
            <SummaryStat
              label="Total Discrepancies"
              value={formatNumber(summaryData.summary.totalDiscrepantInvoices)}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <SummaryStat label="Underpaid" value={formatNumber(summaryData.summary.underpaidCount)} />
            <SummaryStat label="Overpaid" value={formatNumber(summaryData.summary.overpaidCount)} />
          </div>
          <div className="grid grid-cols-1 gap-4">
            <SummaryStat label="Largest Underpayment" value={formatCurrency(summaryData.summary.largestUnderpayment)} />
          </div>

          {/* Discrepancy by Customer Chart */}
          {summaryData.byCustomer.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Discrepancy by Customer</h4>
              <ChartContainer
                config={{
                  netDiscrepancy: { label: 'Net Discrepancy', color: CHART_COLORS[0] },
                }}
                className="h-[180px] w-full"
              >
                <BarChart data={summaryData.byCustomer.slice(0, 5)} layout="vertical" margin={{ left: -10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis type="number" tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 10 }} />
                  <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 10 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="netDiscrepancy" radius={[0, 4, 4, 0]} fill="var(--color-netDiscrepancy)" />
                </BarChart>
              </ChartContainer>
            </div>
          )}

          {/* Resolution breakdown */}
          <div>
            <h4 className="text-sm font-semibold mb-3">Variance Breakdown</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Underpaid invoices</span>
                <span className="font-medium text-red-600">{formatNumber(summaryData.summary.underpaidCount)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Overpaid invoices</span>
                <span className="font-medium text-green-600">{formatNumber(summaryData.summary.overpaidCount)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Net variance</span>
                <span
                  className={cn(
                    'font-medium',
                    summaryData.summary.netDiscrepancy < 0 ? 'text-red-600' : 'text-green-600',
                  )}
                >
                  {formatCurrency(summaryData.summary.netDiscrepancy)}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </ReportIntelligenceSidebar>
  );

  return (
    <ReportTableLayout sidebar={sidebar}>
      <ReportDataTable<DiscrepancyRow>
        columns={columns}
        data={filteredData}
        searchQuery={searchQuery}
        quickFilters={QUICK_FILTERS}
        activeQuickFilter={quickFilter}
        onQuickFilterChange={setQuickFilter}
        isLoading={isLoading}
        emptyMessage="No discrepancy data found for the selected date range."
        onLoadMore={() => loadMore(PAGE_SIZE)}
        loadMoreStatus={
          paginationStatus === 'CanLoadMore'
            ? 'can-load'
            : paginationStatus === 'LoadingMore'
              ? 'loading'
              : paginationStatus === 'Exhausted'
                ? 'exhausted'
                : 'idle'
        }
        serverTotal={summaryData?.summary.totalDiscrepantInvoices}
      />
    </ReportTableLayout>
  );
}
