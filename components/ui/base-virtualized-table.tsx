'use client';

import { ReactNode, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

export interface BaseColumn<T> {
  key: string;
  header: ReactNode;
  /** Tailwind classes that control the column slot width (e.g. `flex-[1.5]`, `w-12`). */
  width: string;
  cell: (row: T, index: number) => ReactNode;
  /** Extra classes appended after the `px-4 min-w-0` baseline. The baseline always applies; tailwind-merge dedupes if the column overrides `px-*`, and `min-w-0` survives unless the column explicitly sets a different `min-w-*`. */
  cellClassName?: string;
  /** Extra classes applied to the header cell (defaults to `px-4 font-medium text-muted-foreground text-sm`). */
  headerClassName?: string;
}

interface BaseVirtualizedTableProps<T extends { _id: string }> {
  rows: T[];
  columns: BaseColumn<T>[];
  selectedIds: Set<string>;
  isAllSelected: boolean;
  onSelectAll: (checked: boolean) => void;
  onSelectRow: (id: string, checked: boolean) => void;
  onRowClick?: (row: T) => void;
  /** Optional: highlight a focused row for keyboard navigation. */
  focusedRowIndex?: number | null;
  rowHeight?: number;
  overscan?: number;
  emptyMessage?: string;
  /** Optional aria-label generator for the row checkbox. */
  rowAriaLabel?: (row: T) => string;
}

/**
 * Shared scaffolding for fleet/CRM virtualized tables: header bar with
 * select-all, fixed-height absolutely-positioned rows, and an empty state
 * that preserves the header. Per-resource visuals live in `columns[].cell`.
 */
export function BaseVirtualizedTable<T extends { _id: string }>({
  rows,
  columns,
  selectedIds,
  isAllSelected,
  onSelectAll,
  onSelectRow,
  onRowClick,
  focusedRowIndex = null,
  rowHeight = 56,
  overscan = 10,
  emptyMessage = 'No items found',
  rowAriaLabel,
}: BaseVirtualizedTableProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const headerRow = (
    <div className="flex-shrink-0 border-b bg-background">
      <div className="flex items-center h-10 w-full">
        <div className="px-2 w-12 flex items-center">
          <Checkbox
            checked={isAllSelected}
            onCheckedChange={onSelectAll}
            aria-label="Select all"
          />
        </div>
        {columns.map((col) => (
          <div
            key={col.key}
            className={cn(col.width, col.headerClassName ?? 'px-4 font-medium text-muted-foreground text-sm')}
          >
            {col.header}
          </div>
        ))}
      </div>
    </div>
  );

  if (rows.length === 0) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        {headerRow}
        <div className="flex-1 flex items-center justify-center py-12 text-muted-foreground">
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {headerRow}
      <div className="flex-1 overflow-auto" ref={parentRef}>
        <div className="relative" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            return (
              <div
                key={row._id}
                data-index={virtualRow.index}
                className={cn(
                  'absolute top-0 left-0 w-full cursor-pointer hover:bg-slate-50/80 transition-colors group border-b flex items-center',
                  focusedRowIndex === virtualRow.index && 'ring-2 ring-primary'
                )}
                style={{
                  height: `${rowHeight}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                onClick={(e) => {
                  if (!onRowClick) return;
                  if (!(e.target as HTMLElement).closest('input[type="checkbox"]')) {
                    onRowClick(row);
                  }
                }}
              >
                <div className="px-2 w-12 flex items-center" onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={selectedIds.has(row._id)}
                    onCheckedChange={(checked) => onSelectRow(row._id, checked as boolean)}
                    aria-label={rowAriaLabel?.(row) ?? 'Select row'}
                  />
                </div>
                {columns.map((col) => (
                  <div
                    key={col.key}
                    className={cn(col.width, 'px-4 min-w-0', col.cellClassName)}
                  >
                    {col.cell(row, virtualRow.index)}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
