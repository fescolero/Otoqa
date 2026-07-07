/**
 * StatusChipPopover — click-to-change Chip used in hero titles.
 *
 * Renders the current status as a clickable `<Chip>`. On click, opens a
 * compact popover with the supplied options; selecting an option fires
 * `onChange(value)`. Designed for record headers where a full
 * `<StatusPicker>` modal would be overkill (e.g. trucks/trailers whose
 * status field is a free-form string rather than a state machine).
 */

'use client';

import * as React from 'react';
import { Chip, type ChipStatus } from './chip';
import { WIcon } from './icons';

export interface StatusChipOption {
  /** Stored value (matches what `onChange` receives). */
  value: string;
  /** Display label shown both in the chip and the popover row. */
  label: string;
  /** Chip tone for this option. */
  chip: ChipStatus;
  /** Optional one-line description shown next to the label in the menu. */
  description?: string;
}

interface StatusChipPopoverProps {
  /** Current stored value — matched against `options[*].value`. */
  current: string;
  options: StatusChipOption[];
  onChange: (next: string) => void | Promise<void>;
  /** Override the chip label (defaults to the matched option's label). */
  label?: React.ReactNode;
  disabled?: boolean;
}

export function StatusChipPopover({
  current,
  options,
  onChange,
  label,
  disabled,
}: StatusChipPopoverProps) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = options.find((o) => o.value === current);
  const chipStatus: ChipStatus = active?.chip ?? 'inactive';
  const chipLabel = label ?? active?.label ?? current;

  const onPick = async (value: string) => {
    setOpen(false);
    if (value === current) return;
    await onChange(value);
  };

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className="focus-ring inline-flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer rounded-full"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Chip status={chipStatus} label={chipLabel} />
        {!disabled && (
          <WIcon name="chevron-down" size={11} color="var(--text-tertiary)" />
        )}
      </button>
      {open && (
        <div
          role="menu"
          className="scroll-thin overflow-auto absolute z-30"
          style={{
            top: 'calc(100% + 4px)',
            left: 0,
            minWidth: 220,
            maxHeight: 320,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline-strong)',
            borderRadius: 8,
            boxShadow: 'var(--shadow-popover)',
            padding: 4,
          }}
        >
          {options.map((o) => {
            const isActive = o.value === current;
            return (
              <button
                key={o.value}
                type="button"
                role="menuitem"
                onClick={() => onPick(o.value)}
                onMouseEnter={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'var(--bg-row-hover)';
                }}
                onMouseLeave={(e) => {
                  if (!isActive) e.currentTarget.style.background = 'transparent';
                }}
                className="focus-ring w-full text-left flex items-center gap-2 cursor-pointer font-sans"
                style={{
                  padding: '6px 8px',
                  borderRadius: 6,
                  background: isActive ? 'var(--bg-sidebar-active)' : 'transparent',
                  border: 0,
                }}
              >
                <Chip status={o.chip} label={o.label} />
                {o.description && (
                  <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                    {o.description}
                  </span>
                )}
                {isActive && (
                  <span className="ml-auto inline-flex items-center" style={{ color: 'var(--accent)' }}>
                    <WIcon name="check" size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
