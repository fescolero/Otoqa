'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Id } from '@/convex/_generated/dataModel';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { format } from 'date-fns';
import {
  getAssetStatusColor,
  getAssetExpirationStatus as getExpirationStatus,
  getAssetExpirationStatusColor as getExpirationStatusColor,
} from '@/lib/status-colors';

interface Truck {
  _id: Id<'trucks'>;
  unitId: string;
  vin: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: number;
  status: string;
  registrationExpiration?: string;
  insuranceExpiration?: string;
}

interface VirtualizedTrucksTableProps {
  trucks: Truck[];
  selectedIds: Set<string>;
  focusedRowIndex: number | null;
  isAllSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onSelectRow: (id: string, checked: boolean) => void;
  onRowClick: (id: Id<'trucks'>) => void;
  emptyMessage?: string;
}

// Format date — parses YYYY-MM-DD by component to avoid timezone shift
function formatDate(dateString?: string): string {
  if (!dateString) return 'N/A';
  const match = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[parseInt(match[2], 10) - 1]} ${String(parseInt(match[3], 10)).padStart(2, '0')}, ${match[1]}`;
  }
  try {
    return format(new Date(dateString), 'MMM dd, yyyy');
  } catch {
    return 'Invalid Date';
  }
}

export function VirtualizedTrucksTable({
  trucks,
  selectedIds,
  focusedRowIndex,
  isAllSelected,
  onSelectAll,
  onSelectRow,
  onRowClick,
  emptyMessage = 'No trucks found',
}: VirtualizedTrucksTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: trucks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56, // Row height for two-line content
    overscan: 10,
  });

  if (trucks.length === 0) {
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
            <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Unit Info</div>
            <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Details</div>
            <div className="px-4 flex-[0.8] font-medium text-muted-foreground text-sm">Plate</div>
            <div className="px-4 flex-[0.8] font-medium text-muted-foreground text-sm">Status</div>
            <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Registration</div>
            <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Insurance</div>
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
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Unit Info</div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Details</div>
          <div className="px-4 flex-[0.8] font-medium text-muted-foreground text-sm">Plate</div>
          <div className="px-4 flex-[0.8] font-medium text-muted-foreground text-sm">Status</div>
          <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Registration</div>
          <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Insurance</div>
        </div>
      </div>
      
      {/* Scrollable Body */}
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const truck = trucks[virtualRow.index];
            const index = virtualRow.index;
            const registrationStatus = getExpirationStatus(truck.registrationExpiration);
            const insuranceStatus = getExpirationStatus(truck.insuranceExpiration);

            return (
              <div
                key={truck._id}
                data-index={virtualRow.index}
                className={cn(
                  'absolute top-0 left-0 w-full h-[56px] cursor-pointer hover:bg-slate-50/80 transition-colors group border-b flex items-center',
                  focusedRowIndex === index && 'ring-2 ring-primary'
                )}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('input[type="checkbox"]')) {
                    onRowClick(truck._id);
                  }
                }}
              >
                {/* Checkbox */}
                <div className="px-2 w-12 flex items-center" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(truck._id)}
                    onCheckedChange={(checked) => onSelectRow(truck._id, checked as boolean)}
                    aria-label={`Select ${truck.unitId}`}
                  />
                </div>

                {/* Unit Info Column */}
                <div className="px-4 flex-[1.5] min-w-0">
                  <Link 
                    href={`/fleet/trucks/${truck._id}`} 
                    className="hover:text-blue-600"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="font-semibold text-sm truncate whitespace-nowrap">
                      {truck.unitId}
                    </div>
                    <div className="text-xs text-muted-foreground truncate whitespace-nowrap">
                      {truck.vin}
                    </div>
                  </Link>
                </div>

                {/* Details Column */}
                <div className="px-4 flex-[1.5] min-w-0">
                  <div className="text-sm truncate whitespace-nowrap">
                    {truck.make} {truck.model}
                  </div>
                  <div className="text-xs text-muted-foreground truncate whitespace-nowrap">
                    {truck.year ? `${truck.year}` : 'Year N/A'}
                  </div>
                </div>

                {/* Plate Column */}
                <div className="px-4 flex-[0.8] min-w-0">
                  <div className="text-sm font-medium truncate whitespace-nowrap">
                    {truck.plate || 'N/A'}
                  </div>
                </div>

                {/* Status Column */}
                <div className="px-4 flex-[0.8] min-w-0">
                  <Badge variant="outline" className={cn('text-xs font-medium whitespace-nowrap', getAssetStatusColor(truck.status))}>
                    {truck.status}
                  </Badge>
                </div>

                {/* Registration Column */}
                <div className="px-4 flex-[1.2] min-w-0">
                  <div className="text-xs truncate whitespace-nowrap">
                    {formatDate(truck.registrationExpiration)}
                  </div>
                  <Badge 
                    variant="outline" 
                    className={cn('text-xs font-medium mt-0.5 whitespace-nowrap', getExpirationStatusColor(registrationStatus))}
                  >
                    {registrationStatus === 'unknown' ? 'No Date' : registrationStatus.charAt(0).toUpperCase() + registrationStatus.slice(1)}
                  </Badge>
                </div>

                {/* Insurance Column */}
                <div className="px-4 flex-[1.2] min-w-0">
                  <div className="text-xs truncate whitespace-nowrap">
                    {formatDate(truck.insuranceExpiration)}
                  </div>
                  <Badge 
                    variant="outline" 
                    className={cn('text-xs font-medium mt-0.5 whitespace-nowrap', getExpirationStatusColor(insuranceStatus))}
                  >
                    {insuranceStatus === 'unknown' ? 'No Date' : insuranceStatus.charAt(0).toUpperCase() + insuranceStatus.slice(1)}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
