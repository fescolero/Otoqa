'use client';

import { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * Wrapper for the simple filter-bar shape used by carrier/customer/trailer/truck
 * lists: light slate background, 6-unit vertical padding, horizontal flex with
 * gap. Use this when you don't need the sticky-header / clear-all / saved-views
 * features; for those, see the driver and load filter bars.
 */
export function FilterBarShell({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('bg-slate-50/50 border-y border-slate-200/60 px-4 py-6', className)}>
      <div className="flex items-center gap-3 flex-wrap">{children}</div>
    </div>
  );
}

interface FilterSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/** Standardized search input used by every filter bar. */
export function FilterSearch({ value, onChange, placeholder, className }: FilterSearchProps) {
  return (
    <div className={cn('relative w-full max-w-md', className)}>
      <Search
        className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        strokeWidth={2}
      />
      <Input
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-9 h-9 bg-white"
      />
    </div>
  );
}

export interface FilterSelectOption {
  value: string;
  label: string;
}

interface FilterSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  options: FilterSelectOption[];
  /** Trigger width class, e.g. 'w-32', 'w-40'. */
  triggerClassName?: string;
}

/**
 * Standardized Select used by filter bars. Caller is responsible for the
 * canonical "all" sentinel — pass it in `options` if you want it visible.
 */
export function FilterSelect({
  value,
  onValueChange,
  placeholder,
  options,
  triggerClassName = 'w-36',
}: FilterSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className={cn(triggerClassName, 'h-9 bg-white')}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
