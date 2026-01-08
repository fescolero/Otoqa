'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Search, X, Filter, Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState } from 'react';
import { format } from 'date-fns';

export interface DriverFilterState {
  search: string;
  licenseClass?: string;
  state?: string;
  employmentType?: string;
  expirationStatus?: string;
  hireDateRange?: { start: number; end: number };
}

interface DriverFilterBarProps {
  filters: DriverFilterState;
  onFiltersChange: (filters: DriverFilterState) => void;
  availableStates?: string[];
  className?: string;
}

export function DriverFilterBar({
  filters,
  onFiltersChange,
  availableStates = [],
  className,
}: DriverFilterBarProps) {
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();

  const hasActiveFilters = 
    filters.search || 
    filters.licenseClass || 
    filters.state || 
    filters.employmentType || 
    filters.expirationStatus ||
    filters.hireDateRange;

  const activeFilterCount = [
    filters.search,
    filters.licenseClass,
    filters.state,
    filters.employmentType,
    filters.expirationStatus,
    filters.hireDateRange,
  ].filter(Boolean).length;

  const handleClearAll = () => {
    onFiltersChange({ search: '' });
    setDateFrom(undefined);
    setDateTo(undefined);
  };

  const handleDateRangeApply = () => {
    if (dateFrom && dateTo) {
      onFiltersChange({
        ...filters,
        hireDateRange: {
          start: dateFrom.getTime(),
          end: dateTo.getTime(),
        },
      });
    }
  };

  return (
    <div
      className={cn(
        'sticky top-0 z-40 bg-slate-50/50 border-y border-slate-200/60 px-4 py-6',
        'flex items-center gap-3',
        className
      )}
    >
      {/* Search Input */}
      <div className="relative w-full max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={2} />
        <Input
          placeholder="Search name, email, phone, license..."
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          className="pl-9 h-9 bg-white"
        />
      </div>

      {/* License Class Filter */}
      <Select
        value={filters.licenseClass || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, licenseClass: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-36 h-9">
          <SelectValue placeholder="License Class" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Classes</SelectItem>
          <SelectItem value="Class A">Class A</SelectItem>
          <SelectItem value="Class B">Class B</SelectItem>
          <SelectItem value="Class C">Class C</SelectItem>
        </SelectContent>
      </Select>

      {/* State Filter */}
      <Select
        value={filters.state || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, state: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-32 h-9">
          <SelectValue placeholder="State" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All States</SelectItem>
          {availableStates.map(state => (
            <SelectItem key={state} value={state}>{state}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Employment Type Filter */}
      <Select
        value={filters.employmentType || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, employmentType: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-36 h-9">
          <SelectValue placeholder="Employment" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Types</SelectItem>
          <SelectItem value="Full-time">Full-time</SelectItem>
          <SelectItem value="Part-time">Part-time</SelectItem>
          <SelectItem value="Contract">Contract</SelectItem>
        </SelectContent>
      </Select>

      {/* Expiration Status Filter */}
      <Select
        value={filters.expirationStatus || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, expirationStatus: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-40 h-9">
          <SelectValue placeholder="Expiration" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Status</SelectItem>
          <SelectItem value="valid">Valid</SelectItem>
          <SelectItem value="expiring">Expiring Soon</SelectItem>
          <SelectItem value="expired">Expired</SelectItem>
        </SelectContent>
      </Select>

      {/* Hire Date Range Filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-9 justify-start text-left font-normal',
              !filters.hireDateRange && 'text-muted-foreground'
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {filters.hireDateRange ? (
              `${format(filters.hireDateRange.start, 'MMM d')} - ${format(filters.hireDateRange.end, 'MMM d')}`
            ) : (
              'Hire Date'
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <div className="p-3 space-y-3">
            <div>
              <label className="text-sm font-medium mb-2 block">From</label>
              <Calendar
                mode="single"
                selected={dateFrom}
                onSelect={setDateFrom}
                initialFocus
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-2 block">To</label>
              <Calendar
                mode="single"
                selected={dateTo}
                onSelect={setDateTo}
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleDateRangeApply}
                disabled={!dateFrom || !dateTo}
                className="flex-1"
              >
                Apply
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDateFrom(undefined);
                  setDateTo(undefined);
                  onFiltersChange({ ...filters, hireDateRange: undefined });
                }}
                className="flex-1"
              >
                Clear
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Clear All Button */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearAll}
          className="h-9"
        >
          <X className="w-4 h-4 mr-2" />
          Clear All
        </Button>
      )}

      {/* Spacer */}
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
