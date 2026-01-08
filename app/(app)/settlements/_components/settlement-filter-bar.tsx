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

export interface SettlementFilterState {
  search: string;
  driverId?: string;
  status?: string;
  payType?: string;
  payPlanId?: string;
  dateRange?: { start: number; end: number };
}

export interface SavedView {
  name: string;
  filters: SettlementFilterState;
}

interface Driver {
  _id: string;
  firstName: string;
  lastName: string;
}

interface PayPlan {
  _id: string;
  name: string;
}

interface SettlementFilterBarProps {
  filters: SettlementFilterState;
  onFiltersChange: (filters: SettlementFilterState) => void;
  drivers?: Driver[];
  payPlans?: PayPlan[];
  className?: string;
}

export function SettlementFilterBar({
  filters,
  onFiltersChange,
  drivers = [],
  payPlans = [],
  className,
}: SettlementFilterBarProps) {
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [newViewName, setNewViewName] = useState('');
  const [dateFrom, setDateFrom] = useState<Date | undefined>();
  const [dateTo, setDateTo] = useState<Date | undefined>();

  // Load saved views from localStorage
  useEffect(() => {
    const saved = localStorage.getItem('settlement-saved-views');
    if (saved) {
      setSavedViews(JSON.parse(saved));
    }
  }, []);

  // Save views to localStorage
  const saveSavedViews = (views: SavedView[]) => {
    localStorage.setItem('settlement-saved-views', JSON.stringify(views));
    setSavedViews(views);
  };

  const hasActiveFilters = filters.search || filters.driverId || filters.status || filters.payType || filters.payPlanId || filters.dateRange;
  const activeFilterCount = [
    filters.search,
    filters.driverId,
    filters.status,
    filters.payType,
    filters.payPlanId,
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
        'sticky top-0 z-40 bg-slate-50/50 border-y border-slate-200/60 px-4 py-3',
        'flex items-center gap-3',
        className
      )}
    >
      {/* Search Input */}
      <div className="relative w-full max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={2} />
        <Input
          placeholder="Search statements, drivers..."
          value={filters.search}
          onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
          className="pl-9 h-9 bg-white"
        />
      </div>

      {/* Driver Filter */}
      <Select
        value={filters.driverId || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, driverId: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-40 h-9 bg-white">
          <SelectValue placeholder="All Drivers" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Drivers</SelectItem>
          {drivers.map(driver => (
            <SelectItem key={driver._id} value={driver._id}>
              {driver.firstName} {driver.lastName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Status Filter */}
      <Select
        value={filters.status || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, status: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-36 h-9 bg-white">
          <SelectValue placeholder="All Statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Statuses</SelectItem>
          <SelectItem value="DRAFT">Draft</SelectItem>
          <SelectItem value="PENDING">Pending</SelectItem>
          <SelectItem value="APPROVED">Approved</SelectItem>
          <SelectItem value="PAID">Paid</SelectItem>
          <SelectItem value="VOID">Void</SelectItem>
        </SelectContent>
      </Select>

      {/* Pay Type Filter */}
      <Select
        value={filters.payType || 'all'}
        onValueChange={(value) => onFiltersChange({ ...filters, payType: value === 'all' ? undefined : value })}
      >
        <SelectTrigger className="w-36 h-9 bg-white">
          <SelectValue placeholder="All Pay Types" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Pay Types</SelectItem>
          <SelectItem value="mileage">Mileage</SelectItem>
          <SelectItem value="hourly">Hourly</SelectItem>
          <SelectItem value="flat">Flat Rate</SelectItem>
          <SelectItem value="percentage">Percentage</SelectItem>
        </SelectContent>
      </Select>

      {/* Pay Plan Filter */}
      {payPlans.length > 0 && (
        <Select
          value={filters.payPlanId || 'all'}
          onValueChange={(value) => onFiltersChange({ ...filters, payPlanId: value === 'all' ? undefined : value })}
        >
          <SelectTrigger className="w-40 h-9 bg-white">
            <SelectValue placeholder="All Plans" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Pay Plans</SelectItem>
            {payPlans.map(plan => (
              <SelectItem key={plan._id} value={plan._id}>
                {plan.name}
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
            placeholder="e.g., Weekly Payroll"
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

