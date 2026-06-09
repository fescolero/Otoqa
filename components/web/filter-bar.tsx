/**
 * FilterBar — Linear-style multi-property chip filter.
 *
 * Filters AND together; each chip is `propertyId | operator | value(s) | ✕`.
 * Property menu and value picker are nested popovers anchored to the trigger
 * or the chip being edited. Three render slots:
 *
 *   slot="trigger"  — only the "+ Filter" button (toolbar row 1, no chips)
 *   slot="chips"    — chips + trigger inline (toolbar row 2 when populated)
 *   slot="all"      — both, in one container (default / standalone use)
 */

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';
import { Calendar } from '@/components/ui/calendar';

export type FilterOperator = 'is' | 'is any of' | 'is between';

export interface FilterOption {
  value: string;
  label: string;
  count?: number;
}

export type FilterPropertyKind = 'enum' | 'date';

export interface FilterProperty {
  id: string;
  label: string;
  icon?: IconName;
  kind: FilterPropertyKind;
  options?: FilterOption[];
  /** Date-only: preset list. Defaults to a common set. */
  presets?: string[];
  /** Suggested operator label; defaults based on kind + multi-select. */
  operator?: FilterOperator;
}

export interface FilterChipValue {
  propId: string;
  op: FilterOperator;
  values: string[];
}

interface FilterBarProps {
  properties: FilterProperty[];
  value: FilterChipValue[];
  onChange: (next: FilterChipValue[]) => void;
  slot?: 'all' | 'trigger' | 'chips';
  className?: string;
}

export function FilterBar({ properties, value, onChange, slot = 'all', className }: FilterBarProps) {
  const usedPropIds = React.useMemo(() => new Set(value.map((c) => c.propId)), [value]);
  const hasChips = value.length > 0;

  const commit = (propId: string, vals: string[], replaceIdx?: number) => {
    const prop = properties.find((p) => p.id === propId);
    const op: FilterOperator = prop?.operator ?? (vals.length > 1 ? 'is any of' : 'is');
    const next = [...value];
    if (replaceIdx != null) {
      if (vals.length === 0) next.splice(replaceIdx, 1);
      else next[replaceIdx] = { propId, op, values: vals };
    } else {
      const i = next.findIndex((c) => c.propId === propId);
      if (vals.length === 0) {
        if (i >= 0) next.splice(i, 1);
      } else if (i >= 0) {
        next[i] = { propId, op, values: vals };
      } else {
        next.push({ propId, op, values: vals });
      }
    }
    onChange(next);
  };

  const removeChip = (idx: number) => {
    const next = [...value];
    next.splice(idx, 1);
    onChange(next);
  };

  const trigger = <FilterTriggerButton properties={properties} usedPropIds={usedPropIds} onCommit={(p, v) => commit(p, v)} />;

  const chips = (
    <>
      {value.map((chip, i) => {
        const prop = properties.find((p) => p.id === chip.propId);
        if (!prop) return null;
        return (
          <FilterChip
            key={chip.propId + i}
            prop={prop}
            chip={chip}
            onCommit={(vals) => commit(chip.propId, vals, i)}
            onRemove={() => removeChip(i)}
          />
        );
      })}
    </>
  );

  if (slot === 'trigger') {
    if (hasChips) return null;
    return <div className={className}>{trigger}</div>;
  }
  if (slot === 'chips') {
    if (!hasChips) return null;
    return (
      <div className={cn('flex items-center gap-1.5 flex-wrap', className)}>
        {chips}
        {trigger}
      </div>
    );
  }
  return (
    <div className={cn('flex items-center gap-1.5 flex-wrap min-h-8', className)}>
      {chips}
      {trigger}
    </div>
  );
}

function FilterTriggerButton({
  properties,
  usedPropIds,
  onCommit,
}: {
  properties: FilterProperty[];
  usedPropIds: Set<string>;
  onCommit: (propId: string, vals: string[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [drillProp, setDrillProp] = React.useState<FilterProperty | null>(null);

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDrillProp(null);
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <button
          type="button"
          className={cn(
            'focus-ring h-7 px-2.5 rounded-md inline-flex items-center gap-1 cursor-pointer',
            'bg-transparent border border-dashed border-[var(--border-hairline-strong)]',
            'text-[var(--text-secondary)] text-[12.5px]',
            'hover:bg-[var(--bg-row-hover)] hover:text-foreground hover:border-[var(--border-strong)]',
            'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
          )}
        >
          <WIcon name="plus" size={12} />
          <span>Filter</span>
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          // `data-slot="popover-content"` is what the shared
          // shadcn `Calendar` component looks for to flip its own
          // background to transparent. Without it, the Calendar's
          // default `bg-background` (white on light theme) sits
          // inside the popover's `bg-card` (light gray) and reads
          // as a "card inside a card". Matching the contract
          // shadcn already uses for its PopoverContent keeps the
          // popover one continuous surface tone.
          data-slot="popover-content"
          className="z-50 w-60 rounded-lg border border-[var(--border-hairline-strong)] bg-card shadow-[var(--shadow-popover)] overflow-hidden"
        >
          {drillProp ? (
            <ValuePicker
              property={drillProp}
              initial={[]}
              onCommit={(vals) => {
                onCommit(drillProp.id, vals);
                setOpen(false);
                setDrillProp(null);
              }}
              onCancel={() => setDrillProp(null)}
            />
          ) : (
            <PropertyMenu
              properties={properties}
              usedPropIds={usedPropIds}
              onPick={(prop) => setDrillProp(prop)}
            />
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function FilterChip({
  prop,
  chip,
  onCommit,
  onRemove,
}: {
  prop: FilterProperty;
  chip: FilterChipValue;
  onCommit: (vals: string[]) => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = React.useState(false);

  const valueLabels = chip.values.map((v) => {
    if (prop.kind === 'enum') {
      const opt = (prop.options ?? []).find((o) => o.value === v);
      return opt ? opt.label : v;
    }
    if (prop.kind === 'date') {
      // Humanize a stored YYYY-MM-DD..YYYY-MM-DD into "Apr 30 – May 6".
      // Named presets pass through unchanged.
      const range = parseDateRangeValue(v);
      return range ? formatDateRangeShort(range) : v;
    }
    return v;
  });
  const display =
    valueLabels.length <= 2
      ? valueLabels.join(', ')
      : `${valueLabels[0]}, ${valueLabels[1]} +${valueLabels.length - 2}`;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <div
        className={cn(
          'inline-flex items-stretch h-7 rounded-md overflow-hidden bg-card',
          'border border-[var(--border-hairline-strong)]',
          'text-[12.5px] text-foreground',
          'transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        )}
      >
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="focus-ring h-full px-2 inline-flex items-center gap-1.5 bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)]"
          >
            {prop.icon && <WIcon name={prop.icon} size={11} className="text-[var(--text-tertiary)]" />}
            <span>{prop.label}</span>
          </button>
        </PopoverPrimitive.Trigger>
        <span className="w-px" style={{ background: 'var(--border-hairline)' }} />
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="focus-ring h-full px-2 bg-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)]"
          >
            {chip.op}
          </button>
        </PopoverPrimitive.Trigger>
        <span className="w-px" style={{ background: 'var(--border-hairline)' }} />
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="focus-ring h-full px-2 bg-transparent text-foreground font-medium hover:bg-[var(--bg-row-hover)]"
          >
            {display}
          </button>
        </PopoverPrimitive.Trigger>
        <span className="w-px" style={{ background: 'var(--border-hairline)' }} />
        <button
          type="button"
          onClick={onRemove}
          title="Remove filter"
          className="focus-ring h-full w-[22px] inline-flex items-center justify-center bg-transparent text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
        >
          <WIcon name="close" size={11} />
        </button>
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={6}
          // `data-slot="popover-content"` is what the shared
          // shadcn `Calendar` component looks for to flip its own
          // background to transparent. Without it, the Calendar's
          // default `bg-background` (white on light theme) sits
          // inside the popover's `bg-card` (light gray) and reads
          // as a "card inside a card". Matching the contract
          // shadcn already uses for its PopoverContent keeps the
          // popover one continuous surface tone.
          data-slot="popover-content"
          className="z-50 w-60 rounded-lg border border-[var(--border-hairline-strong)] bg-card shadow-[var(--shadow-popover)] overflow-hidden"
        >
          <ValuePicker
            property={prop}
            initial={chip.values}
            onCommit={(vals) => {
              onCommit(vals);
              setOpen(false);
            }}
            onCancel={() => setOpen(false)}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function PropertyMenu({
  properties,
  usedPropIds,
  onPick,
}: {
  properties: FilterProperty[];
  usedPropIds: Set<string>;
  onPick: (prop: FilterProperty) => void;
}) {
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => inputRef.current?.focus(), []);
  const list = properties.filter((p) => p.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="p-1.5 border-b border-[var(--border-hairline)]">
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          className="w-full h-7 bg-transparent border-0 outline-0 text-[12.5px] text-foreground"
        />
      </div>
      <div className="scroll-thin max-h-72 overflow-auto p-1">
        {list.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-[var(--text-tertiary)]">No properties</div>
        ) : (
          list.map((p) => {
            const used = usedPropIds.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p)}
                className="focus-ring w-full h-[30px] px-2 rounded text-left flex items-center gap-2 text-[12.5px] text-foreground hover:bg-[var(--bg-row-hover)]"
              >
                {p.icon ? (
                  <WIcon name={p.icon} size={13} className="text-[var(--text-tertiary)]" />
                ) : (
                  <span className="w-3" />
                )}
                <span className="flex-1">{p.label}</span>
                {used && <span className="text-[11px] text-[var(--text-tertiary)]">Active</span>}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

function ValuePicker({
  property,
  initial,
  onCommit,
  onCancel,
}: {
  property: FilterProperty;
  initial: string[];
  onCommit: (vals: string[]) => void;
  onCancel: () => void;
}) {
  const [sel, setSel] = React.useState<Set<string>>(new Set(initial));
  const [q, setQ] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => inputRef.current?.focus(), []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && property.kind !== 'date') onCommit([...sel]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [property.kind, sel, onCancel, onCommit]);

  if (property.kind === 'date') {
    return (
      <DateValuePicker
        property={property}
        initial={initial}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    );
  }

  const opts = property.options ?? [];
  const filtered = opts.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));

  const toggle = (v: string) => {
    const next = new Set(sel);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    setSel(next);
  };

  return (
    <>
      <div className="p-1.5 border-b border-[var(--border-hairline)] flex items-center gap-1.5">
        <span className="text-[12px] text-[var(--text-tertiary)] pl-1">{property.label}</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search…"
          className="flex-1 h-7 bg-transparent border-0 outline-0 text-[12.5px] text-foreground"
        />
      </div>
      <div className="scroll-thin max-h-72 overflow-auto p-1">
        {filtered.length === 0 ? (
          <div className="p-4 text-center text-[12px] text-[var(--text-tertiary)]">No matches</div>
        ) : (
          filtered.map((o) => {
            const checked = sel.has(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => toggle(o.value)}
                className="focus-ring w-full h-[30px] px-2 rounded text-left flex items-center gap-2 text-[12.5px] text-foreground hover:bg-[var(--bg-row-hover)]"
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
                <span className="flex-1">{o.label}</span>
                {o.count != null && <span className="num text-[11px] text-[var(--text-tertiary)]">{o.count}</span>}
              </button>
            );
          })
        )}
      </div>
      <div className="border-t border-[var(--border-hairline)] p-1.5 flex items-center justify-between text-[11.5px] text-[var(--text-tertiary)]">
        <span>{sel.size} selected</span>
        <button
          type="button"
          onClick={() => onCommit([...sel])}
          className="focus-ring h-6 px-2.5 rounded bg-[var(--accent)] text-white text-[12px] font-medium"
        >
          Apply
        </button>
      </div>
    </>
  );
}

// ─── Date value picker ──────────────────────────────────────────────────
// Two surfaces share the same popover: a 6-up preset grid (default) and a
// react-day-picker calendar in range mode (when "Custom range" is picked).
// Custom ranges round-trip as `YYYY-MM-DD..YYYY-MM-DD` strings stored on
// the chip; named presets stay as-is.

function DateValuePicker({
  property,
  initial,
  onCommit,
  onCancel,
}: {
  property: FilterProperty;
  initial: string[];
  onCommit: (vals: string[]) => void;
  onCancel: () => void;
}) {
  const presets = property.presets ?? ['Today', 'Yesterday', 'Last 7 days', 'Last 30 days', 'This month', 'Last month'];
  const initialRange = initial[0] ? parseDateRangeValue(initial[0]) : null;
  const [mode, setMode] = React.useState<'presets' | 'custom'>(initialRange ? 'custom' : 'presets');
  const [range, setRange] = React.useState<{ from?: Date; to?: Date } | undefined>(
    initialRange ? { from: initialRange.from, to: initialRange.to } : undefined,
  );

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (mode === 'custom') {
    const canApply = !!(range?.from && range?.to);
    return (
      <div className="text-[12.5px] text-[var(--text-secondary)]">
        <div className="px-3 pt-3 pb-1 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setMode('presets')}
            className="focus-ring inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)] hover:text-foreground"
          >
            <WIcon name="chevron-left" size={11} />
            <span>Presets</span>
          </button>
          <span className="font-medium text-foreground">{property.label}</span>
          <span style={{ width: 60 }} />
        </div>
        {/*
          The filter popover is `w-60` (240px). The Calendar's default
          cell-size is 32px → 7 cells = 224px + the `p-3` (12px each
          side) padding around the day grid = 248px total. That made
          the calendar overflow the popover on the right, leaving the
          right-edge day numbers visually flush with the border while
          the left side had ~17px of breathing room. Shrinking the
          cell-size to 28px brings the inner calendar down to 196px +
          24px padding = 220px, which centers cleanly inside the
          240px popover with 10px of margin on each side.
        */}
        <div className="flex justify-center">
          <Calendar
            mode="range"
            className="[--cell-size:1.75rem] p-3"
            selected={range as never}
            onSelect={(next) => setRange(next as { from?: Date; to?: Date } | undefined)}
            numberOfMonths={1}
          />
        </div>
        <div className="border-t border-[var(--border-hairline)] p-1.5 flex items-center justify-between text-[11.5px] text-[var(--text-tertiary)]">
          <span>
            {range?.from && range?.to
              ? formatDateRangeShort({ from: range.from, to: range.to })
              : 'Pick start and end'}
          </span>
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setRange(undefined)}
              disabled={!range?.from}
              className="focus-ring h-6 px-2 rounded text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] disabled:opacity-50"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={!canApply}
              onClick={() => {
                if (!canApply) return;
                onCommit([formatDateRangeValue({ from: range!.from!, to: range!.to! })]);
              }}
              className="focus-ring h-6 px-2.5 rounded bg-[var(--accent)] text-white text-[12px] font-medium disabled:opacity-50"
            >
              Apply
            </button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3 text-[12.5px] text-[var(--text-secondary)]">
      <div className="mb-2 font-medium text-foreground">{property.label}</div>
      <div className="grid grid-cols-2 gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onCommit([p])}
            className="focus-ring h-7 px-2.5 rounded text-left text-[12] text-foreground bg-card border border-[var(--border-hairline)] hover:bg-[var(--bg-row-hover)]"
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setMode('custom')}
          className="focus-ring h-7 px-2.5 rounded inline-flex items-center gap-1.5 text-left text-[12] text-foreground bg-card border border-[var(--border-hairline)] hover:bg-[var(--bg-row-hover)]"
        >
          <WIcon name="calendar" size={11} className="text-[var(--text-tertiary)]" />
          <span>Custom</span>
        </button>
      </div>
    </div>
  );
}

// ─── Date range round-trip helpers ──────────────────────────────────────
// `YYYY-MM-DD..YYYY-MM-DD` chip values let the FilterChip display "Apr 30
// – May 6" while consumers parse the same string back into Date pairs.

const DATE_RANGE_RE = /^(\d{4})-(\d{2})-(\d{2})\.\.(\d{4})-(\d{2})-(\d{2})$/;

export function parseDateRangeValue(value: string): { from: Date; to: Date } | null {
  const m = DATE_RANGE_RE.exec(value);
  if (!m) return null;
  const from = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const to = new Date(Number(m[4]), Number(m[5]) - 1, Number(m[6]));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return { from, to };
}

export function formatDateRangeValue(range: { from: Date; to: Date }): string {
  const ymd = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  return `${ymd(range.from)}..${ymd(range.to)}`;
}

function formatDateRangeShort(range: { from: Date; to: Date }): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const fromStr = range.from.toLocaleDateString('en-US', opts);
  const toStr = range.to.toLocaleDateString('en-US', opts);
  return `${fromStr} – ${toStr}`;
}
