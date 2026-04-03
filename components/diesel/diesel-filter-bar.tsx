'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { CalendarIcon, Search, X, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect, useRef, useCallback } from 'react';
import { format } from 'date-fns';

export interface DieselFilterState {
  search: string;
  driverId?: string;
  carrierId?: string;
  truckId?: string;
  vendorId?: string;
  dateRange?: { start: number; end: number };
}

interface Driver {
  _id: string;
  firstName: string;
  lastName: string;
}

interface Carrier {
  _id: string;
  name: string;
}

interface Truck {
  _id: string;
  unitId: string;
}

interface Vendor {
  _id: string;
  name: string;
}

interface DieselFilterBarProps {
  filters: DieselFilterState;
  onFiltersChange: (filters: DieselFilterState) => void;
  drivers?: Driver[];
  carriers?: Carrier[];
  trucks?: Truck[];
  vendors?: Vendor[];
  className?: string;
}

export function DieselFilterBar({
  filters,
  onFiltersChange,
  drivers = [],
  carriers = [],
  trucks = [],
  vendors = [],
  className,
}: DieselFilterBarProps) {
  const [localSearch, setLocalSearch] = useState(filters.search);
  const [dateFrom, setDateFrom] = useState<Date | undefined>(
    filters.dateRange ? new Date(filters.dateRange.start) : undefined,
  );
  const [dateTo, setDateTo] = useState<Date | undefined>(
    filters.dateRange ? new Date(filters.dateRange.end) : undefined,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local search when parent resets filters
  useEffect(() => {
    setLocalSearch(filters.search);
  }, [filters.search]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setLocalSearch(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        onFiltersChange({ ...filters, search: value });
      }, 300);
    },
    [filters, onFiltersChange],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const hasActiveFilters =
    filters.search || filters.driverId || filters.carrierId || filters.truckId || filters.vendorId || filters.dateRange;

  const activeFilterCount = [
    filters.search,
    filters.driverId,
    filters.carrierId,
    filters.truckId,
    filters.vendorId,
    filters.dateRange,
  ].filter(Boolean).length;

  const handleClearAll = () => {
    onFiltersChange({ search: '' });
    setLocalSearch('');
    setDateFrom(undefined);
    setDateTo(undefined);
  };

  const handleDateRangeApply = () => {
    if (dateFrom && dateTo) {
      const start = new Date(dateFrom);
      start.setHours(0, 0, 0, 0);

      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);

      onFiltersChange({
        ...filters,
        dateRange: {
          start: start.getTime(),
          end: end.getTime(),
        },
      });
    }
  };

  return (
    <div
      className={cn(
        'sticky top-0 z-40 bg-slate-50/50 border-y border-slate-200/60 px-4 py-3',
        'flex items-center gap-3',
        className,
      )}
    >
      {/* Search */}
      <div className="relative w-full max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={2} />
        <Input
          placeholder="Search entries, drivers, vendors..."
          value={localSearch}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="pl-9 h-9 bg-white"
        />
      </div>

      {/* Driver Filter */}
      {drivers.length > 0 && (
        <Select
          value={filters.driverId || 'all'}
          onValueChange={(value) => onFiltersChange({ ...filters, driverId: value === 'all' ? undefined : value })}
        >
          <SelectTrigger className="w-40 h-9 bg-white">
            <SelectValue placeholder="All Drivers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Drivers</SelectItem>
            {drivers.map((driver) => (
              <SelectItem key={driver._id} value={driver._id}>
                {driver.firstName} {driver.lastName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Carrier Filter */}
      {carriers.length > 0 && (
        <Select
          value={filters.carrierId || 'all'}
          onValueChange={(value) => onFiltersChange({ ...filters, carrierId: value === 'all' ? undefined : value })}
        >
          <SelectTrigger className="w-40 h-9 bg-white">
            <SelectValue placeholder="All Carriers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Carriers</SelectItem>
            {carriers.map((carrier) => (
              <SelectItem key={carrier._id} value={carrier._id}>
                {carrier.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Truck Filter */}
      {trucks.length > 0 && (
        <Select
          value={filters.truckId || 'all'}
          onValueChange={(value) => onFiltersChange({ ...filters, truckId: value === 'all' ? undefined : value })}
        >
          <SelectTrigger className="w-36 h-9 bg-white">
            <SelectValue placeholder="All Trucks" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Trucks</SelectItem>
            {trucks.map((truck) => (
              <SelectItem key={truck._id} value={truck._id}>
                {truck.unitId}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Vendor Filter */}
      {vendors.length > 0 && (
        <Select
          value={filters.vendorId || 'all'}
          onValueChange={(value) => onFiltersChange({ ...filters, vendorId: value === 'all' ? undefined : value })}
        >
          <SelectTrigger className="w-40 h-9 bg-white">
            <SelectValue placeholder="All Vendors" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Vendors</SelectItem>
            {vendors.map((vendor) => (
              <SelectItem key={vendor._id} value={vendor._id}>
                {vendor.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Date Range Filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-9 justify-start text-left font-normal bg-white',
              !filters.dateRange && 'text-muted-foreground',
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {filters.dateRange
              ? `${format(filters.dateRange.start, 'MMM d')} - ${format(filters.dateRange.end, 'MMM d')}`
              : 'Date Range'}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="p-3 space-y-3">
            <div>
              <label className="text-sm font-medium mb-2 block">From</label>
              <Calendar mode="single" selected={dateFrom} onSelect={setDateFrom} initialFocus />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">To</label>
              <Calendar mode="single" selected={dateTo} onSelect={setDateTo} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleDateRangeApply} disabled={!dateFrom || !dateTo} className="flex-1">
                Apply
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDateFrom(undefined);
                  setDateTo(undefined);
                  onFiltersChange({ ...filters, dateRange: undefined });
                }}
                className="flex-1"
              >
                Clear
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Clear All */}
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={handleClearAll} className="h-9">
          <X className="w-4 h-4 mr-2" />
          Clear All
        </Button>
      )}

      <div className="flex-1" />

      {/* Active filter count */}
      {hasActiveFilters && (
        <div className="text-sm text-muted-foreground flex items-center gap-1">
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount} {activeFilterCount === 1 ? 'filter' : 'filters'}
        </div>
      )}
    </div>
  );
}
