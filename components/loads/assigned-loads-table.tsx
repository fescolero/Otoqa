'use client';

import { useRef, useState, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Id } from '@/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ArrowRight, Loader2, Package, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { formatDateOnly } from '@/lib/format-date-timezone';

function toTitleCase(str: string | undefined): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export type AssignedLoadStatus = 'Assigned' | 'Completed' | 'Canceled' | 'Expired';
export type TimeHorizon = 'all' | '24h' | '48h' | '72h';

export interface AssignedLoad {
  _id: Id<'loadInformation'>;
  orderNumber: string;
  customerName?: string;
  status: string;
  trackingStatus: string;
  stopsCount: number;
  origin?: { city?: string; state?: string } | null;
  destination?: { city?: string; state?: string } | null;
  firstStopDate?: string;
  parsedHcr?: string;
  parsedTripNumber?: string;
  legStatus: string;
  legLoadedMiles: number;
  carrierRate?: number;
  createdAt: number;
}

interface AssignedLoadsTableProps {
  loads: AssignedLoad[];
  isLoading: boolean;
  statusFilter: AssignedLoadStatus;
  onStatusFilterChange: (status: AssignedLoadStatus) => void;
  showCarrierRate?: boolean;
}

type ColumnKey = 'orderNumber' | 'customer' | 'hcr' | 'trip' | 'route' | 'stops' | 'status' | 'tracking' | 'loadDate' | 'carrierRate';

interface ColumnDef {
  key: ColumnKey;
  label: string;
  flex: string;
  align?: 'center' | 'right';
  alwaysVisible?: boolean;
  defaultVisible: boolean;
  requiresCarrierRate?: boolean;
}

const ALL_COLUMNS: ColumnDef[] = [
  { key: 'orderNumber', label: 'Order #', flex: 'flex-[1.2]', alwaysVisible: true, defaultVisible: true },
  { key: 'customer', label: 'Customer', flex: 'flex-[1.5]', defaultVisible: true },
  { key: 'hcr', label: 'HCR', flex: 'flex-[0.8]', defaultVisible: true },
  { key: 'trip', label: 'Trip #', flex: 'flex-[0.8]', defaultVisible: true },
  { key: 'route', label: 'Route', flex: 'flex-[2.5]', defaultVisible: true },
  { key: 'stops', label: 'Stops', flex: 'flex-[0.7]', align: 'center', defaultVisible: true },
  { key: 'status', label: 'Status', flex: 'flex-1', defaultVisible: true },
  { key: 'tracking', label: 'Tracking', flex: 'flex-1', defaultVisible: true },
  { key: 'loadDate', label: 'Load Date', flex: 'flex-[1.2]', defaultVisible: true },
  { key: 'carrierRate', label: 'Rate', flex: 'flex-1', align: 'right', defaultVisible: true, requiresCarrierRate: true },
];

function getStatusColor(status: string) {
  const displayStatus = status === 'Completed' ? 'Delivered' : status;
  switch (displayStatus) {
    case 'Delivered':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'Assigned':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'Open':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
    case 'Expired':
      return 'bg-orange-100 text-orange-800 border-orange-200';
    case 'Canceled':
      return 'bg-gray-100 text-gray-800 border-gray-200';
    default:
      return 'bg-gray-100 text-gray-800 border-gray-200';
  }
}

function getTrackingColor(status: string) {
  switch (status) {
    case 'Completed':
      return 'bg-green-100 text-green-700';
    case 'In Transit':
      return 'bg-blue-100 text-blue-700';
    case 'Delayed':
      return 'bg-red-100 text-red-700';
    case 'Pending':
      return 'bg-gray-100 text-gray-700';
    default:
      return 'bg-gray-100 text-gray-700';
  }
}

function getDisplayStatus(status: string) {
  return status === 'Completed' ? 'Delivered' : status;
}

const STATUS_OPTIONS: { value: AssignedLoadStatus; label: string }[] = [
  { value: 'Assigned', label: 'Assigned' },
  { value: 'Completed', label: 'Delivered' },
  { value: 'Canceled', label: 'Canceled' },
  { value: 'Expired', label: 'Expired' },
];

const TIME_OPTIONS: { value: TimeHorizon; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: '24h', label: 'Next 24h' },
  { value: '48h', label: 'Next 48h' },
  { value: '72h', label: 'Next 72h' },
];

function isWithinHorizon(firstStopDate: string | undefined, horizon: TimeHorizon): boolean {
  if (!firstStopDate || horizon === 'all') return true;

  const now = new Date();
  const stopDate = new Date(firstStopDate + 'T23:59:59');

  const hoursMap: Record<string, number> = { '24h': 24, '48h': 48, '72h': 72 };
  const cutoff = new Date(now.getTime() + hoursMap[horizon] * 60 * 60 * 1000);

  return stopDate >= now && stopDate <= cutoff;
}

function getDefaultVisibility(showCarrierRate: boolean): Record<ColumnKey, boolean> {
  const vis: Record<string, boolean> = {};
  for (const col of ALL_COLUMNS) {
    if (col.requiresCarrierRate && !showCarrierRate) continue;
    vis[col.key] = col.defaultVisible;
  }
  return vis as Record<ColumnKey, boolean>;
}

export function AssignedLoadsTable({
  loads,
  isLoading,
  statusFilter,
  onStatusFilterChange,
  showCarrierRate = false,
}: AssignedLoadsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [timeHorizon, setTimeHorizon] = useState<TimeHorizon>('all');
  const [columnVisibility, setColumnVisibility] = useState<Record<ColumnKey, boolean>>(
    () => getDefaultVisibility(showCarrierRate)
  );

  const toggleColumn = useCallback((key: ColumnKey) => {
    setColumnVisibility(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const visibleColumns = useMemo(() => {
    return ALL_COLUMNS.filter(col => {
      if (col.requiresCarrierRate && !showCarrierRate) return false;
      return columnVisibility[col.key] !== false;
    });
  }, [columnVisibility, showCarrierRate]);

  const toggleableColumns = useMemo(() => {
    return ALL_COLUMNS.filter(col => {
      if (col.alwaysVisible) return false;
      if (col.requiresCarrierRate && !showCarrierRate) return false;
      return true;
    });
  }, [showCarrierRate]);

  const filteredLoads = useMemo(() => {
    if (statusFilter !== 'Assigned' || timeHorizon === 'all') return loads;
    return loads.filter(load => isWithinHorizon(load.firstStopDate, timeHorizon));
  }, [loads, statusFilter, timeHorizon]);

  const rowVirtualizer = useVirtualizer({
    count: filteredLoads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  });

  const renderCell = (col: ColumnDef, load: AssignedLoad) => {
    switch (col.key) {
      case 'orderNumber':
        return (
          <Link
            href={`/loads/${load._id}`}
            className="font-mono text-sm font-medium text-blue-600 hover:text-blue-800"
          >
            {load.orderNumber}
          </Link>
        );
      case 'customer':
        return (
          <div className="text-sm font-medium min-w-0">
            <div className="truncate">{load.customerName || 'Unknown'}</div>
          </div>
        );
      case 'hcr':
        return (
          <span className="text-sm font-medium">{load.parsedHcr || '—'}</span>
        );
      case 'trip':
        return (
          <span className="text-sm font-medium">{load.parsedTripNumber || '—'}</span>
        );
      case 'route':
        return load.origin && load.destination ? (
          <div className="flex items-center gap-2 text-sm overflow-hidden">
            <span className="font-medium whitespace-nowrap truncate">
              {toTitleCase(load.origin.city)}, {load.origin.state}
            </span>
            <ArrowRight className="h-3 w-3 text-muted-foreground flex-shrink-0" />
            <span className="font-medium whitespace-nowrap truncate">
              {toTitleCase(load.destination.city)}, {load.destination.state}
            </span>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">N/A</span>
        );
      case 'stops':
        return (
          <Badge variant="outline" className="font-mono">
            {load.stopsCount}
          </Badge>
        );
      case 'status':
        return (
          <Badge variant="outline" className={getStatusColor(load.status)}>
            {getDisplayStatus(load.status)}
          </Badge>
        );
      case 'tracking':
        return (
          <Badge variant="secondary" className={getTrackingColor(load.trackingStatus)}>
            {load.trackingStatus}
          </Badge>
        );
      case 'loadDate':
        return (
          <span className="text-sm text-muted-foreground">
            {load.firstStopDate
              ? formatDateOnly(load.firstStopDate).display
              : (() => {
                  const d = new Date(load.createdAt);
                  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                  return formatDateOnly(dateStr).display;
                })()}
          </span>
        );
      case 'carrierRate':
        return (
          <span className="text-sm font-medium">
            {load.carrierRate != null
              ? `$${load.carrierRate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '—'}
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Filter Bar */}
      <div className="flex items-center justify-between flex-wrap gap-4 flex-shrink-0">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Status Pills */}
          <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
            {STATUS_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => {
                  onStatusFilterChange(opt.value);
                  if (opt.value !== 'Assigned') setTimeHorizon('all');
                }}
                className={cn(
                  'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                  statusFilter === opt.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Time Horizon Pills - only for Assigned */}
          {statusFilter === 'Assigned' && (
            <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
              {TIME_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => setTimeHorizon(opt.value)}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    timeHorizon === opt.value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Column Visibility Toggle */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {toggleableColumns.map(col => (
              <DropdownMenuCheckboxItem
                key={col.key}
                checked={columnVisibility[col.key] !== false}
                onCheckedChange={() => toggleColumn(col.key)}
              >
                {col.label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Table */}
      <div className="border rounded-lg flex flex-col" style={{ height: 'calc(100vh - 280px)', minHeight: '300px' }}>
        {/* Header */}
        <div className="flex-shrink-0 border-b bg-background">
          <div className="flex items-center h-10 w-full">
            {visibleColumns.map(col => (
              <div
                key={col.key}
                className={cn(
                  'px-4 font-medium text-muted-foreground text-sm',
                  col.flex,
                  col.align === 'center' && 'text-center',
                  col.align === 'right' && 'text-right',
                )}
              >
                {col.label}
              </div>
            ))}
          </div>
        </div>

        {/* Loading State */}
        {isLoading && (
          <div className="flex-1 flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Empty State */}
        {!isLoading && filteredLoads.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center py-12 text-muted-foreground">
            <Package className="h-10 w-10 mb-3 opacity-40" />
            <p className="text-sm font-medium">No loads found</p>
            <p className="text-xs mt-1">
              {timeHorizon !== 'all'
                ? `No loads with pickup in the next ${timeHorizon.replace('h', ' hours')}`
                : statusFilter === 'Assigned'
                  ? 'No active loads assigned'
                  : statusFilter === 'Completed'
                    ? 'No delivered loads yet'
                    : statusFilter === 'Expired'
                      ? 'No expired loads'
                      : 'No canceled loads'}
            </p>
          </div>
        )}

        {/* Rows */}
        {!isLoading && filteredLoads.length > 0 && (
          <div className="flex-1 overflow-auto" ref={parentRef}>
            <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const load = filteredLoads[virtualRow.index];
                return (
                  <div
                    key={load._id}
                    className="absolute top-0 left-0 w-full h-[48px] hover:bg-slate-50/80 transition-colors border-b flex items-center"
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    {visibleColumns.map(col => (
                      <div
                        key={col.key}
                        className={cn(
                          'px-4 min-w-0',
                          col.flex,
                          col.align === 'center' && 'text-center',
                          col.align === 'right' && 'text-right',
                        )}
                      >
                        {renderCell(col, load)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>

          </div>
        )}
      </div>
    </div>
  );
}
