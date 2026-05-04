/**
 * Table — the canonical Otoqa Web list table.
 *
 * - Sticky header (CSS `position: sticky`)
 * - Sortable columns (caret rotates on desc)
 * - Multi-select via leading checkbox column (28px)
 * - Density-aware row height (compact 36 / comfortable 52)
 * - `activeRowId` highlights the row whose details are open (inset accent
 *   border on the leading edge)
 * - Optional virtualization via @tanstack/react-virtual; auto-on when
 *   row count exceeds `virtualizeThreshold` (default 200) so small lists
 *   stay simple. Heights are deterministic from density tokens, so we use
 *   a fixed `estimateSize` and skip `measureElement`.
 *
 * Render columns either by `key` (uses `row[key]`) or by `render(row)`.
 * Right-aligned numeric columns set `tnum: true` for tabular nums.
 */

import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { WIcon } from './icons';
import { Checkbox } from './checkbox';

export type Density = 'compact' | 'comfortable';
export type SortDir = 'asc' | 'desc';

export interface TableColumn<R extends { id: string | number }> {
  key: string;
  label: React.ReactNode;
  width?: string;
  align?: 'left' | 'right';
  sortable?: boolean;
  tnum?: boolean;
  render?: (row: R) => React.ReactNode;
}

interface TableProps<R extends { id: string | number }> {
  columns: TableColumn<R>[];
  rows: R[];
  density?: Density;
  selected?: Array<R['id']>;
  onSelect?: (id: R['id']) => void;
  onSelectAll?: () => void;
  sortKey?: string;
  sortDir?: SortDir;
  onSort?: (key: string) => void;
  onRowClick?: (row: R) => void;
  activeRowId?: R['id'] | null;
  /** Force virtualization on/off; default = auto (rows.length >= virtualizeThreshold). */
  virtualize?: boolean;
  virtualizeThreshold?: number;
  className?: string;
}

const ROW_H: Record<Density, number> = { compact: 36, comfortable: 52 };
const HEAD_PY: Record<Density, number> = { compact: 10, comfortable: 12 };
const CELL_PY: Record<Density, number> = { compact: 8, comfortable: 14 };

export function Table<R extends { id: string | number }>({
  columns,
  rows,
  density = 'compact',
  selected = [],
  onSelect,
  onSelectAll,
  sortKey,
  sortDir,
  onSort,
  onRowClick,
  activeRowId,
  virtualize,
  virtualizeThreshold = 200,
  className,
}: TableProps<R>) {
  const grid = ['28px', ...columns.map((c) => c.width ?? '1fr')].join(' ');
  const allChecked = rows.length > 0 && selected.length === rows.length;
  const indeterminate = selected.length > 0 && !allChecked;
  const shouldVirtualize = virtualize ?? rows.length >= virtualizeThreshold;

  const scrollRef = React.useRef<HTMLDivElement>(null);

  return (
    <div ref={scrollRef} className={cn('scroll-thin flex-1 overflow-auto bg-card', className)}>
      <Header
        columns={columns}
        grid={grid}
        density={density}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={onSort}
        allChecked={allChecked}
        indeterminate={indeterminate}
        onSelectAll={onSelectAll}
      />
      {shouldVirtualize ? (
        <VirtualBody
          scrollRef={scrollRef}
          columns={columns}
          rows={rows}
          grid={grid}
          density={density}
          selected={new Set(selected)}
          onSelect={onSelect}
          onRowClick={onRowClick}
          activeRowId={activeRowId ?? null}
        />
      ) : (
        <PlainBody
          columns={columns}
          rows={rows}
          grid={grid}
          density={density}
          selected={new Set(selected)}
          onSelect={onSelect}
          onRowClick={onRowClick}
          activeRowId={activeRowId ?? null}
        />
      )}
    </div>
  );
}

// ─── Header ─────────────────────────────────────────────────────────────

interface HeaderProps<R extends { id: string | number }> {
  columns: TableColumn<R>[];
  grid: string;
  density: Density;
  sortKey?: string;
  sortDir?: SortDir;
  onSort?: (key: string) => void;
  allChecked: boolean;
  indeterminate: boolean;
  onSelectAll?: () => void;
}

function Header<R extends { id: string | number }>({
  columns,
  grid,
  density,
  sortKey,
  sortDir,
  onSort,
  allChecked,
  indeterminate,
  onSelectAll,
}: HeaderProps<R>) {
  const py = HEAD_PY[density];
  return (
    <div
      className={cn(
        'grid sticky top-0 z-[2] bg-[var(--bg-surface-2)]',
        'border-b border-[var(--border-hairline)]',
      )}
      style={{ gridTemplateColumns: grid }}
    >
      <div className="flex items-center justify-center" style={{ padding: `${py}px 0` }}>
        <Checkbox
          checked={allChecked}
          indeterminate={indeterminate}
          onChange={() => onSelectAll?.()}
          ariaLabel="Select all rows"
        />
      </div>
      {columns.map((c) => {
        const sorting = sortKey === c.key;
        const sortable = c.sortable !== false;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => sortable && onSort?.(c.key)}
            className={cn(
              'flex items-center gap-1 bg-transparent border-0 transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
              'tw-label',
              c.align === 'right' ? 'justify-end text-right' : 'justify-start text-left',
              sortable ? 'cursor-pointer hover:text-foreground' : 'cursor-default',
              sorting ? 'text-foreground' : 'text-[var(--text-tertiary)]',
            )}
            style={{ padding: `${py}px var(--tbl-cell-px)` }}
          >
            {c.label}
            {sortable && (
              <span
                aria-hidden
                className="inline-flex transition-all duration-[var(--dur)] ease-[var(--ease-spring)]"
                style={{
                  opacity: sorting ? 1 : 0,
                  transform: sorting && sortDir === 'desc' ? 'rotate(180deg)' : 'rotate(0deg)',
                }}
              >
                <WIcon name="chevron-down" size={11} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── Plain (non-virtualized) body ───────────────────────────────────────

interface BodyProps<R extends { id: string | number }> {
  columns: TableColumn<R>[];
  rows: R[];
  grid: string;
  density: Density;
  selected: Set<R['id']>;
  onSelect?: (id: R['id']) => void;
  onRowClick?: (row: R) => void;
  activeRowId: R['id'] | null;
}

function PlainBody<R extends { id: string | number }>(p: BodyProps<R>) {
  return (
    <div>
      {p.rows.map((row) => (
        <Row
          key={String(row.id)}
          row={row}
          columns={p.columns}
          grid={p.grid}
          density={p.density}
          isSelected={p.selected.has(row.id)}
          onSelect={p.onSelect}
          onRowClick={p.onRowClick}
          isActive={p.activeRowId === row.id}
          virtualHeight={undefined}
          translateY={undefined}
        />
      ))}
    </div>
  );
}

// ─── Virtualized body ───────────────────────────────────────────────────

function VirtualBody<R extends { id: string | number }>(
  p: BodyProps<R> & { scrollRef: React.RefObject<HTMLDivElement | null> },
) {
  const rowH = ROW_H[p.density];
  const virtualizer = useVirtualizer({
    count: p.rows.length,
    getScrollElement: () => p.scrollRef.current,
    estimateSize: () => rowH,
    overscan: 20,
  });
  const items = virtualizer.getVirtualItems();
  return (
    <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
      {items.map((vr) => {
        const row = p.rows[vr.index];
        return (
          <Row
            key={String(row.id)}
            row={row}
            columns={p.columns}
            grid={p.grid}
            density={p.density}
            isSelected={p.selected.has(row.id)}
            onSelect={p.onSelect}
            onRowClick={p.onRowClick}
            isActive={p.activeRowId === row.id}
            virtualHeight={vr.size}
            translateY={vr.start}
          />
        );
      })}
    </div>
  );
}

// ─── Row ────────────────────────────────────────────────────────────────

interface RowProps<R extends { id: string | number }> {
  row: R;
  columns: TableColumn<R>[];
  grid: string;
  density: Density;
  isSelected: boolean;
  onSelect?: (id: R['id']) => void;
  onRowClick?: (row: R) => void;
  isActive: boolean;
  virtualHeight: number | undefined;
  translateY: number | undefined;
}

function Row<R extends { id: string | number }>({
  row,
  columns,
  grid,
  density,
  isSelected,
  onSelect,
  onRowClick,
  isActive,
  virtualHeight,
  translateY,
}: RowProps<R>) {
  const cellPy = CELL_PY[density];
  const minHeight = ROW_H[density];
  const isVirtual = virtualHeight != null;

  const tinted = isActive || isSelected;

  return (
    <div
      role="row"
      aria-selected={isSelected || undefined}
      data-active={isActive || undefined}
      onClick={() => onRowClick?.(row)}
      className={cn(
        'grid items-center border-b border-[var(--border-hairline)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        onRowClick ? 'cursor-pointer' : 'cursor-default',
        tinted ? 'bg-[var(--bg-sidebar-active)]' : 'hover:bg-[var(--bg-row-hover)]',
      )}
      style={{
        gridTemplateColumns: grid,
        minHeight,
        boxShadow: isActive ? 'inset 2px 0 0 var(--accent)' : undefined,
        ...(isVirtual && {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: virtualHeight,
          transform: `translateY(${translateY}px)`,
        }),
      }}
    >
      <div
        className="flex items-center justify-center"
        onClick={(e) => e.stopPropagation()}
      >
        <Checkbox
          checked={isSelected}
          onChange={() => onSelect?.(row.id)}
          ariaLabel={`Select row ${row.id}`}
        />
      </div>
      {columns.map((c) => (
        <div
          key={c.key}
          className={cn(
            'flex items-center min-w-0 gap-1.5 text-[13px] text-foreground',
            c.tnum && 'num',
            c.align === 'right' ? 'justify-end' : 'justify-start',
          )}
          style={{ padding: `${cellPy}px var(--tbl-cell-px)` }}
        >
          {c.render ? c.render(row) : ((row as Record<string, unknown>)[c.key] as React.ReactNode)}
        </div>
      ))}
    </div>
  );
}
