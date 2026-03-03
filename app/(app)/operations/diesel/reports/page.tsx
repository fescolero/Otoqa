'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  Legend,
} from 'recharts';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { useState, useMemo } from 'react';
import { CalendarIcon, Download, Loader2 } from 'lucide-react';
import {
  format,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfQuarter,
  startOfYear,
} from 'date-fns';
import { exportToCSV } from '@/lib/csv-export';
import { toast } from 'sonner';

const CHART_COLORS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

type DatePreset = 'this-month' | 'last-month' | 'this-quarter' | 'ytd' | 'custom';

function getDateRange(preset: DatePreset, customStart?: Date, customEnd?: Date) {
  const now = new Date();
  switch (preset) {
    case 'this-month':
      return { start: startOfMonth(now).getTime(), end: endOfMonth(now).getTime() };
    case 'last-month': {
      const last = subMonths(now, 1);
      return { start: startOfMonth(last).getTime(), end: endOfMonth(last).getTime() };
    }
    case 'this-quarter':
      return { start: startOfQuarter(now).getTime(), end: now.getTime() };
    case 'ytd':
      return { start: startOfYear(now).getTime(), end: now.getTime() };
    case 'custom':
      return {
        start: (customStart ?? startOfMonth(now)).getTime(),
        end: (customEnd ?? endOfMonth(now)).getTime(),
      };
  }
}

function fmtCurrency(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtNumber(n: number, decimals = 2) {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

// ---------------------------------------------------------------------------
// Sub-components for each tab
// ---------------------------------------------------------------------------

function ByDriverTab({
  data,
  isLoading,
}: {
  data:
    | Array<{
        driverId: string;
        driverName: string;
        gallons: number;
        totalCost: number;
        avgPricePerGallon: number;
        entries: number;
      }>
    | undefined;
  isLoading: boolean;
}) {
  const chartData = useMemo(
    () => (data ?? []).slice(0, 10).map((d) => ({ name: d.driverName, totalCost: d.totalCost })),
    [data]
  );

  const chartConfig = {
    totalCost: { label: 'Total Cost', color: CHART_COLORS[0] },
  };

  if (isLoading) return <LoadingState />;
  if (!data?.length) return <EmptyState label="driver" />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportButton
          onClick={() =>
            exportToCSV(
              data,
              [
                { header: 'Driver Name', accessor: (r) => r.driverName },
                { header: 'Gallons', accessor: (r) => r.gallons },
                { header: 'Total Cost', accessor: (r) => r.totalCost },
                { header: 'Avg Price/Gal', accessor: (r) => r.avgPricePerGallon },
                { header: 'Entries', accessor: (r) => r.entries },
              ],
              `fuel-by-driver-${format(new Date(), 'yyyy-MM-dd')}`
            )
          }
        />
      </div>

      <ChartContainer config={chartConfig} className="h-[350px] w-full">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 12 }} angle={-30} textAnchor="end" height={80} />
          <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="totalCost" fill={CHART_COLORS[0]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Driver Name</TableHead>
              <TableHead className="text-right">Gallons</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Avg Price/Gal</TableHead>
              <TableHead className="text-right">Entries</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.driverId}>
                <TableCell className="font-medium">{row.driverName}</TableCell>
                <TableCell className="text-right">{fmtNumber(row.gallons)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.totalCost)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.avgPricePerGallon)}</TableCell>
                <TableCell className="text-right">{row.entries}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ByCarrierTab({
  data,
  isLoading,
}: {
  data:
    | Array<{
        carrierId: string;
        carrierName: string;
        gallons: number;
        totalCost: number;
        avgPricePerGallon: number;
        entries: number;
      }>
    | undefined;
  isLoading: boolean;
}) {
  const chartData = useMemo(
    () => (data ?? []).slice(0, 10).map((d) => ({ name: d.carrierName, totalCost: d.totalCost })),
    [data]
  );

  const chartConfig = {
    totalCost: { label: 'Total Cost', color: CHART_COLORS[1] },
  };

  if (isLoading) return <LoadingState />;
  if (!data?.length) return <EmptyState label="carrier" />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportButton
          onClick={() =>
            exportToCSV(
              data,
              [
                { header: 'Carrier Name', accessor: (r) => r.carrierName },
                { header: 'Gallons', accessor: (r) => r.gallons },
                { header: 'Total Cost', accessor: (r) => r.totalCost },
                { header: 'Avg Price/Gal', accessor: (r) => r.avgPricePerGallon },
                { header: 'Entries', accessor: (r) => r.entries },
              ],
              `fuel-by-carrier-${format(new Date(), 'yyyy-MM-dd')}`
            )
          }
        />
      </div>

      <ChartContainer config={chartConfig} className="h-[350px] w-full">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 12 }} angle={-30} textAnchor="end" height={80} />
          <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="totalCost" fill={CHART_COLORS[1]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Carrier Name</TableHead>
              <TableHead className="text-right">Gallons</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Avg Price/Gal</TableHead>
              <TableHead className="text-right">Entries</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.carrierId}>
                <TableCell className="font-medium">{row.carrierName}</TableCell>
                <TableCell className="text-right">{fmtNumber(row.gallons)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.totalCost)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.avgPricePerGallon)}</TableCell>
                <TableCell className="text-right">{row.entries}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ByTruckTab({
  data,
  isLoading,
}: {
  data:
    | Array<{
        truckId: string;
        unitId: string;
        make?: string;
        model?: string;
        gallons: number;
        totalCost: number;
        avgPricePerGallon: number;
        entries: number;
      }>
    | undefined;
  isLoading: boolean;
}) {
  const chartData = useMemo(
    () => (data ?? []).slice(0, 10).map((d) => ({ name: d.unitId, totalCost: d.totalCost })),
    [data]
  );

  const chartConfig = {
    totalCost: { label: 'Total Cost', color: CHART_COLORS[2] },
  };

  if (isLoading) return <LoadingState />;
  if (!data?.length) return <EmptyState label="truck" />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportButton
          onClick={() =>
            exportToCSV(
              data,
              [
                { header: 'Unit ID', accessor: (r) => r.unitId },
                { header: 'Make', accessor: (r) => r.make ?? '' },
                { header: 'Model', accessor: (r) => r.model ?? '' },
                { header: 'Gallons', accessor: (r) => r.gallons },
                { header: 'Total Cost', accessor: (r) => r.totalCost },
                { header: 'Avg Price/Gal', accessor: (r) => r.avgPricePerGallon },
                { header: 'Entries', accessor: (r) => r.entries },
              ],
              `fuel-by-truck-${format(new Date(), 'yyyy-MM-dd')}`
            )
          }
        />
      </div>

      <ChartContainer config={chartConfig} className="h-[350px] w-full">
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 12 }} angle={-30} textAnchor="end" height={80} />
          <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="totalCost" fill={CHART_COLORS[2]} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Unit ID</TableHead>
              <TableHead>Make / Model</TableHead>
              <TableHead className="text-right">Gallons</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Avg Price/Gal</TableHead>
              <TableHead className="text-right">Entries</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.truckId}>
                <TableCell className="font-medium">{row.unitId}</TableCell>
                <TableCell>
                  {[row.make, row.model].filter(Boolean).join(' ') || '—'}
                </TableCell>
                <TableCell className="text-right">{fmtNumber(row.gallons)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.totalCost)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.avgPricePerGallon)}</TableCell>
                <TableCell className="text-right">{row.entries}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ByVendorTab({
  data,
  isLoading,
}: {
  data:
    | Array<{
        vendorId: string;
        vendorName: string;
        gallons: number;
        totalCost: number;
        avgPricePerGallon: number;
        entries: number;
      }>
    | undefined;
  isLoading: boolean;
}) {
  const chartData = useMemo(
    () => (data ?? []).map((d, i) => ({ name: d.vendorName, value: d.totalCost, fill: CHART_COLORS[i % CHART_COLORS.length] })),
    [data]
  );

  const chartConfig = (data ?? []).reduce(
    (acc, d, i) => {
      acc[d.vendorName] = { label: d.vendorName, color: CHART_COLORS[i % CHART_COLORS.length] };
      return acc;
    },
    {} as Record<string, { label: string; color: string }>
  );

  if (isLoading) return <LoadingState />;
  if (!data?.length) return <EmptyState label="vendor" />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportButton
          onClick={() =>
            exportToCSV(
              data,
              [
                { header: 'Vendor Name', accessor: (r) => r.vendorName },
                { header: 'Gallons', accessor: (r) => r.gallons },
                { header: 'Total Cost', accessor: (r) => r.totalCost },
                { header: 'Avg Price/Gal', accessor: (r) => r.avgPricePerGallon },
                { header: 'Entries', accessor: (r) => r.entries },
              ],
              `fuel-by-vendor-${format(new Date(), 'yyyy-MM-dd')}`
            )
          }
        />
      </div>

      <ChartContainer config={chartConfig} className="mx-auto h-[350px] w-full max-w-lg">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent />} />
          <Pie data={chartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={130} label>
            {chartData.map((entry, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Legend />
        </PieChart>
      </ChartContainer>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vendor Name</TableHead>
              <TableHead className="text-right">Gallons</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Avg Price/Gal</TableHead>
              <TableHead className="text-right">Entries</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.vendorId}>
                <TableCell className="font-medium">{row.vendorName}</TableCell>
                <TableCell className="text-right">{fmtNumber(row.gallons)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.totalCost)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.avgPricePerGallon)}</TableCell>
                <TableCell className="text-right">{row.entries}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function CostPerMileTab({
  data,
  isLoading,
}: {
  data:
    | Array<{
        truckId: string;
        unitId: string;
        make?: string;
        model?: string;
        totalCost: number;
        totalGallons: number;
        totalMiles: number;
        costPerMile: number;
        milesSource: 'odometer' | 'loads' | 'none';
      }>
    | undefined;
  isLoading: boolean;
}) {
  if (isLoading) return <LoadingState />;
  if (!data?.length) return <EmptyState label="cost per mile" />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportButton
          onClick={() =>
            exportToCSV(
              data,
              [
                { header: 'Unit ID', accessor: (r) => r.unitId },
                { header: 'Make', accessor: (r) => r.make ?? '' },
                { header: 'Model', accessor: (r) => r.model ?? '' },
                { header: 'Total Cost', accessor: (r) => r.totalCost },
                { header: 'Total Gallons', accessor: (r) => r.totalGallons },
                { header: 'Total Miles', accessor: (r) => r.totalMiles },
                { header: 'Cost/Mile', accessor: (r) => r.costPerMile },
                { header: 'Miles Source', accessor: (r) => r.milesSource },
              ],
              `cost-per-mile-${format(new Date(), 'yyyy-MM-dd')}`
            )
          }
        />
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Unit ID</TableHead>
              <TableHead>Make / Model</TableHead>
              <TableHead className="text-right">Total Cost</TableHead>
              <TableHead className="text-right">Total Gallons</TableHead>
              <TableHead className="text-right">Total Miles</TableHead>
              <TableHead className="text-right">Cost/Mile</TableHead>
              <TableHead>Miles Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row) => (
              <TableRow key={row.truckId}>
                <TableCell className="font-medium">{row.unitId}</TableCell>
                <TableCell>
                  {[row.make, row.model].filter(Boolean).join(' ') || '—'}
                </TableCell>
                <TableCell className="text-right">{fmtCurrency(row.totalCost)}</TableCell>
                <TableCell className="text-right">{fmtNumber(row.totalGallons)}</TableCell>
                <TableCell className="text-right">{fmtNumber(row.totalMiles, 0)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.costPerMile)}</TableCell>
                <TableCell>
                  <Badge variant={row.milesSource === 'none' ? 'secondary' : 'outline'}>
                    {row.milesSource}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function DefUsageTab({
  data,
  isLoading,
  groupBy,
  onGroupByChange,
}: {
  data:
    | Array<{
        id: string;
        name: string;
        groupBy: string;
        gallons: number;
        totalCost: number;
        avgPricePerGallon: number;
        entries: number;
      }>
    | undefined;
  isLoading: boolean;
  groupBy: 'driver' | 'carrier' | 'truck';
  onGroupByChange: (v: 'driver' | 'carrier' | 'truck') => void;
}) {
  if (isLoading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Select value={groupBy} onValueChange={(v) => onGroupByChange(v as 'driver' | 'carrier' | 'truck')}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="driver">By Driver</SelectItem>
            <SelectItem value="carrier">By Carrier</SelectItem>
            <SelectItem value="truck">By Truck</SelectItem>
          </SelectContent>
        </Select>

        {data && data.length > 0 && (
          <ExportButton
            onClick={() =>
              exportToCSV(
                data,
                [
                  { header: 'Name', accessor: (r) => r.name },
                  { header: 'Gallons', accessor: (r) => r.gallons },
                  { header: 'Total Cost', accessor: (r) => r.totalCost },
                  { header: 'Avg Price/Gal', accessor: (r) => r.avgPricePerGallon },
                  { header: 'Entries', accessor: (r) => r.entries },
                ],
                `def-usage-by-${groupBy}-${format(new Date(), 'yyyy-MM-dd')}`
              )
            }
          />
        )}
      </div>

      {!data?.length ? (
        <EmptyState label="DEF usage" />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Gallons</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
                <TableHead className="text-right">Avg Price/Gal</TableHead>
                <TableHead className="text-right">Entries</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell className="text-right">{fmtNumber(row.gallons)}</TableCell>
                  <TableCell className="text-right">{fmtCurrency(row.totalCost)}</TableCell>
                  <TableCell className="text-right">{fmtCurrency(row.avgPricePerGallon)}</TableCell>
                  <TableCell className="text-right">{row.entries}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function MonthlySummaryTab({
  data,
  isLoading,
}: {
  data:
    | {
        totals: {
          totalFuelGallons: number;
          totalFuelCost: number;
          totalDefGallons: number;
          totalDefCost: number;
        };
        months: Array<{
          month: string;
          fuelGallons: number;
          fuelCost: number;
          fuelEntries: number;
          avgFuelPrice: number;
          defGallons: number;
          defCost: number;
          defEntries: number;
        }>;
      }
    | undefined;
  isLoading: boolean;
}) {
  const chartConfig = {
    fuelCost: { label: 'Fuel Cost', color: CHART_COLORS[0] },
    defCost: { label: 'DEF Cost', color: CHART_COLORS[3] },
  };

  if (isLoading) return <LoadingState />;
  if (!data?.months?.length) return <EmptyState label="monthly summary" />;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <ExportButton
          onClick={() =>
            exportToCSV(
              data.months,
              [
                { header: 'Month', accessor: (r) => r.month },
                { header: 'Fuel Gallons', accessor: (r) => r.fuelGallons },
                { header: 'Fuel Cost', accessor: (r) => r.fuelCost },
                { header: 'Avg Fuel Price', accessor: (r) => r.avgFuelPrice },
                { header: 'DEF Gallons', accessor: (r) => r.defGallons },
                { header: 'DEF Cost', accessor: (r) => r.defCost },
              ],
              `monthly-summary-${format(new Date(), 'yyyy-MM-dd')}`
            )
          }
        />
      </div>

      <ChartContainer config={chartConfig} className="h-[350px] w-full">
        <LineChart data={data.months}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="month" tick={{ fontSize: 12 }} />
          <YAxis tickFormatter={(v) => `$${v.toLocaleString()}`} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Legend />
          <Line type="monotone" dataKey="fuelCost" stroke={CHART_COLORS[0]} strokeWidth={2} dot={{ r: 4 }} />
          <Line type="monotone" dataKey="defCost" stroke={CHART_COLORS[3]} strokeWidth={2} dot={{ r: 4 }} />
        </LineChart>
      </ChartContainer>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead className="text-right">Fuel Gallons</TableHead>
              <TableHead className="text-right">Fuel Cost</TableHead>
              <TableHead className="text-right">Avg Fuel Price</TableHead>
              <TableHead className="text-right">DEF Gallons</TableHead>
              <TableHead className="text-right">DEF Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.months.map((row) => (
              <TableRow key={row.month}>
                <TableCell className="font-medium">{row.month}</TableCell>
                <TableCell className="text-right">{fmtNumber(row.fuelGallons)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.fuelCost)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.avgFuelPrice)}</TableCell>
                <TableCell className="text-right">{fmtNumber(row.defGallons)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(row.defCost)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function LoadingState() {
  return (
    <div className="flex items-center justify-center py-20">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      <span className="ml-2 text-sm text-muted-foreground">Loading report data…</span>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
      <p className="text-sm">No {label} data found for the selected date range.</p>
    </div>
  );
}

function ExportButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => {
        onClick();
        toast.success('CSV exported');
      }}
    >
      <Download className="mr-2 h-4 w-4" />
      Export CSV
    </Button>
  );
}

function SummaryCard({ title, value, subtitle }: { title: string; value: string; subtitle?: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-bold tracking-tight">{value}</p>
      {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page component
// ---------------------------------------------------------------------------

export default function FuelReportsPage() {
  const organizationId = useOrganizationId();

  const [preset, setPreset] = useState<DatePreset>('this-month');
  const [customStart, setCustomStart] = useState<Date | undefined>(undefined);
  const [customEnd, setCustomEnd] = useState<Date | undefined>(undefined);
  const [defGroupBy, setDefGroupBy] = useState<'driver' | 'carrier' | 'truck'>('driver');

  const dateRange = useMemo(
    () => getDateRange(preset, customStart, customEnd),
    [preset, customStart, customEnd]
  );

  const baseArgs = {
    organizationId,
    dateRangeStart: dateRange.start,
    dateRangeEnd: dateRange.end,
  };

  const summaryData = useAuthQuery(api.fuelReports.monthlySummary, baseArgs);
  const byDriverData = useAuthQuery(api.fuelReports.fuelByDriver, baseArgs);
  const byCarrierData = useAuthQuery(api.fuelReports.fuelByCarrier, baseArgs);
  const byTruckData = useAuthQuery(api.fuelReports.fuelByTruck, baseArgs);
  const byVendorData = useAuthQuery(api.fuelReports.fuelByVendor, baseArgs);
  const costPerMileData = useAuthQuery(api.fuelReports.costPerMile, baseArgs);
  const defUsageData = useAuthQuery(api.fuelReports.defUsage, {
    ...baseArgs,
    groupBy: defGroupBy,
  });

  const totals = summaryData?.totals;

  const presetButtons: Array<{ label: string; value: DatePreset }> = [
    { label: 'This Month', value: 'this-month' },
    { label: 'Last Month', value: 'last-month' },
    { label: 'This Quarter', value: 'this-quarter' },
    { label: 'YTD', value: 'ytd' },
  ];

  return (
    <>
      <header className="flex h-16 shrink-0 items-center gap-2 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 border-b">
        <div className="flex items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-2 data-[orientation=vertical]:h-4" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="/dashboard">Home</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink href="#">Company Operations</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>Fuel Reports</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </div>
      </header>

      <div className="flex-1 overflow-auto">
        <div className="p-6 space-y-6">
          {/* Page title */}
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Fuel Reports</h1>
            <p className="text-muted-foreground">
              Analyze fuel and DEF spending across drivers, carriers, trucks, and vendors
            </p>
          </div>

          {/* Date range filter */}
          <div className="flex flex-wrap items-center gap-2">
            {presetButtons.map((btn) => (
              <Button
                key={btn.value}
                variant={preset === btn.value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setPreset(btn.value)}
              >
                {btn.label}
              </Button>
            ))}

            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-6" />

            <Popover>
              <PopoverTrigger asChild>
                <Button variant={preset === 'custom' ? 'default' : 'outline'} size="sm">
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {preset === 'custom' && customStart
                    ? format(customStart, 'MMM d, yyyy')
                    : 'Start date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={customStart}
                  onSelect={(d) => {
                    setCustomStart(d);
                    setPreset('custom');
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            <span className="text-sm text-muted-foreground">to</span>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant={preset === 'custom' ? 'default' : 'outline'} size="sm">
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {preset === 'custom' && customEnd
                    ? format(customEnd, 'MMM d, yyyy')
                    : 'End date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={customEnd}
                  onSelect={(d) => {
                    setCustomEnd(d);
                    setPreset('custom');
                  }}
                  initialFocus
                />
              </PopoverContent>
            </Popover>

            <Badge variant="secondary" className="ml-2 text-xs font-normal">
              {format(new Date(dateRange.start), 'MMM d, yyyy')} –{' '}
              {format(new Date(dateRange.end), 'MMM d, yyyy')}
            </Badge>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
            <SummaryCard
              title="Total Fuel Gallons"
              value={totals ? fmtNumber(totals.totalFuelGallons) : '—'}
            />
            <SummaryCard
              title="Total Fuel Spend"
              value={totals ? fmtCurrency(totals.totalFuelCost) : '—'}
            />
            <SummaryCard
              title="Avg Fuel Price/Gal"
              value={totals ? fmtCurrency(totals.avgFuelPricePerGallon) : '—'}
            />
            <SummaryCard
              title="Total DEF Gallons"
              value={totals ? fmtNumber(totals.totalDefGallons) : '—'}
            />
            <SummaryCard
              title="Total DEF Spend"
              value={totals ? fmtCurrency(totals.totalDefCost) : '—'}
            />
          </div>

          {/* Report tabs */}
          <Tabs defaultValue="by-driver" className="space-y-4">
            <TabsList className="flex-wrap h-auto gap-1">
              <TabsTrigger value="by-driver">By Driver</TabsTrigger>
              <TabsTrigger value="by-carrier">By Carrier</TabsTrigger>
              <TabsTrigger value="by-truck">By Truck</TabsTrigger>
              <TabsTrigger value="by-vendor">By Vendor</TabsTrigger>
              <TabsTrigger value="cost-per-mile">Cost Per Mile</TabsTrigger>
              <TabsTrigger value="def-usage">DEF Usage</TabsTrigger>
              <TabsTrigger value="monthly-summary">Monthly Summary</TabsTrigger>
            </TabsList>

            <TabsContent value="by-driver">
              <ByDriverTab data={byDriverData} isLoading={!byDriverData && !!organizationId} />
            </TabsContent>

            <TabsContent value="by-carrier">
              <ByCarrierTab data={byCarrierData} isLoading={!byCarrierData && !!organizationId} />
            </TabsContent>

            <TabsContent value="by-truck">
              <ByTruckTab data={byTruckData} isLoading={!byTruckData && !!organizationId} />
            </TabsContent>

            <TabsContent value="by-vendor">
              <ByVendorTab data={byVendorData} isLoading={!byVendorData && !!organizationId} />
            </TabsContent>

            <TabsContent value="cost-per-mile">
              <CostPerMileTab data={costPerMileData} isLoading={!costPerMileData && !!organizationId} />
            </TabsContent>

            <TabsContent value="def-usage">
              <DefUsageTab
                data={defUsageData}
                isLoading={!defUsageData && !!organizationId}
                groupBy={defGroupBy}
                onGroupByChange={setDefGroupBy}
              />
            </TabsContent>

            <TabsContent value="monthly-summary">
              <MonthlySummaryTab data={summaryData} isLoading={!summaryData && !!organizationId} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}
