/**
 * TableToolbar — search + filter trigger + columns button strip.
 *
 * Two-row layout: row 1 is fixed-height (56px) with the search input,
 * a `filterTrigger` slot (typically the FilterBar's "+ Filter" button when
 * no chips), `rightContent`, and the columns button. Row 2 (children)
 * renders any active filter chips with horizontal padding.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon } from './icons';
import { Kbd } from './kbd';
import { ColumnsButton, type ColumnDef } from './columns-button';

interface TableToolbarProps {
  searchPlaceholder?: string;
  searchValue?: string;
  onSearchChange?: (v: string) => void;
  filterTrigger?: React.ReactNode;
  rightContent?: React.ReactNode;
  columns?: ColumnDef[];
  visibleColumns?: Set<string>;
  onVisibleColumnsChange?: (next: Set<string>) => void;
  /** Filter chips row. */
  children?: React.ReactNode;
  className?: string;
}

export function TableToolbar({
  searchPlaceholder = 'Search…',
  searchValue,
  onSearchChange,
  filterTrigger,
  rightContent,
  columns,
  visibleColumns,
  onVisibleColumnsChange,
  children,
  className,
}: TableToolbarProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Global "/" shortcut to focus search.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={cn('bg-card border-b border-[var(--border-hairline)]', className)}>
      <div className="h-14 px-6 flex items-center gap-2">
        <div
          className={cn(
            'flex items-center gap-2 w-[280px] shrink-0 h-8 px-2.5 rounded-lg',
            'bg-[var(--bg-surface-2)] border border-[var(--border-hairline)]',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:border-[var(--border-hairline-strong)]',
          )}
        >
          <WIcon name="search" size={14} className="text-[var(--text-tertiary)]" />
          <input
            ref={inputRef}
            value={searchValue ?? ''}
            onChange={(e) => onSearchChange?.(e.target.value)}
            placeholder={searchPlaceholder}
            className="flex-1 bg-transparent border-0 outline-0 text-[12.5px] text-foreground h-8"
          />
          <Kbd>/</Kbd>
        </div>
        {filterTrigger}
        <div className="flex-1" />
        {rightContent}
        {columns && visibleColumns && onVisibleColumnsChange && (
          <ColumnsButton columns={columns} visible={visibleColumns} onChange={onVisibleColumnsChange} />
        )}
      </div>
      {children && (
        <div className="px-6 pb-3 flex items-center gap-2 flex-wrap">{children}</div>
      )}
    </div>
  );
}
