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

interface Trailer {
  _id: Id<'trailers'>;
  unitId: string;
  vin: string;
  plate?: string;
  make?: string;
  model?: string;
  year?: number;
  size?: string;
  bodyType?: string;
  status: string;
  registrationExpiration?: string;
  insuranceExpiration?: string;
}

interface VirtualizedTrailersTableProps {
  trailers: Trailer[];
  selectedIds: Set<string>;
  focusedRowIndex: number | null;
  isAllSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onSelectRow: (id: string, checked: boolean) => void;
  onRowClick: (id: Id<'trailers'>) => void;
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

export function VirtualizedTrailersTable({
  trailers,
  selectedIds,
  focusedRowIndex,
  isAllSelected,
  onSelectAll,
  onSelectRow,
  onRowClick,
  emptyMessage = 'No trailers found',
}: VirtualizedTrailersTableProps) {
  const columns: BaseColumn<Trailer>[] = [
    {
      key: 'unit',
      header: 'Unit Info',
      width: 'flex-[1.5]',
      cell: (trailer) => (
        <Link
          href={`/fleet/trailers/${trailer._id}`}
          className="hover:text-blue-600"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="font-semibold text-sm truncate whitespace-nowrap">{trailer.unitId}</div>
          <div className="text-xs text-muted-foreground truncate whitespace-nowrap">{trailer.vin}</div>
        </Link>
      ),
    },
    {
      key: 'details',
      header: 'Details',
      width: 'flex-[1.5]',
      cell: (trailer) => (
        <>
          <div className="text-sm truncate whitespace-nowrap">
            {trailer.make} {trailer.model} {trailer.size && `- ${trailer.size}`}
          </div>
          <div className="text-xs text-muted-foreground truncate whitespace-nowrap">
            {trailer.bodyType || 'Type N/A'} {trailer.year && `• ${trailer.year}`}
          </div>
        </>
      ),
    },
    {
      key: 'plate',
      header: 'Plate',
      width: 'flex-[0.8]',
      cell: (trailer) => (
        <div className="text-sm font-medium truncate whitespace-nowrap">{trailer.plate || 'N/A'}</div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      width: 'flex-[0.8]',
      cell: (trailer) => (
        <Badge variant="outline" className={cn('text-xs font-medium whitespace-nowrap', getAssetStatusColor(trailer.status))}>
          {trailer.status}
        </Badge>
      ),
    },
    {
      key: 'registration',
      header: 'Registration',
      width: 'flex-[1.2]',
      cell: (trailer) => {
        const status = getExpirationStatus(trailer.registrationExpiration);
        return (
          <>
            <div className="text-xs truncate whitespace-nowrap">{formatDate(trailer.registrationExpiration)}</div>
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
      cell: (trailer) => {
        const status = getExpirationStatus(trailer.insuranceExpiration);
        return (
          <>
            <div className="text-xs truncate whitespace-nowrap">{formatDate(trailer.insuranceExpiration)}</div>
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
    <BaseVirtualizedTable<Trailer>
      rows={trailers}
      columns={columns}
      selectedIds={selectedIds}
      isAllSelected={isAllSelected}
      onSelectAll={onSelectAll}
      onSelectRow={onSelectRow}
      onRowClick={(trailer) => onRowClick(trailer._id)}
      focusedRowIndex={focusedRowIndex}
      emptyMessage={emptyMessage}
      rowAriaLabel={(trailer) => `Select ${trailer.unitId}`}
    />
  );
}
