'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Container, CheckCircle, XCircle, Wrench, Settings, DollarSign, Trash } from 'lucide-react';
import { Doc, Id } from '@/convex/_generated/dataModel';
import { TrailerFilterBar } from './trailer-filter-bar';
import { VirtualizedTrailersTable } from './virtualized-trailers-table';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { useRouter } from 'next/navigation';

type Trailer = Doc<'trailers'>;

interface TrailerListProps {
  data: Trailer[];
  organizationId: string;
  onDeactivateTrailers?: (trailerIds: string[]) => Promise<void>;
}

export function TrailerList({ data, organizationId, onDeactivateTrailers }: TrailerListProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = React.useState<string>('all');
  const [selectedTrailers, setSelectedTrailers] = React.useState<Set<string>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = React.useState<number | null>(null);
  const [filters, setFilters] = React.useState({
    search: '',
    registrationStatus: '',
    insuranceStatus: '',
    size: '',
    bodyType: '',
  });

  // Fetch trailer counts
  const trailerCounts = useQuery(api.trailers.countTrailersByStatus, {
    organizationId,
  });

  // Filter trailers based on active tab and filters
  const filteredTrailers = React.useMemo(() => {
    let filtered = data;

    // Apply tab filter
    if (activeTab === 'deleted') {
      filtered = filtered.filter((trailer) => trailer.isDeleted === true);
    } else if (activeTab === 'active') {
      filtered = filtered.filter((trailer) => trailer.status === 'Active' && !trailer.isDeleted);
    } else if (activeTab === 'outofservice') {
      filtered = filtered.filter((trailer) => trailer.status === 'Out of Service' && !trailer.isDeleted);
    } else if (activeTab === 'inrepair') {
      filtered = filtered.filter((trailer) => trailer.status === 'In Repair' && !trailer.isDeleted);
    } else if (activeTab === 'maintenance') {
      filtered = filtered.filter((trailer) => trailer.status === 'Maintenance' && !trailer.isDeleted);
    } else if (activeTab === 'sold') {
      filtered = filtered.filter((trailer) => trailer.status === 'Sold' && !trailer.isDeleted);
    } else if (activeTab === 'all') {
      filtered = filtered.filter((trailer) => !trailer.isDeleted);
    }

    // Apply search filter
    if (filters.search) {
      const query = filters.search.toLowerCase();
      filtered = filtered.filter(
        (trailer) =>
          trailer.unitId.toLowerCase().includes(query) ||
          trailer.vin.toLowerCase().includes(query) ||
          trailer.plate?.toLowerCase().includes(query) ||
          trailer.make?.toLowerCase().includes(query) ||
          trailer.model?.toLowerCase().includes(query)
      );
    }

    return filtered;
  }, [data, activeTab, filters]);

  // Clear selection when changing tabs
  const handleTabChange = (value: string) => {
    setActiveTab(value);
    setSelectedTrailers(new Set());
    setFocusedRowIndex(null);
  };

  // Selection handlers
  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedTrailers(new Set(filteredTrailers.map((trailer) => trailer._id)));
    } else {
      setSelectedTrailers(new Set());
    }
  };

  const handleSelectRow = (trailerId: string, checked: boolean) => {
    const newSelected = new Set(selectedTrailers);
    if (checked) {
      newSelected.add(trailerId);
    } else {
      newSelected.delete(trailerId);
    }
    setSelectedTrailers(newSelected);
  };

  const handleRowClick = (trailerId: Id<'trailers'>) => {
    router.push(`/fleet/trailers/${trailerId}`);
  };

  const isAllSelected = filteredTrailers.length > 0 && selectedTrailers.size === filteredTrailers.length;

  // Bulk deactivate handler
  const handleBulkDeactivate = async () => {
    if (!onDeactivateTrailers) return;
    const trailerIds = Array.from(selectedTrailers);
    await onDeactivateTrailers(trailerIds);
    setSelectedTrailers(new Set());
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
                <Container className="mr-2 h-4 w-4" />
                All Trailers
                {(trailerCounts?.all || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2">
                    {trailerCounts?.all}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="active"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <CheckCircle className="mr-2 h-4 w-4" />
                Active
                {(trailerCounts?.active || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-green-100 text-green-800">
                    {trailerCounts?.active}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="outofservice"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Out of Service
                {(trailerCounts?.outOfService || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-red-100 text-red-800">
                    {trailerCounts?.outOfService}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="inrepair"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Wrench className="mr-2 h-4 w-4" />
                In Repair
                {(trailerCounts?.inRepair || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-orange-100 text-orange-800">
                    {trailerCounts?.inRepair}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="maintenance"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Settings className="mr-2 h-4 w-4" />
                Maintenance
                {(trailerCounts?.maintenance || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-yellow-100 text-yellow-800">
                    {trailerCounts?.maintenance}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="sold"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <DollarSign className="mr-2 h-4 w-4" />
                Sold
                {(trailerCounts?.sold || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-gray-100 text-gray-800">
                    {trailerCounts?.sold}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="deleted"
                className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:!bg-transparent data-[state=active]:!shadow-none data-[state=active]:border-l-0 data-[state=active]:border-r-0 data-[state=active]:border-t-0 rounded-none px-4 py-3 !bg-transparent !shadow-none border-0"
              >
                <Trash className="mr-2 h-4 w-4" />
                Deleted
                {(trailerCounts?.deleted || 0) > 0 && (
                  <Badge variant="secondary" className="ml-2 bg-gray-100 text-gray-800">
                    {trailerCounts?.deleted}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab Content */}
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {/* Filter Bar */}
            <TrailerFilterBar
              onSearchChange={(search) => setFilters((prev) => ({ ...prev, search }))}
              onRegistrationStatusChange={(registrationStatus) =>
                setFilters((prev) => ({ ...prev, registrationStatus }))
              }
              onInsuranceStatusChange={(insuranceStatus) =>
                setFilters((prev) => ({ ...prev, insuranceStatus }))
              }
              onSizeChange={(size) => setFilters((prev) => ({ ...prev, size }))}
              onBodyTypeChange={(bodyType) => setFilters((prev) => ({ ...prev, bodyType }))}
            />

            <div className="flex-1 p-4 overflow-hidden min-h-0 flex flex-col">
              <div className="border rounded-lg flex-1 min-h-0 overflow-hidden flex flex-col">
                {/* Virtualized Table */}
                <VirtualizedTrailersTable
                  trailers={filteredTrailers}
                  selectedIds={selectedTrailers}
                  focusedRowIndex={focusedRowIndex}
                  isAllSelected={isAllSelected}
                  onSelectAll={handleSelectAll}
                  onSelectRow={handleSelectRow}
                  onRowClick={handleRowClick}
                  emptyMessage="No trailers found"
                />
              </div>
            </div>
          </div>
        </Tabs>
      </Card>

      {/* Floating Action Bar */}
      {selectedTrailers.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 sm:left-[calc(50%+8rem)] xl:left-[calc(50%+9rem)] z-50 bg-background border rounded-lg shadow-lg p-3 sm:p-4">
          <div className="flex items-center gap-4">
            <p className="text-sm font-medium">
              {selectedTrailers.size} selected
            </p>
            <button
              onClick={() => setSelectedTrailers(new Set())}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
            <button
              onClick={handleBulkDeactivate}
              className="text-sm text-destructive hover:text-destructive/90 font-medium"
            >
              Deactivate
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
