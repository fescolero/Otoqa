/**
 * EditableAddress — inline-edit primitive that swaps to a Google Places
 * autocomplete dropdown on click. Sibling to <EditableField>; exposed as
 * its own primitive because address values are structured (street / city /
 * state / postalCode / country / lat / lng / timezone) and the commit
 * callback emits the full parsed AddressData rather than a string.
 *
 * Visual: idle and edit states match the rest of the EditableField family
 * — a borderless input with an accent ring, 13px text, no row-height
 * jump. The Google Places dropdown lives directly below the input.
 *
 * Usage:
 *   <EditableAddress
 *     value={{
 *       address: driver.address, city: driver.city, state: driver.state,
 *       postalCode: driver.zipCode, country: driver.country,
 *     }}
 *     onCommit={(data) => updateAll5Fields(data)}
 *   />
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { type AddressData } from '@/components/ui/address-autocomplete';
import { getAddressPredictions, getPlaceDetails } from '@/lib/googlePlaces';
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
  /** Render override for idle state. Defaults to the street, or a multi-
   *  line block if no parent is splitting city/state/zip into their own
   *  rows. */
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

  if (!editing) {
    const lines = buildDisplayLines(value);
    const hasValue = display !== undefined ? Boolean(display) : lines.length > 0;
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
      </span>
    );
  }

  return (
    <EditableAddressEditor
      initialValue={value}
      placeholder={placeholder}
      onCommit={onCommit}
      onClose={() => setEditing(false)}
      ariaLabel={ariaLabel}
      className={className}
    />
  );
}

// ─── Edit mode ──────────────────────────────────────────────────────────
// Slim input matching EditableField's text variant. Predictions render in
// an absolutely-positioned dropdown directly below.

function EditableAddressEditor({
  initialValue,
  placeholder,
  onCommit,
  onClose,
  ariaLabel,
  className,
}: {
  initialValue?: EditableAddressValue | null;
  placeholder?: string;
  onCommit?: (data: AddressData) => void | Promise<void>;
  onClose: () => void;
  ariaLabel?: string;
  className?: string;
}) {
  const initial = React.useMemo(
    () =>
      [initialValue?.address, initialValue?.city, initialValue?.state, initialValue?.postalCode]
        .filter(Boolean)
        .join(', '),
    [initialValue],
  );
  const [draft, setDraft] = React.useState(initial);
  const [predictions, setPredictions] = React.useState<google.maps.places.AutocompletePrediction[]>([]);
  const [active, setActive] = React.useState(-1);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  React.useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  React.useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  const fetchPredictions = (q: string) => {
    if (!q || q.length < 3) {
      setPredictions([]);
      setActive(-1);
      return;
    }
    void getAddressPredictions(q)
      .then((results) => {
        setPredictions(results);
        setActive(results.length > 0 ? 0 : -1);
      })
      .catch(() => {
        setPredictions([]);
        setActive(-1);
      });
  };

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value;
    setDraft(q);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchPredictions(q), 250);
  };

  const pick = async (placeId: string) => {
    setBusy(true);
    try {
      const details = await getPlaceDetails(placeId);
      if (details && onCommit) {
        await onCommit({
          address: details.address,
          city: details.city,
          state: details.state,
          postalCode: details.postalCode,
          country: details.country,
          latitude: details.latitude,
          longitude: details.longitude,
          formattedAddress: details.formattedAddress,
          timeZone: details.timeZone,
        });
      }
    } finally {
      setBusy(false);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (predictions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(predictions.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && predictions[active]) {
        void pick(predictions[active].place_id);
      }
    }
  };

  return (
    <div ref={wrapRef} className={cn('relative w-full min-w-0', className)}>
      <input
        ref={inputRef}
        type="text"
        value={draft}
        onChange={onChange}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? 'Address'}
        autoComplete="off"
        disabled={busy}
        className={cn(
          'w-full bg-transparent border-0 outline-none text-[13px] text-foreground',
          'rounded -mx-1 px-1 py-0.5 ring-2 ring-[var(--accent)]',
        )}
      />
      {predictions.length > 0 && (
        <div
          className="absolute left-0 right-0 mt-1 bg-popover border border-[var(--border-hairline-strong)] rounded-md shadow-[var(--shadow-popover)] max-h-[260px] overflow-auto z-50"
        >
          {predictions.map((p, i) => (
            <button
              key={p.place_id}
              type="button"
              onClick={() => void pick(p.place_id)}
              onMouseEnter={() => setActive(i)}
              className={cn(
                'focus-ring w-full px-2.5 py-1.5 text-left text-[12.5px] text-foreground flex items-center gap-1.5',
                active === i && 'bg-[var(--bg-row-hover)]',
              )}
            >
              <span className="truncate">{p.description}</span>
            </button>
          ))}
        </div>
      )}
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
