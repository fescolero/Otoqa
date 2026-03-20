'use client';

import { useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Badge } from '@/components/ui/badge';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid } from 'recharts';
import { formatCurrency, formatNumber, formatDate } from '@/lib/utils/format';
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

interface ReceivableRow {
  _id: string;
  invoiceNumber: string | null;
  customerName: string;
  customerId: string;
  loadOrderNumber: string;
  loadType: string;
  amount: number;
  dueDate: number;
  daysOutstanding: number;
  isOverdue: boolean;
  status: string;
  isFactored: boolean;
  invoiceDate: number;
}

// ============================================
// QUICK FILTERS
// ============================================

const QUICK_FILTERS: QuickFilter[] = [
  { label: 'All', value: 'all' },
  { label: 'Overdue', value: 'overdue' },
  { label: 'Current', value: 'current' },
  { label: 'Factored', value: 'factored' },
];

// ============================================
// CHART CONFIG
// ============================================

const AGING_COLORS = {
  current: 'hsl(var(--chart-1))',
  days31to60: 'hsl(var(--chart-4))',
  days61to90: 'hsl(var(--chart-3))',
  days90plus: 'hsl(var(--chart-5))',
};

// ============================================
// COLUMNS
// ============================================

const columns: ColumnDef<ReceivableRow, unknown>[] = [
  getSelectColumn<ReceivableRow>(),
  {
    accessorKey: 'invoiceNumber',
    header: 'Invoice #',
    cell: ({ row }) => <span className="font-medium">{row.original.invoiceNumber ?? '-'}</span>,
  },
  {
    accessorKey: 'customerName',
    header: 'Customer',
    cell: ({ row }) => (
      <div className="flex items-center gap-2">
        <span>{row.original.customerName}</span>
        {row.original.isFactored && (
          <Badge variant="outline" className="text-xs">
            Factored
          </Badge>
        )}
      </div>
    ),
  },
  {
    accessorKey: 'loadOrderNumber',
    header: 'Load #',
  },
  {
    accessorKey: 'amount',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Amount
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.amount)}</span>,
  },
  {
    accessorKey: 'daysOutstanding',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Days Out
      </SortableHeader>
    ),
    cell: ({ row }) => {
      const days = row.original.daysOutstanding;
      return (
        <span
          className={cn(
            'text-right block',
            days > 90 && 'text-red-600 font-semibold',
            days > 60 && days <= 90 && 'text-orange-600',
            days > 30 && days <= 60 && 'text-yellow-600',
          )}
        >
          {days}
        </span>
      );
    },
  },
  {
    accessorKey: 'dueDate',
    header: ({ column }) => <SortableHeader column={column}>Due Date</SortableHeader>,
    cell: ({ row }) => formatDate(row.original.dueDate),
  },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => (
      <Badge variant={row.original.isOverdue ? 'destructive' : 'secondary'}>
        {row.original.isOverdue ? 'Overdue' : row.original.status}
      </Badge>
    ),
  },
];

// ============================================
// COMPONENT
// ============================================

export function ReceivablesTab({ organizationId, dateRange, searchQuery }: TabComponentProps) {
  const [quickFilter, setQuickFilter] = useState('all');

  // Data fetching
  const receivablesSummary = useAuthQuery(api.accountingReports.getReceivablesSummary, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const receivablesDetail = useAuthQuery(api.accountingReports.getReceivablesDetail, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const isLoading = !receivablesSummary || !receivablesDetail;

  // Apply quick filter
  const filteredData = useMemo(() => {
    if (!receivablesDetail) return [];
    switch (quickFilter) {
      case 'overdue':
        return receivablesDetail.filter((r) => r.isOverdue);
      case 'current':
        return receivablesDetail.filter((r) => !r.isOverdue);
      case 'factored':
        return receivablesDetail.filter((r) => r.isFactored);
      default:
        return receivablesDetail;
    }
  }, [receivablesDetail, quickFilter]);

  // Export handler
  const handleExport = () => {
    if (!receivablesDetail) return;
    exportToCSV(
      receivablesDetail,
      [
        { header: 'Invoice #', accessor: (r) => r.invoiceNumber ?? '' },
        { header: 'Customer', accessor: (r) => r.customerName },
        { header: 'Load #', accessor: (r) => r.loadOrderNumber },
        { header: 'Amount', accessor: (r) => r.amount },
        { header: 'Days Outstanding', accessor: (r) => r.daysOutstanding },
        { header: 'Status', accessor: (r) => r.status },
        { header: 'Overdue', accessor: (r) => (r.isOverdue ? 'Yes' : 'No') },
      ],
      'receivables',
    );
    toast.success('CSV exported');
  };

  // Aging chart data
  const agingData = receivablesSummary
    ? [
        { name: '0-30', amount: receivablesSummary.agingBuckets.current, fill: AGING_COLORS.current },
        { name: '31-60', amount: receivablesSummary.agingBuckets.days31to60, fill: AGING_COLORS.days31to60 },
        { name: '61-90', amount: receivablesSummary.agingBuckets.days61to90, fill: AGING_COLORS.days61to90 },
        { name: '90+', amount: receivablesSummary.agingBuckets.days90plus, fill: AGING_COLORS.days90plus },
      ]
    : [];

  // ============================================
  // SIDEBAR
  // ============================================

  const sidebar = (
    <ReportIntelligenceSidebar
      subtitle="P&L, receivables, cash flow, and close health signals"
      dateRange={dateRange}
      onExport={handleExport}
    >
      {receivablesSummary && (
        <>
          {/* Summary stats - 3 column */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryStat label="Total Invoiced" value={formatCurrency(receivablesSummary.totalInvoiced)} />
            <SummaryStat label="Total Collected" value={formatCurrency(receivablesSummary.totalCollected)} />
            <SummaryStat label="Outstanding" value={formatCurrency(receivablesSummary.totalOutstanding)} />
          </div>

          {/* Summary stats - 2 column */}
          <div className="grid grid-cols-2 gap-4">
            <SummaryStat label="Overdue" value={formatCurrency(receivablesSummary.totalOverdue)} />
            <SummaryStat
              label="Avg Days to Pay"
              value={receivablesSummary.avgDaysToPay !== null ? `${receivablesSummary.avgDaysToPay} days` : 'N/A'}
            />
          </div>

          {/* Revenue vs Collections Chart */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-semibold">Revenue vs Collections</h4>
              <span className="text-xs text-muted-foreground">Aging buckets</span>
            </div>
            <ChartContainer
              config={{
                current: { label: 'Current (0-30)', color: AGING_COLORS.current },
                days31to60: { label: '31-60 days', color: AGING_COLORS.days31to60 },
                days61to90: { label: '61-90 days', color: AGING_COLORS.days61to90 },
                days90plus: { label: '90+ days', color: AGING_COLORS.days90plus },
              }}
              className="h-[180px] w-full"
            >
              <BarChart data={agingData} margin={{ left: -15 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tickFormatter={(v) => `$${(v / 1000).toFixed(0)}K`} tick={{ fontSize: 10 }} width={50} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="amount" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          </div>

          {/* Revenue Mix */}
          <div>
            <h4 className="text-sm font-semibold mb-3">Collection Overview</h4>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Invoiced</span>
                <span className="font-medium">{formatCurrency(receivablesSummary.totalInvoiced)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Collected</span>
                <span className="font-medium">{formatCurrency(receivablesSummary.totalCollected)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Collection rate</span>
                <span className="font-medium">
                  {receivablesSummary.totalInvoiced > 0
                    ? `${((receivablesSummary.totalCollected / receivablesSummary.totalInvoiced) * 100).toFixed(1)}%`
                    : 'N/A'}
                </span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Outstanding invoices</span>
                <span className="font-medium">{formatNumber(receivablesSummary.outstandingCount)}</span>
              </div>
            </div>
          </div>
        </>
      )}
    </ReportIntelligenceSidebar>
  );

  // ============================================
  // RENDER
  // ============================================

  return (
    <ReportTableLayout sidebar={sidebar}>
      <ReportDataTable<ReceivableRow>
        columns={columns}
        data={filteredData as ReceivableRow[]}
        searchQuery={searchQuery}
        quickFilters={QUICK_FILTERS}
        activeQuickFilter={quickFilter}
        onQuickFilterChange={setQuickFilter}
        isLoading={isLoading}
        emptyMessage="No receivables data found for the selected date range."
      />
    </ReportTableLayout>
  );
}
