'use client';

import { useState, useMemo } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';
import { Id } from '@/convex/_generated/dataModel';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { Package, MapPin, ArrowRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TripFiltersState } from './trip-filters';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { formatDateOnly } from '@/lib/format-date-timezone';
import { format } from 'date-fns';

interface TripsTableProps {
  organizationId: string;
  selectedLoadId: Id<'loadInformation'> | null;
  onSelectLoad: (loadId: Id<'loadInformation'> | null) => void;
  filters: TripFiltersState;
  onSearchChange?: (search: string) => void;
  onFiltersChange?: (filters: TripFiltersState) => void;
}

export function TripsTable({
  organizationId,
  selectedLoadId,
  onSelectLoad,
  filters,
  onSearchChange,
  onFiltersChange,
}: TripsTableProps) {
  const [statusFilter, setStatusFilter] = useState<string>('Open');
  const [localSearch, setLocalSearch] = useState(filters.search);

  // Fetch load counts for tab badges
  const loadCounts = useQuery(api.loads.countLoadsByStatus, {
    workosOrgId: organizationId,
  });

  // Fetch loads with status and advanced filters
  const loadsData = useQuery(api.loads.getLoads, {
    workosOrgId: organizationId,
    status: statusFilter as 'Open' | 'Assigned' | 'Completed' | 'Canceled',
    search: filters.search || undefined,
    hcr: filters.hcr || undefined,
    tripNumber: filters.tripNumber || undefined,
    // Pass date strings directly - backend will handle comparison
    startDate: filters.startDate || undefined,
    endDate: filters.endDate || undefined,
    paginationOpts: {
      numItems: 100,
      cursor: null,
    },
  });

  const loads = loadsData?.page ?? [];
  const isLoading = loadsData === undefined;

  // Status color helpers
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Completed':
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
  };

  // Date formatting is now handled by formatDateOnly utility

  const handleTabChange = (value: string) => {
    setStatusFilter(value);
    onSelectLoad(null); // Clear selection when changing tabs
  };

  const handleRowClick = (loadId: Id<'loadInformation'>) => {
    if (selectedLoadId === loadId) {
      onSelectLoad(null); // Deselect if already selected
    } else {
      onSelectLoad(loadId);
    }
  };

  // Handle search with debounce effect
  const handleSearchChange = (value: string) => {
    setLocalSearch(value);
    onSearchChange?.(value);
  };

  // Quick filter handlers for time ranges
  const handleQuickFilter = (hours: 24 | 48 | 72) => {
    if (!onFiltersChange) return;
    
    const now = new Date();
    const endDate = new Date(now.getTime() + hours * 60 * 60 * 1000);
    
    // Use today as start date and calculate end date based on hours
    const startStr = format(now, 'yyyy-MM-dd');
    const endStr = format(endDate, 'yyyy-MM-dd');
    
    onFiltersChange({
      ...filters,
      startDate: startStr,
      endDate: endStr,
    });
  };

  return (
    <div className="h-full flex flex-col p-3 overflow-hidden">
      {/* Header: Title + Search + Tabs */}
      <div className="flex items-center justify-between mb-2 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Package className="h-5 w-5 text-muted-foreground" />
            <h2 className="font-semibold">Trips</h2>
          </div>
          {/* Quick Search */}
          <div className="flex items-center gap-2">
            <div className="relative w-48">
              <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search Order #..."
                className="pl-8 h-8 text-sm"
                value={localSearch}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>
            {/* Quick Filters */}
            {onFiltersChange && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => handleQuickFilter(24)}
                >
                  Next 24 hrs
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => handleQuickFilter(48)}
                >
                  Next 48 hrs
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => handleQuickFilter(72)}
                >
                  Next 72 hrs
                </Button>
              </div>
            )}
          </div>
        </div>
        <Tabs value={statusFilter} onValueChange={handleTabChange}>
          <TabsList className="bg-muted/50">
            <TabsTrigger 
              value="Open" 
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Open {loadCounts?.Open !== undefined && `(${loadCounts.Open})`}
            </TabsTrigger>
            <TabsTrigger 
              value="Assigned"
              className="data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              Assigned {loadCounts?.Assigned !== undefined && `(${loadCounts.Assigned})`}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Table */}
      <Card className="flex-1 min-h-0 overflow-hidden py-0">
        <div className="h-full overflow-y-auto">
          {/* Table Header - Sticky */}
          <div className="grid grid-cols-[100px_140px_1fr_100px_80px_100px] gap-4 px-4 py-2 border-b bg-muted/50 text-sm font-medium text-muted-foreground sticky top-0 z-10">
            <div>Order #</div>
            <div>Customer</div>
            <div>Route</div>
            <div>Equipment</div>
            <div>Miles</div>
            <div>Pickup</div>
          </div>

          {/* Loading state */}
          {isLoading && (
            <div className="p-4 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}

          {/* Empty state */}
          {!isLoading && loads.length === 0 && (
            <div className="p-8 text-center text-muted-foreground">
              <Package className="h-12 w-12 mx-auto mb-3 opacity-50" />
              <p>No {statusFilter.toLowerCase()} loads found</p>
            </div>
          )}

          {/* Table Rows - Compact */}
          {!isLoading &&
            loads.map((load) => (
              <div
                key={load._id}
                onClick={() => handleRowClick(load._id)}
                className={cn(
                  'grid grid-cols-[100px_140px_1fr_100px_80px_100px] gap-4 px-4 py-2 border-b cursor-pointer transition-colors',
                  'hover:bg-muted/50',
                  selectedLoadId === load._id && 'bg-primary/10 ring-2 ring-primary ring-inset'
                )}
              >
                {/* Order # */}
                <div className="font-medium text-sm truncate">
                  {load.orderNumber || load.internalId}
                </div>

                {/* Customer */}
                <div className="text-sm truncate">{load.customerName || '—'}</div>

                {/* Route */}
                <div className="text-sm text-muted-foreground truncate">
                  {load.origin?.city || '—'}, {load.origin?.state || ''} → {load.destination?.city || '—'}, {load.destination?.state || ''}
                </div>

                {/* Equipment */}
                <div>
                  {load.equipmentType ? (
                    <Badge variant="outline" className="text-xs">
                      {load.equipmentType}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>

                {/* Miles */}
                <div className="text-sm">{load.effectiveMiles ?? '—'}</div>

                {/* Pickup Date */}
                <div className="text-sm text-muted-foreground">
                  {load.firstStopDate ? formatDateOnly(load.firstStopDate).display : '—'}
                </div>
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}
