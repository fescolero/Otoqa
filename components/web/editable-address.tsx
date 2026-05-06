/**
 * EditableAddress — inline-edit primitive that swaps to a Google Places
 * autocomplete dropdown on click. Sibling to <EditableField>; exposed as
 * its own primitive because it needs a structured value (street / city /
 * state / postalCode / country / lat / lng / timezone) and emits the full
 * parsed AddressData on commit, not just a string.
 *
 * Usage:
 *   <EditableAddress
 *     value={{
 *       address: driver.address, city: driver.city, state: driver.state,
 *       postalCode: driver.zipCode, country: driver.country,
 *     }}
 *     onCommit={(data) => updateAll5Fields(data)}
 *   />
 *
 * The component renders a multi-line idle display (street / city, state
 * postalCode / country if non-US). Click → focused AddressAutocomplete
 * with debounced predictions; pick a result → commit and exit edit mode.
 * Esc / click-outside cancels.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { AddressAutocomplete, type AddressData } from '@/components/ui/address-autocomplete';
import { WIcon } from './icons';

export type { AddressData };

export interface EditableAddressValue {
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

interface EditableAddressProps {
  value?: EditableAddressValue | null;
  onCommit?: (data: AddressData) => void | Promise<void>;
  /** Render override for idle state. Defaults to a multi-line address. */
  display?: React.ReactNode;
  placeholder?: string;
  readOnly?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function EditableAddress({
  value,
  onCommit,
  display,
  placeholder = 'Add address',
  readOnly,
  className,
  ariaLabel,
}: EditableAddressProps) {
  const [editing, setEditing] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditing(false);
    };
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDoc);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDoc);
    };
  }, [editing]);

  React.useEffect(() => {
    if (savedAt == null) return;
    const t = setTimeout(() => setSavedAt(null), 2800);
    return () => clearTimeout(t);
  }, [savedAt]);

  const lines = buildDisplayLines(value);
  const hasValue = lines.length > 0;
  const initialQuery = [value?.address, value?.city, value?.state, value?.postalCode]
    .filter(Boolean)
    .join(', ');

  if (!editing) {
    return (
      <span className={cn('group inline-flex items-start gap-1.5 min-w-0', className)}>
        <button
          type="button"
          onClick={() => !readOnly && setEditing(true)}
          aria-label={ariaLabel ?? 'Edit address'}
          disabled={readOnly}
          className={cn(
            'text-left text-[13px] text-foreground rounded -mx-1 px-1 py-0.5 min-w-0',
            'hover:bg-[var(--bg-row-hover)]',
            readOnly ? 'cursor-default' : 'cursor-text',
          )}
        >
          {display ??
            (hasValue ? (
              <span className="flex flex-col gap-0.5 leading-tight">
                {lines.map((line, i) => (
                  <span key={i}>{line}</span>
                ))}
              </span>
            ) : (
              <span className="text-[var(--text-tertiary)]">{placeholder}</span>
            ))}
        </button>
        {!readOnly && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit address (pencil)"
            title="Edit address"
            className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center h-5 w-5 rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
          >
            <WIcon name="edit" size={11} />
          </button>
        )}
        {savedAt != null && (
          <span className="text-[11px] text-[var(--text-tertiary)] inline-flex items-center gap-1">
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: '#10B981' }} />
            Saved
          </span>
        )}
      </span>
    );
  }

  return (
    <div ref={wrapRef} className={cn('w-full', className)} onKeyDown={(e) => {
      if (e.key === 'Escape') setEditing(false);
    }}>
      <AddressAutocomplete
        value={initialQuery}
        onSelect={async (data) => {
          await onCommit?.(data);
          setSavedAt(Date.now());
          setEditing(false);
        }}
        placeholder={placeholder}
      />
      <div className="mt-1 text-[10.5px] text-[var(--text-tertiary)]">
        Pick a result · esc to cancel
      </div>
    </div>
  );
}

function buildDisplayLines(value: EditableAddressValue | null | undefined): string[] {
  if (!value) return [];
  const lines: string[] = [];
  if (value.address) lines.push(value.address);
  const cityStateZip = [value.city, [value.state, value.postalCode].filter(Boolean).join(' ').trim()]
    .filter(Boolean)
    .join(', ');
  if (cityStateZip) lines.push(cityStateZip);
  if (value.country && value.country !== 'US' && value.country.toLowerCase() !== 'united states') {
    lines.push(value.country);
  }
  return lines;
}
