/**
 * DSMiniTable — 5-row preview table that lives inside details cards.
 *
 * Columns can carry an `editor` config (forwarded to EditableField on cells)
 * and the table can supply a `rowActions` kebab menu per row + an
 * `uploadRow` slot at the top when `editable` is on. When `total > rows.length`
 * the footer shows a "View all N" link that escalates to the full table.
 */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';

export interface DSMiniColumn<R extends { id: string | number }> {
  key: string;
  label: React.ReactNode;
  render?: (row: R) => React.ReactNode;
  width?: string;
  align?: 'left' | 'right';
  tnum?: boolean;
}

export interface DSRowAction {
  label: React.ReactNode;
  icon?: IconName;
  kbd?: string;
  danger?: boolean;
  onClick: () => void;
}

interface DSMiniTableProps<R extends { id: string | number }> {
  columns: DSMiniColumn<R>[];
  rows: R[];
  total?: number;
  onViewAll?: () => void;
  rowActions?: (row: R) => DSRowAction[];
  uploadRow?: React.ReactNode;
  className?: string;
}

export function DSMiniTable<R extends { id: string | number }>({
  columns,
  rows,
  total,
  onViewAll,
  rowActions,
  uploadRow,
  className,
}: DSMiniTableProps<R>) {
  const showViewAll = onViewAll && total != null && total > rows.length;
  const grid = columns.map((c) => c.width ?? '1fr').join(' ') + (rowActions ? ' 32px' : '');

  return (
    <div className={cn('rounded-lg border border-[var(--border-hairline)] bg-card overflow-hidden', className)}>
      {/* header */}
      <div
        className="grid items-center text-[var(--text-tertiary)] tw-label py-2 px-3 bg-[var(--bg-surface-2)] border-b border-[var(--border-hairline)]"
        style={{ gridTemplateColumns: grid }}
      >
        {columns.map((c) => (
          <div key={c.key} className={cn('px-1', c.align === 'right' && 'text-right')}>
            {c.label}
          </div>
        ))}
        {rowActions && <div />}
      </div>

      {/* upload row */}
      {uploadRow}

      {/* rows */}
      <div>
        {rows.map((row) => (
          <DSRow key={row.id} columns={columns} row={row} grid={grid} rowActions={rowActions?.(row)} />
        ))}
      </div>

      {/* view all */}
      {showViewAll && (
        <button
          type="button"
          onClick={onViewAll}
          className={cn(
            'focus-ring w-full text-left px-3 py-2 text-[12px] font-medium',
            'text-[var(--accent)] hover:bg-[var(--bg-row-hover)]',
            'border-t border-[var(--border-hairline)]',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          )}
        >
          View all {total} →
        </button>
      )}
    </div>
  );
}

function DSRow<R extends { id: string | number }>({
  columns,
  row,
  grid,
  rowActions,
}: {
  columns: DSMiniColumn<R>[];
  row: R;
  grid: string;
  rowActions?: DSRowAction[];
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(
        'grid items-center px-3 transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'border-b last:border-b-0 border-[var(--border-hairline)]',
        'hover:bg-[var(--bg-row-hover)]',
      )}
      style={{ gridTemplateColumns: grid, minHeight: 36 }}
    >
      {columns.map((c) => (
        <div
          key={c.key}
          className={cn(
            'px-1 text-[12.5px] text-foreground truncate',
            c.tnum && 'num',
            c.align === 'right' && 'text-right',
          )}
        >
          {c.render ? c.render(row) : (row as Record<string, unknown>)[c.key] as React.ReactNode}
        </div>
      ))}
      {rowActions && rowActions.length > 0 && (
        <div className={cn('flex items-center justify-center transition-opacity', hover ? 'opacity-100' : 'opacity-0')}>
          <DSRowActions actions={rowActions} />
        </div>
      )}
    </div>
  );
}

function DSRowActions({ actions }: { actions: DSRowAction[] }) {
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className="focus-ring h-7 w-7 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name="kebab-h" size={14} />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[180px] rounded-lg border border-[var(--border-hairline-strong)] bg-card p-1 shadow-[var(--shadow-popover)]"
        >
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={a.onClick}
              className={cn(
                'focus-ring w-full px-2.5 py-1.5 rounded-md text-left text-[12.5px] flex items-center gap-2',
                'hover:bg-[var(--bg-row-hover)]',
                a.danger ? 'text-[#B43030]' : 'text-foreground',
              )}
            >
              {a.icon && <WIcon name={a.icon} size={13} />}
              <span className="flex-1">{a.label}</span>
              {a.kbd && (
                <span className="text-[10.5px] font-medium text-[var(--text-tertiary)] font-mono">{a.kbd}</span>
              )}
            </button>
          ))}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

interface DSUploadRowProps {
  label: React.ReactNode;
  onClick?: () => void;
  className?: string;
}

export function DSUploadRow({ label, onClick, className }: DSUploadRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-ring w-full px-3 py-2 text-left text-[12.5px] font-medium',
        'text-[var(--accent)] bg-[var(--accent-tint)] hover:bg-[var(--accent-tint-strong)]',
        'border-b border-[var(--border-hairline)]',
        'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'inline-flex items-center gap-2',
        className,
      )}
    >
      <WIcon name="plus" size={13} />
      {label}
    </button>
  );
}
