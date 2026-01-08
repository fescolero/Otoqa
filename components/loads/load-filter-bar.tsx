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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Search, X, Filter, Save, Calendar as CalendarIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useState, useEffect } from 'react';
import { format } from 'date-fns';

export interface LoadFilterState {
  search: string;
  hcr?: string;
  trip?: string;
  mileRange?: string;
  dateRange?: { start: number; end: number };
}

export interface SavedView {
  name: string;
  filters: LoadFilterState;
}

interface LoadFilterBarProps {
  filters: LoadFilterState;
  onFiltersChange: (filters: LoadFilterState) => void;
  availableHCRs?: string[];
  availableTrips?: string[];
  className?: string;
}

export function LoadFilterBar({
  filters,
  onFiltersChange,
  availableHCRs = [],
  availableTrips = [],
  className,
}: LoadFilterBarProps) {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();

  // Load saved views from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('load-saved-views');
    if (saved) {
      setSavedViews(JSON.parse(saved));
    }
  }, []);

  // Save views to localStorage
  const saveSavedViews = (views: SavedView[]) => {
    localStorage.setItem('load-saved-views', JSON.stringify(views));
    setSavedViews(views);
  };

  const hasActiveFilters = filters.search || filters.hcr || filters.trip || filters.mileRange || filters.dateRange;
  const activeFilterCount = [
    filters.search,
    filters.hcr,
    filters.trip,
    filters.mileRange,
    filters.dateRange,
  ].filter(Boolean).length;

  const handleClearAll = () => {
    onFiltersChange({ search: '' });
    setDateFrom(undefined);
    setDateTo(undefined);
  };

  const handleSaveView = () => {
    if (newViewName.trim()) {
      const newView: SavedView = {
        name: newViewName.trim(),
        filters: { ...filters },
      };
      saveSavedViews([...savedViews, newView]);
      setNewViewName('');
      setShowSaveDialog(false);
    }
  };

  const handleLoadView = (view: SavedView) => {
    onFiltersChange(view.filters);
    if (view.filters.dateRange) {
      setDateFrom(new Date(view.filters.dateRange.start));
      setDateTo(new Date(view.filters.dateRange.end));
    }
  };

  const handleDeleteView = (viewName: string) => {
    saveSavedViews(savedViews.filter(v => v.name !== viewName));
  };

  const handleDateRangeApply = () => {
    if (dateFrom && dateTo) {
      onFiltersChange({
        ...filters,
        dateRange: {
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
          placeholder="Search order #, customer, city..."
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          className="pl-9 h-9 bg-white"
        />
      </div>

      {/* HCR Filter */}
      <Select
        value={filters.hcr || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, hcr: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-32 h-9">
          <SelectValue placeholder="HCR" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All HCRs</SelectItem>
          {availableHCRs.map(hcr => (
            <SelectItem key={hcr} value={hcr}>{hcr}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Trip Filter */}
      <Select
        value={filters.trip || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, trip: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-32 h-9">
          <SelectValue placeholder="Trip" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Trips</SelectItem>
          {availableTrips.map(trip => (
            <SelectItem key={trip} value={trip}>{trip}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Mile Range Filter */}
      <Select
        value={filters.mileRange || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, mileRange: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-36 h-9">
          <SelectValue placeholder="Mile Range" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Miles</SelectItem>
          <SelectItem value="0-100">0-100 miles</SelectItem>
          <SelectItem value="100-250">100-250 miles</SelectItem>
          <SelectItem value="250-500">250-500 miles</SelectItem>
          <SelectItem value="500+">500+ miles</SelectItem>
        </SelectContent>
      </Select>

      {/* Date Range Filter */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={cn(
              'h-9 justify-start text-left font-normal',
              !filters.dateRange && 'text-muted-foreground'
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {filters.dateRange ? (
              `${format(filters.dateRange.start, 'MMM d')} - ${format(filters.dateRange.end, 'MMM d')}`
            ) : (
              'Date Range'
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

      {/* Saved Views Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-9">
            <Save className="w-4 h-4 mr-2" strokeWidth={2} />
            Views
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Saved Views</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {savedViews.length === 0 ? (
            <div className="px-2 py-6 text-center text-sm text-muted-foreground">
              No saved views
            </div>
          ) : (
            savedViews.map((view) => (
              <div key={view.name} className="flex items-center justify-between px-2 py-1.5 hover:bg-accent group">
                <button
                  onClick={() => handleLoadView(view)}
                  className="flex-1 text-left text-sm"
                >
                  {view.name}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteView(view.name)}
                  className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            ))
          )}
          <DropdownMenuSeparator />
          {hasActiveFilters && (
            <DropdownMenuItem onClick={() => setShowSaveDialog(!showSaveDialog)}>
              <Save className="mr-2 h-4 w-4" />
              Save Current View
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Save View Dialog */}
      {showSaveDialog && (
        <div className="absolute right-4 top-16 z-50 w-64 rounded-md border bg-popover p-4 shadow-md">
          <label className="text-sm font-medium mb-2 block">View Name</label>
          <Input
            placeholder="e.g., Long Haul Routes"
            value={newViewName}
            onChange={(e) => setNewViewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSaveView()}
            className="mb-3"
            autoFocus
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleSaveView} disabled={!newViewName.trim()} className="flex-1">
              Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowSaveDialog(false)} className="flex-1">
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
