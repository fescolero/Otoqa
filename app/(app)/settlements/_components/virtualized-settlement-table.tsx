'use client';

import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Id } from '@/convex/_generated/dataModel';
import { Checkbox } from '@/components/ui/checkbox';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { SettlementStatusBadge } from './settlement-status-badge';
import { cn } from '@/lib/utils';

interface Settlement {
  _id: Id<'driverSettlements'>;
  statementNumber: string;
  driverName: string;
  periodStart: number;
  periodEnd: number;
  periodLabel: string;
  payPlanName?: string;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'PAID' | 'VOID';
  grossTotal?: number;
  totalLoads?: number;
  hasWarnings: boolean;
  warningCount?: number;
}

interface VirtualizedSettlementTableProps {
  settlements: Settlement[];
  selectedIds: Set<Id<'driverSettlements'>>;
  focusedRowIndex: number | null;
  isAllSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onSelectRow: (id: Id<'driverSettlements'>, checked: boolean) => void;
  onRowClick: (id: Id<'driverSettlements'>) => void;
  formatDateRange: (start: number, end: number) => string;
  formatCurrency: (amount: number) => string;
  emptyMessage?: string;
}

export function VirtualizedSettlementTable({
  settlements,
  selectedIds,
  focusedRowIndex,
  isAllSelected,
  onSelectAll,
  onSelectRow,
  onRowClick,
  formatDateRange,
  formatCurrency,
  emptyMessage = 'No settlements found',
}: VirtualizedSettlementTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: settlements.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });

  // Header columns
  const HeaderRow = () => (
    <div className="flex items-center h-11 w-full text-xs font-medium text-slate-500 uppercase tracking-wider border-b bg-slate-50/50">
      <div className="px-3 w-12 flex items-center">
        <Checkbox
          checked={isAllSelected}
          onCheckedChange={onSelectAll}
          aria-label="Select all"
          className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
        />
      </div>
      <div className="px-4 w-[140px]">Statement #</div>
      <div className="px-4 w-[160px]">Driver</div>
      <div className="px-4 w-[120px]">Pay Plan</div>
      <div className="px-4 flex-1 min-w-[180px]">Period</div>
      <div className="px-4 w-[100px]">Status</div>
      <div className="px-4 w-[120px] text-right">Gross Pay</div>
      <div className="px-4 w-10"></div>
    </div>
  );

  if (settlements.length === 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <HeaderRow />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-center py-8 text-muted-foreground">{emptyMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Fixed Header */}
      <div className="flex-shrink-0">
        <HeaderRow />
      </div>
      
      {/* Scrollable Body */}
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const settlement = settlements[virtualRow.index];
            const index = virtualRow.index;
            const isSelected = selectedIds.has(settlement._id);

            return (
              <div
                key={settlement._id}
                data-index={virtualRow.index}
                className={cn(
                  'absolute top-0 left-0 w-full h-[52px] cursor-pointer transition-colors group border-b flex items-center',
                  isSelected 
                    ? 'bg-blue-50/50 hover:bg-blue-50' 
                    : 'hover:bg-slate-50/80',
                  focusedRowIndex === index && 'ring-2 ring-inset ring-blue-500'
                )}
                style={{
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={(e) => {
                  if (!(e.target as HTMLElement).closest('input[type="checkbox"]')) {
                    onRowClick(settlement._id);
                  }
                }}
              >
                {/* Checkbox */}
                <div className="px-3 w-12 flex items-center" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={(checked) => onSelectRow(settlement._id, checked as boolean)}
                    aria-label={`Select settlement ${settlement.statementNumber}`}
                    className="data-[state=checked]:bg-blue-600 data-[state=checked]:border-blue-600"
                  />
                </div>

                {/* Statement # - Clickable Blue Link */}
                <div className="px-4 w-[140px]">
                  <span className="text-sm font-medium text-blue-600 hover:text-blue-700 hover:underline cursor-pointer">
                    {settlement.statementNumber || `SET-${settlement._id.slice(-6).toUpperCase()}`}
                  </span>
                </div>

                {/* Driver Name */}
                <div className="px-4 w-[160px]">
                  <span className="text-sm font-medium text-slate-900 truncate block">
                    {settlement.driverName}
                  </span>
                </div>

                {/* Pay Plan */}
                <div className="px-4 w-[120px]">
                  {settlement.payPlanName ? (
                    <span className="text-xs text-slate-500 bg-slate-100 px-2 py-0.5 rounded truncate block">
                      {settlement.payPlanName}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">—</span>
                  )}
                </div>

                {/* Period - with Period Number if available */}
                <div className="px-4 flex-1 min-w-[180px]">
                  <span className="text-sm text-slate-700 font-medium">
                    {settlement.periodLabel || formatDateRange(settlement.periodStart, settlement.periodEnd)}
                  </span>
                </div>

                {/* Status */}
                <div className="px-4 w-[100px]">
                  <SettlementStatusBadge status={settlement.status} />
                </div>

                {/* Gross Pay - Right Aligned with tabular-nums */}
                <div className="px-4 w-[120px] text-right flex items-center justify-end gap-2">
                  <span className="text-sm font-semibold text-slate-900 tabular-nums">
                    {settlement.grossTotal !== undefined ? formatCurrency(settlement.grossTotal) : '$0.00'}
                  </span>
                  {/* Audit Warning Icon */}
                  {settlement.hasWarnings && (
                    <div className="flex items-center" title={`${settlement.warningCount || 0} warnings`}>
                      <AlertTriangle className="w-4 h-4 text-amber-500" />
                    </div>
                  )}
                </div>

                {/* Chevron - Reveal on hover */}
                <div className="px-4 w-10 flex items-center justify-center">
                  <ChevronRight className="w-4 h-4 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
