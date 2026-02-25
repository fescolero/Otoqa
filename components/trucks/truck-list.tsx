'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Truck as TruckIcon, CheckCircle, XCircle, Wrench, Settings, DollarSign, Trash } from 'lucide-react';
import { Doc, Id } from '@/convex/_generated/dataModel';
import { TruckFilterBar } from './truck-filter-bar';
import { VirtualizedTrucksTable } from './virtualized-trucks-table';
import { FloatingActionBar } from './floating-action-bar';
import { useAuthQuery } from '@/hooks/use-auth-query';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';

type Truck = Doc<'trucks'>;

interface TruckListProps {
  data: Truck[];
  organizationId: string;
  onDeactivateTrucks?: (truckIds: string[]) => Promise<void>;
}

export function TruckList({ data, organizationId, onDeactivateTrucks }: TruckListProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState<string>('all');
  const [selectedTrucks, setSelectedTrucks] = React.useState<Set<string>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = React.useState<number | null>(null);
  const [filters, setFilters] = React.useState({
    search: '',
    registrationStatus: '',
    insuranceStatus: '',
    yearMin: undefined as number | undefined,
    yearMax: undefined as number | undefined,
  });

  // Fetch truck counts
  const truckCounts = useAuthQuery(api.trucks.countTrucksByStatus, {
    organizationId,
  });

  // Filter trucks based on active tab and filters
  const filteredTrucks = React.useMemo(() => {
    let filtered = data;

    // Apply tab filter
    if (activeTab === 'deleted') {
      filtered = filtered.filter((truck) => truck.isDeleted === true);
    } else if (activeTab === 'active') {
      filtered = filtered.filter((truck) => truck.status === 'Active' && !truck.isDeleted);
    } else if (activeTab === 'outofservice') {
      filtered = filtered.filter((truck) => truck.status === 'Out of Service' && !truck.isDeleted);
    } else if (activeTab === 'inrepair') {
      filtered = filtered.filter((truck) => truck.status === 'In Repair' && !truck.isDeleted);
    } else if (activeTab === 'maintenance') {
      filtered = filtered.filter((truck) => truck.status === 'Maintenance' && !truck.isDeleted);
    } else if (activeTab === 'sold') {
      filtered = filtered.filter((truck) => truck.status === 'Sold' && !truck.isDeleted);
    } else if (activeTab === 'all') {
      filtered = filtered.filter((truck) => !truck.isDeleted);
    }

    // Apply search filter
    if (filters.search) {
      const query = filters.search.toLowerCase();
      filtered = filtered.filter(
        (truck) =>
          truck.unitId.toLowerCase().includes(query) ||
          truck.vin.toLowerCase().includes(query) ||
          truck.plate?.toLowerCase().includes(query) ||
          truck.make?.toLowerCase().includes(query) ||
          truck.model?.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [data, activeTab, filters]);

  // Clear selection when changing tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSelectedTrucks(new Set());
    setFocusedRowIndex(null);
  };

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedTrucks(new Set(filteredTrucks.map((truck) => truck._id)));
    } else {
      setSelectedTrucks(new Set());
    }
  };

  const handleSelectRow = (truckId: string, checked: boolean) => {
    const newSelected = new Set(selectedTrucks);
    if (checked) {
      newSelected.add(truckId);
    } else {
      newSelected.delete(truckId);
    }
    setSelectedTrucks(newSelected);
  };

  const handleRowClick = (truckId: Id<'trucks'>) => {
    router.push(`/fleet/trucks/${truckId}`);
  };

  const isAllSelected = filteredTrucks.length > 0 && selectedTrucks.size === filteredTrucks.length;

  // Bulk action handlers
  const handleBulkDeactivate = async () => {
    if (!onDeactivateTrucks) return;
    const truckIds = Array.from(selectedTrucks);
    await onDeactivateTrucks(truckIds);
    setSelectedTrucks(new Set());
  };

  const handleUpdateStatus = (status: 'Active' | 'Out of Service' | 'In Repair' | 'Maintenance' | 'Sold') => {
    console.log('Update truck status to:', status, 'for trucks:', Array.from(selectedTrucks));
    // TODO: Implement bulk status update functionality
  };

  const handleExport = () => {
    const selectedData = filteredTrucks.filter((truck) => selectedTrucks.has(truck._id));
    console.log('Export trucks:', selectedData);
    // TODO: Implement bulk export functionality
  };

  const handleDelete = () => {
    console.log('Delete trucks:', Array.from(selectedTrucks));
    // TODO: Implement bulk delete functionality
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
                <TruckIcon className="mr-2 h-4 w-4" />
                All Trucks
                {(truckCounts?.all || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {truckCounts?.all}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="active"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                Active
                {(truckCounts?.active || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800">
                    {truckCounts?.active}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="outofservice"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Out of Service
                {(truckCounts?.outOfService || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-red-100 text-red-800">
                    {truckCounts?.outOfService}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="inrepair"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Wrench className="mr-2 h-4 w-4" />
                In Repair
                {(truckCounts?.inRepair || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-orange-100 text-orange-800">
                    {truckCounts?.inRepair}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="maintenance"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Settings className="mr-2 h-4 w-4" />
                Maintenance
                {(truckCounts?.maintenance || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-yellow-100 text-yellow-800">
                    {truckCounts?.maintenance}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="sold"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <DollarSign className="mr-2 h-4 w-4" />
                Sold
                {(truckCounts?.sold || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-gray-100 text-gray-800">
                    {truckCounts?.sold}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="deleted"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Trash className="mr-2 h-4 w-4" />
                Deleted
                {(truckCounts?.deleted || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-gray-100 text-gray-800">
                    {truckCounts?.deleted}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab Content */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Filter Bar */}
            <TruckFilterBar
              onSearchChange={(search) => setFilters((prev) => ({ ...prev, search }))}
              onRegistrationStatusChange={(registrationStatus) =>
                setFilters((prev) => ({ ...prev, registrationStatus }))
              }
              onInsuranceStatusChange={(insuranceStatus) =>
                setFilters((prev) => ({ ...prev, insuranceStatus }))
              }
              onYearRangeChange={(yearMin, yearMax) =>
                setFilters((prev) => ({ ...prev, yearMin, yearMax }))
              }
            />

            <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
              <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                {/* Floating Action Bar */}
                <FloatingActionBar
                  selectedCount={selectedTrucks.size}
                  onClearSelection={() => setSelectedTrucks(new Set())}
                  onUpdateStatus={handleUpdateStatus}
                  onExport={handleExport}
                  onDelete={handleDelete}
                />

                {/* Virtualized Table */}
                <VirtualizedTrucksTable
                  trucks={filteredTrucks}
                  selectedIds={selectedTrucks}
                  focusedRowIndex={focusedRowIndex}
                  isAllSelected={isAllSelected}
                  onSelectAll={handleSelectAll}
                  onSelectRow={handleSelectRow}
                  onRowClick={handleRowClick}
                  emptyMessage="No trucks found"
                />
              </div>
            </div>
          </div>
        </Tabs>
      </Card>
    </div>
  );
}
