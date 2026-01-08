'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Id } from '@/convex/_generated/dataModel';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import Link from 'next/link';

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

// Helper function to calculate age from date of birth
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

// Helper to get initials from name
function getInitials(firstName: string, lastName: string): string {
  return `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();
}

// Helper to format phone number
function formatPhoneNumber(phone: string): string {
  // Remove all non-digit characters
  const cleaned = phone.replace(/\D/g, '');
  
  // Format as (XXX) XXX-XXXX
  if (cleaned.length === 10) {
    return `(${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6)}`;
  }
  
  // Return original if not 10 digits
  return phone;
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
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: drivers.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 56, // Row height
    overscan: 10,
  });

  if (drivers.length === 0) {
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
            <div className="px-4 flex-[2] font-medium text-muted-foreground text-sm">Driver</div>
            <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Contact</div>
            <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">License</div>
            <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Medical</div>
            <div className="px-4 flex-[0.8] font-medium text-muted-foreground text-sm">State</div>
            <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Status</div>
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
          <div className="px-4 flex-[2] font-medium text-muted-foreground text-sm">Driver</div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">Contact</div>
          <div className="px-4 flex-[1.5] font-medium text-muted-foreground text-sm">License</div>
          <div className="px-4 flex-[1.2] font-medium text-muted-foreground text-sm">Medical</div>
          <div className="px-4 flex-[0.8] font-medium text-muted-foreground text-sm">State</div>
          <div className="px-4 flex-1 font-medium text-muted-foreground text-sm">Status</div>
        </div>
      </div>
      
      {/* Scrollable Body */}
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const driver = drivers[virtualRow.index];
            const index = virtualRow.index;
            const age = calculateAge(driver.dateOfBirth);
            const licenseStatus = getExpirationStatus(driver.licenseExpiration);
            const medicalStatus = getExpirationStatus(driver.medicalExpiration);

            return (
              <div
                key={driver._id}
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
                    onRowClick(driver._id);
                  }
                }}
              >
                {/* Checkbox */}
                <div className="px-2 w-12 flex items-center" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(driver._id)}
                    onCheckedChange={(checked) => onSelectRow(driver._id, checked as boolean)}
                    aria-label={`Select ${driver.firstName} ${driver.lastName}`}
                  />
                </div>

                {/* Driver Column */}
                <div className="px-4 flex-[2] min-w-0">
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
                      {age && (
                        <div className="text-xs text-muted-foreground">
                          {age} years
                        </div>
                      )}
                    </div>
                  </Link>
                </div>

                {/* Contact Column */}
                <div className="px-4 flex-[1.5] min-w-0">
                  <div className="text-sm truncate">{formatPhoneNumber(driver.phone)}</div>
                  <div className="text-xs text-muted-foreground truncate">{driver.email}</div>
                </div>

                {/* License Column */}
                <div className="px-4 flex-[1.5] min-w-0">
                  <div className="text-sm font-medium">
                    {driver.licenseClass} {driver.licenseNumber && `- ${driver.licenseNumber}`}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5">
                    <span className="text-xs text-muted-foreground">
                      {formatDate(driver.licenseExpiration)}
                    </span>
                    <Badge 
                      variant="outline" 
                      className={cn('text-xs px-1 py-0', getExpirationStatusColor(licenseStatus))}
                    >
                      {licenseStatus === 'expired' ? 'Expired' : licenseStatus === 'expiring' ? 'Expiring' : 'Valid'}
                    </Badge>
                  </div>
                </div>

                {/* Medical Column */}
                <div className="px-4 flex-[1.2] min-w-0">
                  {driver.medicalExpiration ? (
                    <>
                      <div className="text-xs text-muted-foreground">Medical Card</div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-xs text-muted-foreground">
                          {formatDate(driver.medicalExpiration)}
                        </span>
                        <Badge 
                          variant="outline" 
                          className={cn('text-xs px-1 py-0', getExpirationStatusColor(medicalStatus))}
                        >
                          {medicalStatus === 'expired' ? 'Expired' : medicalStatus === 'expiring' ? 'Expiring' : 'Valid'}
                        </Badge>
                      </div>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">N/A</span>
                  )}
                </div>

                {/* License State Column */}
                <div className="px-4 flex-[0.8] text-sm font-medium">
                  {driver.licenseState}
                </div>

                {/* Employment Status Column */}
                <div className="px-4 flex-1">
                  <Badge variant="outline" className={getEmploymentStatusColor(driver.employmentStatus)}>
                    {driver.employmentStatus}
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
