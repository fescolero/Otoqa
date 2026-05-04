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
import { EditableField, type EditableSelectOption } from './editable-field';
import { WIcon, type IconName } from './icons';

export type DSMiniCellEditorType =
  | 'text'
  | 'email'
  | 'phone'
  | 'textarea'
  | 'date'
  | 'select'
  | 'multiselect';

export interface DSMiniCellEditor {
  type?: DSMiniCellEditorType;
  options?: EditableSelectOption[];
  placeholder?: string;
  /** Date display format passed to date-fns. */
  format?: string;
  rows?: number;
}

export interface DSMiniColumn<R extends { id: string | number }> {
  key: string;
  label: React.ReactNode;
  render?: (row: R) => React.ReactNode;
  width?: string;
  align?: 'left' | 'right';
  tnum?: boolean;
  /** When set AND the table is in `editable` mode, the cell value is wrapped
   *  in an `<EditableField>`. Resolve the raw value via `getValue` (defaults
   *  to `row[key]`). */
  editor?: DSMiniCellEditor;
  /** Skips the editor — renders display value only, even when the table is
   *  in `editable` mode. Use for derived columns (status, etc.). */
  readOnly?: boolean;
  /** Override how the raw value is read for the editor — useful when the
   *  cell renders a Chip but the editor needs the underlying string. */
  getValue?: (row: R) => string | string[];
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
  /** Turns on per-cell inline editing for any column carrying an `editor`
   *  config. When false (default) every cell renders read-only. */
  editable?: boolean;
  /** Called when a per-cell editor commits a new value. */
  onCellCommit?: (row: R, key: string, next: string | string[]) => void;
}

export function DSMiniTable<R extends { id: string | number }>({
  columns,
  rows,
  total,
  onViewAll,
  rowActions,
  uploadRow,
  className,
  editable,
  onCellCommit,
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
          <DSRow
            key={row.id}
            columns={columns}
            row={row}
            grid={grid}
            rowActions={rowActions?.(row)}
            editable={editable}
            onCellCommit={onCellCommit}
          />
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
  editable,
  onCellCommit,
}: {
  columns: DSMiniColumn<R>[];
  row: R;
  grid: string;
  rowActions?: DSRowAction[];
  editable?: boolean;
  onCellCommit?: (row: R, key: string, next: string | string[]) => void;
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
        <DSCell
          key={c.key}
          column={c}
          row={row}
          editable={editable}
          onCellCommit={onCellCommit}
        />
      ))}
      {rowActions && rowActions.length > 0 && (
        <div className={cn('flex items-center justify-center transition-opacity', hover ? 'opacity-100' : 'opacity-0')}>
          <DSRowActions actions={rowActions} />
        </div>
      )}
    </div>
  );
}

function DSCell<R extends { id: string | number }>({
  column,
  row,
  editable,
  onCellCommit,
}: {
  column: DSMiniColumn<R>;
  row: R;
  editable?: boolean;
  onCellCommit?: (row: R, key: string, next: string | string[]) => void;
}) {
  const display = column.render ? column.render(row) : ((row as Record<string, unknown>)[column.key] as React.ReactNode);
  const editorOk = editable && column.editor && !column.readOnly;
  const cellClass = cn(
    'px-1 text-[12.5px] text-foreground min-w-0',
    column.tnum && 'num',
    column.align === 'right' && 'text-right',
    !editorOk && 'truncate',
  );
  if (!editorOk) {
    return <div className={cellClass}>{display}</div>;
  }
  const editor = column.editor!;
  const type = editor.type ?? 'text';
  const raw = column.getValue ? column.getValue(row) : ((row as Record<string, unknown>)[column.key] as string | string[] | undefined);
  const commit = (next: string | string[]) => onCellCommit?.(row, column.key, next);

  if (type === 'multiselect') {
    const value: string[] = Array.isArray(raw) ? raw : raw ? String(raw).split(' · ').map((s) => s.trim()).filter(Boolean) : [];
    return (
      <div className={cellClass}>
        <EditableField
          type="multiselect"
          value={value}
          options={editor.options ?? []}
          display={display}
          placeholder={editor.placeholder}
          onCommit={(next) => commit(next)}
        />
      </div>
    );
  }

  const value = Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw);

  if (type === 'date') {
    return (
      <div className={cellClass}>
        <EditableField
          type="date"
          value={value}
          format={editor.format}
          display={display}
          placeholder={editor.placeholder}
          onCommit={(next) => commit(next)}
        />
      </div>
    );
  }
  if (type === 'select') {
    return (
      <div className={cellClass}>
        <EditableField
          type="select"
          value={value}
          options={editor.options ?? []}
          display={display}
          placeholder={editor.placeholder}
          onCommit={(next) => commit(next)}
        />
      </div>
    );
  }
  if (type === 'textarea') {
    return (
      <div className={cellClass}>
        <EditableField
          type="textarea"
          value={value}
          rows={editor.rows}
          display={display}
          placeholder={editor.placeholder}
          onCommit={(next) => commit(next)}
        />
      </div>
    );
  }
  return (
    <div className={cellClass}>
      <EditableField
        type={type as 'text' | 'email' | 'phone'}
        value={value}
        display={display}
        placeholder={editor.placeholder}
        onCommit={(next: string) => commit(next)}
      />
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
