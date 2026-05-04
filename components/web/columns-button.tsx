/**
 * ColumnsButton — popover that toggles which table columns are visible.
 *
 * Uses Radix Popover for positioning. The trigger shows "Columns N/M" when
 * not all columns are visible. Footer has "Hide all" / "Show all" actions.
 */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { WIcon } from './icons';

export interface ColumnDef {
  key: string;
  label: string;
}

interface ColumnsButtonProps {
  columns: ColumnDef[];
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
  className?: string;
}

export function ColumnsButton({ columns, visible, onChange, className }: ColumnsButtonProps) {
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  const toggleable = columns.filter((c) => c.label && c.label.trim() !== '');
  const allKeys = toggleable.map((c) => c.key);
  const visibleCount = allKeys.filter((k) => visible.has(k)).length;
  const filtered = toggleable.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));

  const toggle = (key: string) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(next);
  };

  const setAll = (showAll: boolean) => onChange(new Set(showAll ? allKeys : []));

  return (
    <PopoverPrimitive.Root onOpenChange={(o) => o && setTimeout(() => inputRef.current?.focus(), 0)}>
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            'focus-ring h-8 px-2.5 rounded-lg inline-flex items-center gap-1.5 cursor-pointer',
            'bg-card border border-[var(--border-hairline)] text-foreground',
            'text-[12.5px] font-medium hover:bg-[var(--bg-row-hover)] hover:border-[var(--border-hairline-strong)]',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
            className,
          )}
        >
          <WIcon name="columns" size={13} className="text-[var(--text-tertiary)]" />
          <span>Columns</span>
          {visibleCount < allKeys.length && (
            <span
              className="num text-[11px] font-medium text-[var(--accent)] px-1.5 h-[18px] rounded-full inline-flex items-center"
              style={{ background: 'var(--bg-sidebar-active)' }}
            >
              {visibleCount}/{allKeys.length}
            </span>
          )}
          <WIcon name="chevron-down" size={11} className="text-[var(--text-tertiary)]" />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          className="z-50 w-60 rounded-lg border border-[var(--border-hairline-strong)] bg-card shadow-[var(--shadow-popover)] overflow-hidden"
        >
          <div className="p-1.5 border-b border-[var(--border-hairline)] flex items-center gap-1.5">
            <span className="text-[12px] text-[var(--text-tertiary)] pl-1">Columns</span>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search…"
              className="flex-1 h-7 bg-transparent border-0 outline-0 text-[12.5px] text-foreground"
            />
          </div>
          <div className="scroll-thin max-h-80 overflow-auto p-1">
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-[12px] text-[var(--text-tertiary)]">No matches</div>
            ) : (
              filtered.map((col) => {
                const checked = visible.has(col.key);
                return (
                  <button
                    key={col.key}
                    type="button"
                    onClick={() => toggle(col.key)}
                    className={cn(
                      'focus-ring w-full h-[30px] px-2 rounded text-left flex items-center gap-2',
                      'text-[12.5px] text-foreground hover:bg-[var(--bg-row-hover)]',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'h-3.5 w-3.5 rounded shrink-0 inline-flex items-center justify-center',
                        checked
                          ? 'bg-[var(--accent)] border border-[var(--accent)]'
                          : 'border border-[var(--border-hairline-strong)]',
                      )}
                    >
                      {checked && <WIcon name="check" size={9} strokeWidth={2.6} color="#fff" />}
                    </span>
                    <span className="flex-1">{col.label}</span>
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-[var(--border-hairline)] p-1.5 flex items-center justify-between text-[11.5px] text-[var(--text-tertiary)]">
            <span>
              {visibleCount} of {allKeys.length} visible
            </span>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setAll(false)}
                className="focus-ring h-[22px] px-2 rounded border border-[var(--border-hairline)] text-[var(--text-secondary)] text-[11px]"
              >
                Hide all
              </button>
              <button
                type="button"
                onClick={() => setAll(true)}
                className="focus-ring h-[22px] px-2 rounded border border-[var(--border-hairline)] text-[var(--text-secondary)] text-[11px]"
              >
                Show all
              </button>
            </div>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
