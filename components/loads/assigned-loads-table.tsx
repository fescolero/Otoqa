'use client';

import { useRef, useState, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Id } from '@/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowRight, Loader2, Package } from 'lucide-react';
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

export type AssignedLoadStatus = 'Assigned' | 'Completed' | 'Canceled';
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
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
}

function getStatusColor(status: string) {
  const displayStatus = status === 'Completed' ? 'Delivered' : status;
  switch (displayStatus) {
    case 'Delivered':
      return 'bg-green-100 text-green-800 border-green-200';
    case 'Assigned':
      return 'bg-blue-100 text-blue-800 border-blue-200';
    case 'Open':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200';
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

export function AssignedLoadsTable({
  loads,
  isLoading,
  statusFilter,
  onStatusFilterChange,
  showCarrierRate = false,
  onLoadMore,
  hasMore = false,
  isLoadingMore = false,
}: AssignedLoadsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [timeHorizon, setTimeHorizon] = useState<TimeHorizon>('all');

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

  return (
    <div className="flex flex-col gap-4">
      {/* Filter Bar */}
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

      {/* Table */}
      <div className="border rounded-lg flex flex-col min-h-0" style={{ height: '500px' }}>
        {/* Header */}
        <div className="flex-shrink-0 border-b bg-background">
          <div className="flex items-center h-10 w-full">
            <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Order #</div>
            <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Customer</div>
            <div className="px-4 flex-[2.5] font-medium text-muted-foreground text-sm">Route</div>
            <div className="px-4 flex-[0.7] font-medium text-muted-foreground text-sm text-center">Stops</div>
            <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Status</div>
            <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Tracking</div>
            <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Load Date</div>
            {showCarrierRate && (
              <div className="px-4 flex-1 font-medium text-muted-foreground text-sm text-right">Rate</div>
            )}
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
                    <div className="px-4 flex-[1.2]">
                      <Link
                        href={`/loads/${load._id}`}
                        className="font-mono text-sm font-medium text-blue-600 hover:text-blue-800"
                      >
                        {load.orderNumber}
                      </Link>
                    </div>
                    <div className="px-4 flex-[1.5] text-sm font-medium min-w-0">
                      <div className="truncate">{load.customerName || 'Unknown'}</div>
                    </div>
                    <div className="px-4 flex-[2.5] min-w-0">
                      {load.origin && load.destination ? (
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
                      )}
                    </div>
                    <div className="px-4 flex-[0.7] text-center">
                      <Badge variant="outline" className="font-mono">
                        {load.stopsCount}
                      </Badge>
                    </div>
                    <div className="px-4 flex-1">
                      <Badge variant="outline" className={getStatusColor(load.status)}>
                        {getDisplayStatus(load.status)}
                      </Badge>
                    </div>
                    <div className="px-4 flex-1">
                      <Badge variant="secondary" className={getTrackingColor(load.trackingStatus)}>
                        {load.trackingStatus}
                      </Badge>
                    </div>
                    <div className="px-4 flex-[1.2] text-sm text-muted-foreground">
                      {load.firstStopDate
                        ? formatDateOnly(load.firstStopDate).display
                        : formatDateOnly(new Date(load.createdAt).toISOString()).display}
                    </div>
                    {showCarrierRate && (
                      <div className="px-4 flex-1 text-sm font-medium text-right">
                        {load.carrierRate != null
                          ? `$${load.carrierRate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : '—'}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Load More */}
            {hasMore && (
              <div className="flex justify-center py-3 border-t">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLoadMore}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Loading...
                    </>
                  ) : (
                    'Load More'
                  )}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
