'use client';

import { useCallback, useState, useEffect } from 'react';
import { Search, X, Calendar as CalendarIcon, Plus } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { format } from 'date-fns';
import { DateRange } from 'react-day-picker';
import { cn } from '@/lib/utils';

export interface TripFiltersState {
  search: string;
  hcr: string;
  tripNumber: string;
  startDate: string;
  endDate: string;
}

// ============================================
// SEARCH BAR (for Row 1 - Main Header)
// ============================================
interface TripSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function TripSearch({ value, onChange }: TripSearchProps) {
  return (
    <div className="relative w-56">
      <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
      <Input
        placeholder="Search orders..."
        className="pl-8 h-8 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

// ============================================
// FILTER TOOLBAR (for Row 2 - Sub-header)
// ============================================
interface FilterToolbarProps {
  filters: TripFiltersState;
  onFiltersChange: (filters: TripFiltersState) => void;
}

export function FilterToolbar({ filters, onFiltersChange }: FilterToolbarProps) {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    if (filters.startDate || filters.endDate) {
      return {
        from: filters.startDate ? new Date(filters.startDate + 'T00:00:00') : undefined,
        to: filters.endDate ? new Date(filters.endDate + 'T00:00:00') : undefined,
      };
    }
    return undefined;
  });
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);

  // Sync dateRange with filters when filters change externally
  useEffect(() => {
    if (filters.startDate || filters.endDate) {
      setDateRange({
        from: filters.startDate ? new Date(filters.startDate + 'T00:00:00') : undefined,
        to: filters.endDate ? new Date(filters.endDate + 'T00:00:00') : undefined,
      });
    } else {
      setDateRange(undefined);
    }
  }, [filters.startDate, filters.endDate]);

  const hasActiveFilters = filters.hcr || filters.tripNumber || filters.startDate || filters.endDate;

  const handleHcrChange = (value: string) => {
    onFiltersChange({ ...filters, hcr: value });
  };

  const handleTripNumberChange = (value: string) => {
    onFiltersChange({ ...filters, tripNumber: value });
  };

  const handleDateSelect = (range: DateRange | undefined) => {
    setDateRange(range);
    // Update filters immediately when date is selected
    if (range?.from) {
      const startStr = format(range.from, 'yyyy-MM-dd');
      const endStr = range.to ? format(range.to, 'yyyy-MM-dd') : startStr;
      onFiltersChange({
        ...filters,
        startDate: startStr,
        endDate: endStr,
      });
    } else {
      // Clear dates if range is cleared
      onFiltersChange({
        ...filters,
        startDate: '',
        endDate: '',
      });
    }
  };

  const clearHcr = () => onFiltersChange({ ...filters, hcr: '' });
  const clearTripNumber = () => onFiltersChange({ ...filters, tripNumber: '' });
  const clearDateRange = () => {
    setDateRange(undefined);
    onFiltersChange({ ...filters, startDate: '', endDate: '' });
  };

  const clearAll = () => {
    setDateRange(undefined);
    onFiltersChange({
      ...filters,
      hcr: '',
      tripNumber: '',
      startDate: '',
      endDate: '',
    });
  };

  const formatDateDisplay = () => {
    if (!filters.startDate) return null;
    // Parse dates with explicit time to avoid timezone issues
    const start = new Date(filters.startDate + 'T00:00:00');
    const end = filters.endDate ? new Date(filters.endDate + 'T00:00:00') : start;
    if (filters.startDate === filters.endDate) {
      return format(start, 'MM/dd/yy');
    }
    return `${format(start, 'MM/dd/yy')} - ${format(end, 'MM/dd/yy')}`;
  };

  return (
    <div className="flex items-center gap-2 bg-muted/30 px-3 py-1.5 text-xs border-b">
      <span className="font-medium text-muted-foreground shrink-0">Filter by:</span>

      {/* HCR # Filter */}
      <div className="flex items-center gap-1.5 border rounded-md bg-background px-2 py-1 h-7">
        <span className="text-muted-foreground shrink-0">HCR #</span>
        <input
          className="outline-none w-16 bg-transparent text-xs"
          placeholder="917DK"
          value={filters.hcr}
          onChange={(e) => handleHcrChange(e.target.value)}
        />
        {filters.hcr && (
          <button onClick={clearHcr} className="text-muted-foreground/50 hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Trip # Filter */}
      <div className="flex items-center gap-1.5 border rounded-md bg-background px-2 py-1 h-7">
        <span className="text-muted-foreground shrink-0">Trip #</span>
        <input
          className="outline-none w-12 bg-transparent text-xs"
          placeholder="201"
          value={filters.tripNumber}
          onChange={(e) => handleTripNumberChange(e.target.value)}
        />
        {filters.tripNumber && (
          <button onClick={clearTripNumber} className="text-muted-foreground/50 hover:text-foreground">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Date Range Filter */}
      <div className="flex items-center">
        <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
          <PopoverTrigger asChild>
            <button
              className={cn(
                'flex items-center gap-1.5 border rounded-md bg-background px-2 py-1 h-7 text-xs',
                filters.startDate && 'rounded-r-none'
              )}
            >
              <CalendarIcon className="h-3 w-3 text-muted-foreground" />
              {formatDateDisplay() || <span className="text-muted-foreground">Date range</span>}
            </button>
          </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="range"
            defaultMonth={dateRange?.from}
            selected={dateRange}
            onSelect={handleDateSelect}
            numberOfMonths={2}
          />
          <div className="flex items-center justify-end gap-2 p-3 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                clearDateRange();
                setDatePopoverOpen(false);
              }}
            >
              Clear
            </Button>
            <Button size="sm" onClick={() => setDatePopoverOpen(false)}>
              Apply
            </Button>
          </div>
        </PopoverContent>
        </Popover>
        {filters.startDate && (
          <button
            onClick={clearDateRange}
            className="flex items-center justify-center border-y border-r rounded-r-md bg-background px-1.5 h-7 text-muted-foreground/50 hover:text-foreground hover:bg-muted/50"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Clear All */}
      {hasActiveFilters && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs text-primary hover:text-primary/80 px-2"
          onClick={clearAll}
        >
          Clear all
        </Button>
      )}
    </div>
  );
}

// Legacy export for backward compatibility
export function TripFilters() {
  return null;
}

export function ActiveFilterPills() {
  return null;
}
