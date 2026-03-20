'use client';

import { useEffect, useMemo, useState } from 'react';
import { ColumnDef, type SortingState } from '@tanstack/react-table';
import { api } from '@/convex/_generated/api';
import { useAction } from 'convex/react';
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
  hcr: string;
  loadOrderNumber: string;
  effectiveMiles: number | null;
  paymentMiles: number | null;
  milesDifference: number | null;
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
    accessorKey: 'hcr',
    header: 'HCR',
  },
  {
    accessorKey: 'loadOrderNumber',
    header: 'Load #',
  },
  {
    accessorKey: 'effectiveMiles',
    header: 'Eff. Miles',
    cell: ({ row }) => <span className="text-right block">{row.original.effectiveMiles ?? '-'}</span>,
  },
  {
    accessorKey: 'paymentMiles',
    header: 'Paid Miles',
    cell: ({ row }) => <span className="text-right block">{row.original.paymentMiles ?? '-'}</span>,
  },
  {
    accessorKey: 'milesDifference',
    header: 'Miles Diff',
    cell: ({ row }) => {
      const value = row.original.milesDifference;
      return (
        <span
          className={cn(
            'text-right block font-medium',
            value == null
              ? 'text-muted-foreground'
              : value < 0
                ? 'text-red-600'
                : value > 0
                  ? 'text-green-600'
                  : 'text-foreground',
          )}
        >
          {value == null ? '-' : value}
        </span>
      );
    },
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
  const [sorting, setSorting] = useState<SortingState>([{ id: 'difference', desc: true }]);
  const [detailData, setDetailData] = useState<{ rows: DiscrepancyRow[]; total: number; hasMore: boolean }>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLimit, setDetailLimit] = useState(PAGE_SIZE);
  const [summaryData, setSummaryData] = useState<
    | {
        summary: {
          netDiscrepancy: number;
          underpaidCount: number;
          overpaidCount: number;
          largestUnderpayment: number;
          totalDiscrepantInvoices: number;
        };
        byHcr: Array<{ name: string; netDiscrepancy: number; count: number }>;
      }
    | undefined
  >();
  const [summaryLoading, setSummaryLoading] = useState(false);
  const getDiscrepancyIntelligence = useAction(api.accountingReports.getDiscrepancyIntelligence);
  const getDiscrepancyDetailSorted = useAction(api.accountingReports.getDiscrepancyDetailSorted);
  const direction = quickFilter === 'all' ? undefined : (quickFilter as 'underpaid' | 'overpaid');

  const sortableServerFields = new Set([
    'invoiceNumber',
    'invoicedAmount',
    'paidAmount',
    'difference',
    'percentDiff',
    'paymentReference',
  ] as const);
  const sortBy = sortableServerFields.has(sorting[0]?.id as never)
    ? (sorting[0]?.id as
        | 'invoiceNumber'
        | 'invoicedAmount'
        | 'paidAmount'
        | 'difference'
        | 'percentDiff'
        | 'paymentReference')
    : undefined;
  const sortDir = sorting[0]?.desc ? 'desc' : 'asc';

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      setSummaryLoading(true);
      try {
        const result = await getDiscrepancyIntelligence({
          workosOrgId: organizationId,
          dateRangeStart: dateRange.start,
          dateRangeEnd: dateRange.end,
          direction,
        });
        if (!cancelled) {
          setSummaryData(result);
        }
      } finally {
        if (!cancelled) {
          setSummaryLoading(false);
        }
      }
    }

    void loadSummary();

    return () => {
      cancelled = true;
    };
  }, [organizationId, dateRange.start, dateRange.end, direction, getDiscrepancyIntelligence]);

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      setDetailLoading(true);
      try {
        const result = await getDiscrepancyDetailSorted({
          workosOrgId: organizationId,
          dateRangeStart: dateRange.start,
          dateRangeEnd: dateRange.end,
          direction,
          limit: detailLimit,
          sortBy,
          sortDir,
        });
        if (!cancelled) {
          setDetailData(result as { rows: DiscrepancyRow[]; total: number; hasMore: boolean });
        }
      } finally {
        if (!cancelled) {
          setDetailLoading(false);
        }
      }
    }

    void loadDetail();

    return () => {
      cancelled = true;
    };
  }, [
    organizationId,
    dateRange.start,
    dateRange.end,
    direction,
    detailLimit,
    sortBy,
    sortDir,
    getDiscrepancyDetailSorted,
  ]);

  useEffect(() => {
    setDetailLimit(PAGE_SIZE);
  }, [dateRange.start, dateRange.end, direction, sortBy, sortDir]);

  const isInitialTableLoading = !detailData && detailLoading;
  const isTableRefreshing = !!detailData && detailLoading;

  const filteredData = useMemo(() => (detailData?.rows ?? []) as DiscrepancyRow[], [detailData]);

  const handleExport = () => {
    if (filteredData.length === 0) return;
    exportToCSV(
      filteredData,
      [
        { header: 'Invoice #', accessor: (r) => r.invoiceNumber ?? '' },
        { header: 'Customer', accessor: (r) => r.customerName },
        { header: 'HCR', accessor: (r) => r.hcr },
        { header: 'Load #', accessor: (r) => r.loadOrderNumber },
        { header: 'Effective Miles', accessor: (r) => r.effectiveMiles ?? '' },
        { header: 'Paid Miles', accessor: (r) => r.paymentMiles ?? '' },
        { header: 'Miles Diff', accessor: (r) => r.milesDifference ?? '' },
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

          {/* Discrepancy by HCR Chart */}
          {summaryData.byHcr.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Discrepancy by HCR</h4>
              <ChartContainer
                config={{
                  netDiscrepancy: { label: 'Net Discrepancy', color: CHART_COLORS[0] },
                }}
                className="h-[180px] w-full"
              >
                <BarChart data={summaryData.byHcr.slice(0, 5)} layout="vertical" margin={{ left: -10 }}>
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
        isLoading={isInitialTableLoading}
        isRefreshing={isTableRefreshing}
        emptyMessage="No discrepancy data found for the selected date range."
        onLoadMore={() => setDetailLimit((prev) => prev + PAGE_SIZE)}
        loadMoreStatus={detailLoading ? 'loading' : detailData?.hasMore ? 'can-load' : 'exhausted'}
        serverTotal={summaryData?.summary.totalDiscrepantInvoices ?? detailData?.total}
        manualSorting
        sorting={sorting}
        onSortingChange={setSorting}
      />
    </ReportTableLayout>
  );
}
