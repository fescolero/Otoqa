'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Users, UserCheck, AlertCircle, Clock, UserX, Trash } from 'lucide-react';
import { Doc } from '@/convex/_generated/dataModel';
import { FloatingActionBar } from './floating-action-bar';
import { DriverFilterBar, DriverFilterState } from './driver-filter-bar';
import { VirtualizedDriversTable } from './virtualized-drivers-table';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';

type Driver = Doc<'drivers'>;

interface DriverListProps {
  data: Driver[];
  organizationId: string;
  onDeactivateDrivers?: (driverIds: string[]) => Promise<void>;
}

// Helper to get date status
const getDateStatus = (dateString?: string): 'expired' | 'expiring' | 'warning' | 'valid' => {
  if (!dateString) return 'valid';
  
  const date = new Date(dateString);
  date.setHours(0, 0, 0, 0);
  
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const diffTime = date.getTime() - today.getTime();
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return 'expired';
  if (diffDays <= 30) return 'expiring';
  if (diffDays <= 60) return 'warning';
  return 'valid';
};

export function DriverList({ data, organizationId, onDeactivateDrivers }: DriverListProps) {
  const [activeTab, setActiveTab] = React.useState<string>('all');
  const [selectedDrivers, setSelectedDrivers] = React.useState<Set<string>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = React.useState<number | null>(null);
  const [filters, setFilters] = React.useState<DriverFilterState>({
    search: '',
  });

  // Fetch driver counts and include sensitive info for age calculation
  const driverCounts = useQuery(api.drivers.countDriversByStatus, {
    organizationId,
  });

  const driversWithSensitive = useQuery(api.drivers.list, {
    organizationId,
    includeDeleted: true,
    includeSensitive: true,
  });

  // Use drivers with sensitive info if available, otherwise use passed data
  const drivers = driversWithSensitive || data;

  // Filter drivers based on active tab and filters
  const filteredDrivers = React.useMemo(() => {
    let filtered = drivers;

    // Apply tab filter
    if (activeTab === 'deleted') {
      filtered = filtered.filter((driver) => driver.isDeleted === true);
    } else if (activeTab === 'active') {
      filtered = filtered.filter((driver) => driver.employmentStatus === 'Active' && !driver.isDeleted);
    } else if (activeTab === 'inactive') {
      filtered = filtered.filter((driver) => driver.employmentStatus === 'Inactive' && !driver.isDeleted);
    } else if (activeTab === 'onleave') {
      filtered = filtered.filter((driver) => driver.employmentStatus === 'On Leave' && !driver.isDeleted);
    } else if (activeTab === 'all') {
      filtered = filtered.filter((driver) => !driver.isDeleted);
    } else if (activeTab === 'expiring') {
      filtered = filtered.filter((driver) => {
        const licenseStatus = getDateStatus(driver.licenseExpiration);
        const medicalStatus = getDateStatus(driver.medicalExpiration);
        const badgeStatus = getDateStatus(driver.badgeExpiration);
        const twicStatus = getDateStatus(driver.twicExpiration);

        return (
          licenseStatus === 'expired' ||
          licenseStatus === 'expiring' ||
          medicalStatus === 'expired' ||
          medicalStatus === 'expiring' ||
          badgeStatus === 'expired' ||
          badgeStatus === 'expiring' ||
          twicStatus === 'expired' ||
          twicStatus === 'expiring'
        );
      });
    }

    // Apply search filter
    if (filters.search) {
      const query = filters.search.toLowerCase();
      filtered = filtered.filter(
        (driver) =>
          driver.firstName.toLowerCase().includes(query) ||
          driver.lastName.toLowerCase().includes(query) ||
          driver.email.toLowerCase().includes(query) ||
          driver.phone.includes(query) ||
          (driver.licenseNumber && driver.licenseNumber.toLowerCase().includes(query)),
      );
    }

    // Apply license class filter
    if (filters.licenseClass) {
      filtered = filtered.filter((driver) => driver.licenseClass === filters.licenseClass);
    }

    // Apply state filter
    if (filters.state) {
      filtered = filtered.filter((driver) => driver.licenseState === filters.state);
    }

    // Apply employment type filter
    if (filters.employmentType) {
      filtered = filtered.filter((driver) => driver.employmentType === filters.employmentType);
    }

    // Apply expiration status filter
    if (filters.expirationStatus) {
      filtered = filtered.filter((driver) => {
        const licenseStatus = getDateStatus(driver.licenseExpiration);
        const medicalStatus = getDateStatus(driver.medicalExpiration);
        
        if (filters.expirationStatus === 'expired') {
          return licenseStatus === 'expired' || medicalStatus === 'expired';
        } else if (filters.expirationStatus === 'expiring') {
          return licenseStatus === 'expiring' || medicalStatus === 'expiring';
        } else if (filters.expirationStatus === 'valid') {
          return licenseStatus === 'valid' && medicalStatus === 'valid';
        }
        return true;
      });
    }

    // Apply hire date range filter
    if (filters.hireDateRange) {
      filtered = filtered.filter((driver) => {
        const hireDate = new Date(driver.hireDate).getTime();
        return hireDate >= filters.hireDateRange!.start && hireDate <= filters.hireDateRange!.end;
      });
    }

    return filtered;
  }, [drivers, activeTab, filters]);

  // Extract unique states from drivers
  const availableStates = React.useMemo(() => {
    const states = new Set<string>();
    drivers.forEach((driver) => {
      if (driver.licenseState) states.add(driver.licenseState);
    });
    return Array.from(states).sort();
  }, [drivers]);

  // Clear selection when changing tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSelectedDrivers(new Set());
    setFocusedRowIndex(null);
  };

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedDrivers(new Set(filteredDrivers.map((driver) => driver._id)));
    } else {
      setSelectedDrivers(new Set());
    }
  };

  const handleSelectRow = (driverId: string, checked: boolean) => {
    const newSelected = new Set(selectedDrivers);
    if (checked) {
      newSelected.add(driverId);
    } else {
      newSelected.delete(driverId);
    }
    setSelectedDrivers(newSelected);
  };

  const isAllSelected = filteredDrivers.length > 0 && selectedDrivers.size === filteredDrivers.length;

  // Format date helper
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  // Color helpers
  const getEmploymentStatusColor = (status: string) => {
    switch (status) {
      case 'Active':
        return 'bg-green-100 text-green-800 border-green-200';
      case 'Inactive':
        return 'bg-gray-100 text-gray-800 border-gray-200';
      case 'On Leave':
        return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  const getExpirationStatusColor = (status: string) => {
    switch (status) {
      case 'expired':
        return 'bg-red-100 text-red-800 border-red-200';
      case 'expiring':
        return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'valid':
        return 'bg-green-100 text-green-800 border-green-200';
      default:
        return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  };

  // Bulk action handlers
  const handleBulkMessage = () => {
    console.log('Message drivers:', Array.from(selectedDrivers));
    // TODO: Implement bulk message functionality
  };

  const handleBulkEdit = () => {
    console.log('Bulk edit drivers:', Array.from(selectedDrivers));
    // TODO: Implement bulk edit functionality
  };

  const handleBulkExport = () => {
    const selectedData = drivers.filter((driver) => selectedDrivers.has(driver._id));
    console.log('Export drivers:', selectedData);
    // TODO: Implement bulk export functionality
  };

  const handleBulkDeactivate = async () => {
    if (!onDeactivateDrivers) return;
    const driverIds = Array.from(selectedDrivers);
    await onDeactivateDrivers(driverIds);
    setSelectedDrivers(new Set());
  };

  return (
    <div className="flex-1 flex flex-col gap-4 min-h-0">
      {/* Tabs */}
      <Card className="flex-1 flex flex-col p-0 gap-0 overflow-hidden min-h-0">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full flex-1 flex flex-col gap-0 min-h-0">
          <div className="flex-shrink-0 px-4">
            <TabsList className="h-auto p-0 bg-transparent border-0">
              <TabsTrigger
                value="all"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Users className="mr-2 h-4 w-4" />
                All Drivers
                {(driverCounts?.all || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {driverCounts?.all}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="active"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <UserCheck className="mr-2 h-4 w-4" />
                Active
                {(driverCounts?.active || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800">
                    {driverCounts?.active}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="expiring"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <AlertCircle className="mr-2 h-4 w-4" />
                Needs Attention
                {(driverCounts?.needsAttention || 0) > 0 && (
                  <Badge variant="destructive" className="ml-2">
                    {driverCounts?.needsAttention}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="onleave"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Clock className="mr-2 h-4 w-4" />
                On Leave
                {(driverCounts?.onLeave || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-yellow-100 text-yellow-800">
                    {driverCounts?.onLeave}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="inactive"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <UserX className="mr-2 h-4 w-4" />
                Inactive
                {(driverCounts?.inactive || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {driverCounts?.inactive}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="deleted"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Trash className="mr-2 h-4 w-4" />
                Deleted
                {(driverCounts?.deleted || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {driverCounts?.deleted}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab Content */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Filter Bar */}
            <DriverFilterBar
              filters={filters}
              onFiltersChange={setFilters}
              availableStates={availableStates}
            />

            <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
              <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                {/* Floating Action Bar */}
                {selectedDrivers.size > 0 && (
                  <FloatingActionBar
                    selectedCount={selectedDrivers.size}
                    totalCount={drivers.length}
                    isAllSelected={selectedDrivers.size === drivers.length}
                    onClearSelection={() => setSelectedDrivers(new Set())}
                    onSelectAll={filteredDrivers.length < drivers.length ? () => setSelectedDrivers(new Set(drivers.map((d) => d._id))) : undefined}
                    onMessage={handleBulkMessage}
                    onBulkEdit={handleBulkEdit}
                    onExport={handleBulkExport}
                    onDeactivate={handleBulkDeactivate}
                  />
                )}

                {/* Virtualized Table */}
                <VirtualizedDriversTable
                  drivers={filteredDrivers as any}
                  selectedIds={selectedDrivers}
                  focusedRowIndex={focusedRowIndex}
                  isAllSelected={isAllSelected}
                  onSelectAll={handleSelectAll}
                  onSelectRow={handleSelectRow}
                  onRowClick={(driverId) => {
                    // TODO: Open driver detail modal or navigate
                    console.log('Open driver:', driverId);
                  }}
                  formatDate={formatDate}
                  getEmploymentStatusColor={getEmploymentStatusColor}
                  getExpirationStatus={getDateStatus}
                  getExpirationStatusColor={getExpirationStatusColor}
                  emptyMessage={`No ${activeTab === 'all' ? '' : activeTab + ' '}drivers${filters.search ? ' matching your search' : ''}`}
                />
              </div>
            </div>
          </div>
        </Tabs>
      </Card>
    </div>
  );
}
