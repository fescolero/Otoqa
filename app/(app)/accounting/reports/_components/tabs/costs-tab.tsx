'use client';

import { useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { api } from '@/convex/_generated/api';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { PieChart, Pie, Cell, Legend } from 'recharts';
import { formatCurrency, formatNumber } from '@/lib/utils/format';
import { exportToCSV } from '@/lib/csv-export';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

import { ReportTableLayout } from '../shared/report-table-layout';
import { ReportIntelligenceSidebar } from '../shared/report-intelligence-sidebar';
import { ReportDataTable, getSelectColumn, SortableHeader } from '../shared/report-data-table';
import { SummaryStat } from '../shared/summary-stat';
import type { TabComponentProps } from '../shared/types';

// ============================================
// TYPES
// ============================================

interface DriverCostRow {
  driverId: string;
  name: string;
  totalPay: number;
  totalMiles: number;
  loadCount: number;
  avgPayPerLoad: number;
  avgCostPerMile: number;
}

interface CarrierCostRow {
  carrierId: string;
  name: string;
  totalPay: number;
  loadCount: number;
  avgPayPerLoad: number;
}

type CostView = 'driver' | 'carrier';

const CHART_COLORS = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))', 'hsl(var(--chart-4))'];

// ============================================
// COLUMNS
// ============================================

const driverColumns: ColumnDef<DriverCostRow, unknown>[] = [
  getSelectColumn<DriverCostRow>(),
  {
    accessorKey: 'name',
    header: 'Driver',
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: 'loadCount',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Loads
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatNumber(row.original.loadCount)}</span>,
  },
  {
    accessorKey: 'totalMiles',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Miles
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatNumber(row.original.totalMiles)}</span>,
  },
  {
    accessorKey: 'totalPay',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Total Pay
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.totalPay)}</span>,
  },
  {
    accessorKey: 'avgPayPerLoad',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Avg Pay/Load
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.avgPayPerLoad)}</span>,
  },
  {
    accessorKey: 'avgCostPerMile',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Avg Cost/Mile
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.avgCostPerMile)}</span>,
  },
];

const carrierColumns: ColumnDef<CarrierCostRow, unknown>[] = [
  getSelectColumn<CarrierCostRow>(),
  {
    accessorKey: 'name',
    header: 'Carrier',
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: 'loadCount',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Loads
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatNumber(row.original.loadCount)}</span>,
  },
  {
    accessorKey: 'totalPay',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Total Pay
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.totalPay)}</span>,
  },
  {
    accessorKey: 'avgPayPerLoad',
    header: ({ column }) => (
      <SortableHeader column={column} className="justify-end">
        Avg Pay/Load
      </SortableHeader>
    ),
    cell: ({ row }) => <span className="text-right block">{formatCurrency(row.original.avgPayPerLoad)}</span>,
  },
];

// ============================================
// COMPONENT
// ============================================

export function CostsTab({ organizationId, dateRange, searchQuery }: TabComponentProps) {
  const [costView, setCostView] = useState<CostView>('driver');

  const costSummary = useAuthQuery(api.accountingReports.getCostSummary, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const costByDriver = useAuthQuery(api.accountingReports.getCostByDriver, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const costByCarrier = useAuthQuery(api.accountingReports.getCostByCarrier, {
    workosOrgId: organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  });

  const isLoading = !costSummary || (costView === 'driver' ? !costByDriver : !costByCarrier);

  const handleExport = () => {
    if (costView === 'driver' && costByDriver) {
      exportToCSV(
        costByDriver,
        [
          { header: 'Driver', accessor: (r) => r.name },
          { header: 'Loads', accessor: (r) => r.loadCount },
          { header: 'Miles', accessor: (r) => r.totalMiles },
          { header: 'Total Pay', accessor: (r) => r.totalPay },
          { header: 'Avg Pay/Load', accessor: (r) => r.avgPayPerLoad },
          { header: 'Avg Cost/Mile', accessor: (r) => r.avgCostPerMile },
        ],
        'cost-by-driver',
      );
      toast.success('CSV exported');
    } else if (costView === 'carrier' && costByCarrier) {
      exportToCSV(
        costByCarrier,
        [
          { header: 'Carrier', accessor: (r) => r.name },
          { header: 'Loads', accessor: (r) => r.loadCount },
          { header: 'Total Pay', accessor: (r) => r.totalPay },
          { header: 'Avg Pay/Load', accessor: (r) => r.avgPayPerLoad },
        ],
        'cost-by-carrier',
      );
      toast.success('CSV exported');
    }
  };

  // Cost breakdown pie data
  const pieData = useMemo(() => {
    if (!costSummary) return [];
    return [
      { name: 'Driver Pay', value: costSummary.totalDriverPay, color: CHART_COLORS[0] },
      { name: 'Carrier Pay', value: costSummary.totalCarrierPay, color: CHART_COLORS[1] },
      { name: 'Fuel', value: costSummary.totalFuel, color: CHART_COLORS[2] },
      { name: 'DEF', value: costSummary.totalDef, color: CHART_COLORS[3] },
    ].filter((d) => d.value > 0);
  }, [costSummary]);

  // ============================================
  // SIDEBAR
  // ============================================

  const sidebar = (
    <ReportIntelligenceSidebar
      subtitle="Cost analysis by driver, carrier, fuel, and DEF"
      dateRange={dateRange}
      onExport={handleExport}
    >
      {costSummary && (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryStat label="Driver Pay" value={formatCurrency(costSummary.totalDriverPay)} />
            <SummaryStat label="Carrier Pay" value={formatCurrency(costSummary.totalCarrierPay)} />
            <SummaryStat label="Fuel" value={formatCurrency(costSummary.totalFuel)} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <SummaryStat label="DEF" value={formatCurrency(costSummary.totalDef)} />
            <SummaryStat label="Total Costs" value={formatCurrency(costSummary.totalCosts)} />
          </div>

          {/* Cost Breakdown Pie Chart */}
          {pieData.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Cost Breakdown</h4>
              <ChartContainer
                config={{
                  driverPay: { label: 'Driver Pay', color: CHART_COLORS[0] },
                  carrierPay: { label: 'Carrier Pay', color: CHART_COLORS[1] },
                  fuel: { label: 'Fuel', color: CHART_COLORS[2] },
                  def: { label: 'DEF', color: CHART_COLORS[3] },
                }}
                className="h-[200px] w-full"
              >
                <PieChart>
                  <Pie data={pieData} cx="50%" cy="50%" outerRadius={75} innerRadius={30} dataKey="value">
                    {pieData.map((entry, index) => (
                      <Cell key={index} fill={entry.color} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ChartContainer>
            </div>
          )}

          {/* Top Cost Drivers */}
          {costView === 'driver' && costByDriver && costByDriver.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Top Cost Drivers</h4>
              <div className="space-y-2">
                {costByDriver.slice(0, 5).map((d) => (
                  <div key={d.driverId} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate mr-2">{d.name}</span>
                    <span className="font-medium shrink-0">{formatCurrency(d.totalPay)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {costView === 'carrier' && costByCarrier && costByCarrier.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-3">Top Carrier Costs</h4>
              <div className="space-y-2">
                {costByCarrier.slice(0, 5).map((c) => (
                  <div key={c.carrierId} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate mr-2">{c.name}</span>
                    <span className="font-medium shrink-0">{formatCurrency(c.totalPay)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {costSummary.avgCostPerMile > 0 && (
            <div className="text-sm">
              <span className="text-muted-foreground">Avg cost per mile: </span>
              <span className="font-medium">{formatCurrency(costSummary.avgCostPerMile)}</span>
            </div>
          )}
        </>
      )}
    </ReportIntelligenceSidebar>
  );

  // ============================================
  // RENDER
  // ============================================

  return (
    <ReportTableLayout sidebar={sidebar}>
      <div className="space-y-0">
        {/* Sub-view toggle */}
        <div className="flex items-center gap-2 mb-4">
          <div className="flex items-center rounded-md border bg-background">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-8 rounded-r-none text-sm px-4 border-r',
                costView === 'driver' &&
                  'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
              )}
              onClick={() => setCostView('driver')}
            >
              By Driver
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-8 rounded-l-none text-sm px-4',
                costView === 'carrier' &&
                  'bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground',
              )}
              onClick={() => setCostView('carrier')}
            >
              By Carrier
            </Button>
          </div>
        </div>

        {/* Table */}
        {costView === 'driver' ? (
          <ReportDataTable<DriverCostRow>
            columns={driverColumns}
            data={(costByDriver ?? []) as DriverCostRow[]}
            searchQuery={searchQuery}
            isLoading={isLoading}
            emptyMessage="No driver cost data found for the selected date range."
          />
        ) : (
          <ReportDataTable<CarrierCostRow>
            columns={carrierColumns}
            data={(costByCarrier ?? []) as CarrierCostRow[]}
            searchQuery={searchQuery}
            isLoading={isLoading}
            emptyMessage="No carrier cost data found for the selected date range."
          />
        )}
      </div>
    </ReportTableLayout>
  );
}
