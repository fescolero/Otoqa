'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Id } from '@/convex/_generated/dataModel';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { formatDateOnly } from '@/lib/format-date-timezone';

// Helper function to format city names to title case
function toTitleCase(str: string | undefined): string {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

interface Load {
  _id: Id<'loadInformation'>;
  orderNumber: string;
  customerName?: string;
  status: string;
  trackingStatus: string;
  stopsCount: number;
  origin?: {
    city?: string;
    state?: string;
  } | null;
  destination?: {
    city?: string;
    state?: string;
  } | null;
  firstStopDate?: string; // ISO 8601 date string
  createdAt: number;
}

interface VirtualizedLoadsTableProps {
  loads: Load[];
  selectedIds: Set<Id<'loadInformation'>>;
  focusedRowIndex: number | null;
  isAllSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onSelectRow: (id: Id<'loadInformation'>, checked: boolean) => void;
  onRowClick: (id: Id<'loadInformation'>) => void;
  formatDate: (timestamp: number) => string;
  getStatusColor: (status: string) => string;
  getTrackingColor: (status: string) => string;
  emptyMessage?: string;
}

export function VirtualizedLoadsTable({
  loads,
  selectedIds,
  focusedRowIndex,
  isAllSelected,
  onSelectAll,
  onSelectRow,
  onRowClick,
  formatDate,
  getStatusColor,
  getTrackingColor,
  emptyMessage = 'No loads found',
}: VirtualizedLoadsTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: loads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48, // Row height
    overscan: 10, // Number of items to render outside viewport
  });

  if (loads.length === 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        {/* Fixed Header */}
        <div className="flex-shrink-0 border-b bg-background">
          <div className="flex items-center h-10 w-full">
            <div className="px-2 w-12 flex items-center">
              <Checkbox
                checked={isAllSelected}
                onCheckedChange={onSelectAll}
                aria-label="Select all"
              />
            </div>
            <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Order #</div>
            <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Customer</div>
            <div className="px-4 flex-[2.5] font-medium text-muted-foreground text-sm">Route</div>
            <div className="px-4 flex-[0.7] font-medium text-muted-foreground text-sm text-center">Stops</div>
            <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Status</div>
            <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Tracking</div>
            <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Load Date</div>
          </div>
        </div>
        
        {/* Empty State */}
        <div className="flex-1 flex items-center justify-center py-12 text-muted-foreground">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Fixed Header */}
      <div className="flex-shrink-0 border-b bg-background">
        <div className="flex items-center h-10 w-full">
          <div className="px-2 w-12 flex items-center">
            <Checkbox
              checked={isAllSelected}
              onCheckedChange={onSelectAll}
              aria-label="Select all"
            />
          </div>
          <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Order #</div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Customer</div>
          <div className="px-4 flex-[2.5] font-medium text-muted-foreground text-sm">Route</div>
          <div className="px-4 flex-[0.7] font-medium text-muted-foreground text-sm text-center">Stops</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Status</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Tracking</div>
          <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Load Date</div>
        </div>
      </div>
      
      {/* Scrollable Body */}
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const load = loads[virtualRow.index];
            const index = virtualRow.index;

            return (
              <div
                key={load._id}
                data-index={virtualRow.index}
                className={cn(
                  'absolute top-0 left-0 w-full h-[48px] cursor-pointer hover:bg-slate-50/80 transition-colors group border-b flex items-center',
                  focusedRowIndex === index && 'ring-2 ring-primary'
                )}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('input[type="checkbox"]')) {
                    onRowClick(load._id);
                  }
                }}
              >
                <div className="px-2 w-12 flex items-center" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(load._id)}
                    onCheckedChange={(checked) => onSelectRow(load._id, checked as boolean)}
                    aria-label={`Select load ${load.orderNumber}`}
                  />
                </div>
                <div className="px-4 flex-[1.2]">
                  <Link href={`/loads/${load._id}`} className="font-mono text-sm font-medium text-blue-600 hover:text-blue-800">
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
                    {load.status}
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
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
