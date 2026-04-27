'use client';

import { Id } from '@/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { format } from 'date-fns';
import {
  getAssetStatusColor,
  getAssetExpirationStatus as getExpirationStatus,
  getAssetExpirationStatusColor as getExpirationStatusColor,
} from '@/lib/status-colors';
import { BaseVirtualizedTable, BaseColumn } from '@/components/ui/base-virtualized-table';

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

function expirationLabel(status: ReturnType<typeof getExpirationStatus>): string {
  if (status === 'unknown') return 'No Date';
  return status.charAt(0).toUpperCase() + status.slice(1);
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
  const columns: BaseColumn<Truck>[] = [
    {
      key: 'unit',
      header: 'Unit Info',
      width: 'flex-[1.5]',
      cell: (truck) => (
        <Link
          href={`/fleet/trucks/${truck._id}`}
          className="hover:text-blue-600"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="font-semibold text-sm truncate whitespace-nowrap">{truck.unitId}</div>
          <div className="text-xs text-muted-foreground truncate whitespace-nowrap">{truck.vin}</div>
        </Link>
      ),
    },
    {
      key: 'details',
      header: 'Details',
      width: 'flex-[1.5]',
      cell: (truck) => (
        <>
          <div className="text-sm truncate whitespace-nowrap">
            {truck.make} {truck.model}
          </div>
          <div className="text-xs text-muted-foreground truncate whitespace-nowrap">
            {truck.year ? `${truck.year}` : 'Year N/A'}
          </div>
        </>
      ),
    },
    {
      key: 'plate',
      header: 'Plate',
      width: 'flex-[0.8]',
      cell: (truck) => (
        <div className="text-sm font-medium truncate whitespace-nowrap">{truck.plate || 'N/A'}</div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'flex-[0.8]',
      cell: (truck) => (
        <Badge variant="outline" className={cn('text-xs font-medium whitespace-nowrap', getAssetStatusColor(truck.status))}>
          {truck.status}
        </Badge>
      ),
    },
    {
      key: 'registration',
      header: 'Registration',
      width: 'flex-[1.2]',
      cell: (truck) => {
        const status = getExpirationStatus(truck.registrationExpiration);
        return (
          <>
            <div className="text-xs truncate whitespace-nowrap">{formatDate(truck.registrationExpiration)}</div>
            <Badge
              variant="outline"
              className={cn('text-xs font-medium mt-0.5 whitespace-nowrap', getExpirationStatusColor(status))}
            >
              {expirationLabel(status)}
            </Badge>
          </>
        );
      },
    },
    {
      key: 'insurance',
      header: 'Insurance',
      width: 'flex-[1.2]',
      cell: (truck) => {
        const status = getExpirationStatus(truck.insuranceExpiration);
        return (
          <>
            <div className="text-xs truncate whitespace-nowrap">{formatDate(truck.insuranceExpiration)}</div>
            <Badge
              variant="outline"
              className={cn('text-xs font-medium mt-0.5 whitespace-nowrap', getExpirationStatusColor(status))}
            >
              {expirationLabel(status)}
            </Badge>
          </>
        );
      },
    },
  ];

  return (
    <BaseVirtualizedTable<Truck>
      rows={trucks}
      columns={columns}
      selectedIds={selectedIds}
      isAllSelected={isAllSelected}
      onSelectAll={onSelectAll}
      onSelectRow={onSelectRow}
      onRowClick={(truck) => onRowClick(truck._id)}
      focusedRowIndex={focusedRowIndex}
      emptyMessage={emptyMessage}
      rowAriaLabel={(truck) => `Select ${truck.unitId}`}
    />
  );
}
