'use client';

import { Checkbox } from '@/components/ui/checkbox';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';

export type SortField = 'hcr' | 'tripNumber' | 'ratePeriod' | 'status';
export type SortDirection = 'asc' | 'desc';

interface ContractLaneListHeaderProps {
  showCheckbox?: boolean;
  allSelected?: boolean;
  onSelectAll?: () => void;
  sortField?: SortField | null;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
}

function SortIndicator({ field, activeField, direction }: { field: SortField; activeField?: SortField | null; direction?: SortDirection }) {
  if (activeField !== field) {
    return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground/50" />;
  }
  return direction === 'asc'
    ? <ArrowUp className="h-3.5 w-3.5 text-foreground" />
    : <ArrowDown className="h-3.5 w-3.5 text-foreground" />;
}

export function ContractLaneListHeader({
  showCheckbox = false,
  allSelected = false,
  onSelectAll,
  sortField,
  sortDirection,
  onSort,
}: ContractLaneListHeaderProps) {
  const sortable = (field: SortField, label: string) => (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 hover:text-foreground transition-colors select-none"
      onClick={() => onSort?.(field)}
    >
      {label}
      <SortIndicator field={field} activeField={sortField} direction={sortDirection} />
    </button>
  );

  return (
    <div className="flex items-center gap-4 py-2.5 px-4 border-b bg-muted/50 font-medium text-sm text-muted-foreground min-w-[1000px] sticky top-0 z-10">
      <div className="w-10 flex-shrink-0">
        {showCheckbox && onSelectAll && (
          <Checkbox checked={allSelected} onCheckedChange={onSelectAll} />
        )}
      </div>

      <div className="flex-1 min-w-[150px]">{sortable('hcr', 'HCR')}</div>
      <div className="w-[150px] flex-shrink-0">{sortable('tripNumber', 'Trip Number')}</div>
      <div className="w-[220px] flex-shrink-0">{sortable('ratePeriod', 'Rate Period')}</div>
      <div className="w-[120px] flex-shrink-0">{sortable('status', 'Status')}</div>
      <div className="w-[180px] flex-shrink-0 text-right">Actions</div>
    </div>
  );
}
