'use client';

import { Id } from '@/convex/_generated/dataModel';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { formatPhoneNumber } from '@/lib/format-phone';
import Link from 'next/link';
import { BaseVirtualizedTable, BaseColumn } from '@/components/ui/base-virtualized-table';

interface Driver {
  _id: Id<'drivers'>;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  licenseClass: string;
  licenseState: string;
  licenseNumber?: string;
  licenseExpiration: string;
  medicalExpiration?: string;
  employmentStatus: string;
  dateOfBirth?: string;
}

interface VirtualizedDriversTableProps {
  drivers: Driver[];
  selectedIds: Set<string>;
  focusedRowIndex: number | null;
  isAllSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onSelectRow: (id: string, checked: boolean) => void;
  onRowClick: (id: Id<'drivers'>) => void;
  formatDate: (timestamp: string) => string;
  getEmploymentStatusColor: (status: string) => string;
  getExpirationStatus: (dateString?: string) => 'expired' | 'expiring' | 'warning' | 'valid';
  getExpirationStatusColor: (status: string) => string;
  emptyMessage?: string;
}

function calculateAge(dob?: string): number | null {
  if (!dob) return null;
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

export function VirtualizedDriversTable({
  drivers,
  selectedIds,
  focusedRowIndex,
  isAllSelected,
  onSelectAll,
  onSelectRow,
  onRowClick,
  formatDate,
  getEmploymentStatusColor,
  getExpirationStatus,
  getExpirationStatusColor,
  emptyMessage = 'No drivers found',
}: VirtualizedDriversTableProps) {
  const columns: BaseColumn<Driver>[] = [
    {
      key: 'driver',
      header: 'Driver',
      width: 'flex-[2]',
      cell: (driver) => {
        const age = calculateAge(driver.dateOfBirth);
        return (
          <Link
            href={`/fleet/drivers/${driver._id}`}
            className="flex items-center gap-3 hover:text-blue-600"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar className="h-10 w-10">
              <AvatarFallback className="bg-blue-100 text-blue-600 font-semibold">
                {getInitials(driver.firstName, driver.lastName)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="font-semibold text-sm truncate">
                {driver.firstName} {driver.lastName}
              </div>
              {age && <div className="text-xs text-muted-foreground">{age} years</div>}
            </div>
          </Link>
        );
      },
    },
    {
      key: 'contact',
      header: 'Contact',
      width: 'flex-[1.5]',
      cell: (driver) => (
        <>
          <div className="text-sm truncate">{formatPhoneNumber(driver.phone)}</div>
          <div className="text-xs text-muted-foreground truncate">{driver.email}</div>
        </>
      ),
    },
    {
      key: 'license',
      header: 'License',
      width: 'flex-[1.5]',
      cell: (driver) => {
        const status = getExpirationStatus(driver.licenseExpiration);
        return (
          <>
            <div className="text-sm font-medium">
              {driver.licenseClass} {driver.licenseNumber && `- ${driver.licenseNumber}`}
            </div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-xs text-muted-foreground">{formatDate(driver.licenseExpiration)}</span>
              <Badge
                variant="outline"
                className={cn('text-xs px-1 py-0', getExpirationStatusColor(status))}
              >
                {status === 'expired' ? 'Expired' : status === 'expiring' ? 'Expiring' : 'Valid'}
              </Badge>
            </div>
          </>
        );
      },
    },
    {
      key: 'medical',
      header: 'Medical',
      width: 'flex-[1.2]',
      cell: (driver) => {
        if (!driver.medicalExpiration) {
          return <span className="text-xs text-muted-foreground">N/A</span>;
        }
        const status = getExpirationStatus(driver.medicalExpiration);
        return (
          <>
            <div className="text-xs text-muted-foreground">Medical Card</div>
            <div className="flex items-center gap-1 mt-0.5">
              <span className="text-xs text-muted-foreground">{formatDate(driver.medicalExpiration)}</span>
              <Badge
                variant="outline"
                className={cn('text-xs px-1 py-0', getExpirationStatusColor(status))}
              >
                {status === 'expired' ? 'Expired' : status === 'expiring' ? 'Expiring' : 'Valid'}
              </Badge>
            </div>
          </>
        );
      },
    },
    {
      key: 'state',
      header: 'State',
      width: 'flex-[0.8]',
      cellClassName: 'px-4 text-sm font-medium',
      cell: (driver) => driver.licenseState,
    },
    {
      key: 'status',
      header: 'Status',
      width: 'flex-1',
      cellClassName: 'px-4',
      cell: (driver) => (
        <Badge variant="outline" className={getEmploymentStatusColor(driver.employmentStatus)}>
          {driver.employmentStatus}
        </Badge>
      ),
    },
  ];

  return (
    <BaseVirtualizedTable<Driver>
      rows={drivers}
      columns={columns}
      selectedIds={selectedIds}
      isAllSelected={isAllSelected}
      onSelectAll={onSelectAll}
      onSelectRow={onSelectRow}
      onRowClick={(driver) => onRowClick(driver._id)}
      focusedRowIndex={focusedRowIndex}
      emptyMessage={emptyMessage}
      rowAriaLabel={(driver) => `Select ${driver.firstName} ${driver.lastName}`}
    />
  );
}
