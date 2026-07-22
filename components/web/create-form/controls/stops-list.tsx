/**
 * Stops-list composite — repeating list of load stops.
 *
 * Each stop is a self-contained mini-form: pickup/delivery type,
 * address (Google Places autocomplete), time window with loading-type
 * (APPT/FCFS/Live), commodity description / units / pieces / weight,
 * and optional per-stop instructions. Stops can be added, removed,
 * or reordered up/down. Sequence numbers are auto-managed.
 *
 * Storage shape mirrors what `api.loads.createLoad` expects on the
 * wire — the page wrapper's `mapValsToLoadArgs` only needs to coerce
 * numbers (`pieces`, `weight`) and copy the array through. Lat/lng +
 * timeZone come from the address autocomplete; manual edits clear
 * them so we don't ship stale coordinates with a hand-typed address.
 *
 * Ported from `components/create-load-form.tsx` (the 1,057-line
 * legacy form, retired in the Phase 4 cleanup) — kept the field
 * names + ergonomics identical so an operator switching pages won't
 * have to relearn anything. Use `git log -- components/create-load-form.tsx`
 * to find the historical implementation if questions arise.
 */

'use client';

import * as React from 'react';
import {
  AddressAutocomplete,
  type AddressData,
} from '@/components/ui/address-autocomplete';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { DatePicker } from '@/components/ui/date-picker';
import { WBtn } from '@/components/web/btn';
import { WIcon } from '@/components/web/icons';
import { SegmentedControl } from './segmented';
import type { FieldOption } from '../schema-types';

/* ────────────────────────────────────────────────────────────────────
 *  Wire shape — matches `api.loads.createLoad`'s `stops` array
 *  validator exactly. Anything not on this shape silently drops on
 *  save; anything missing here would need a schema migration too.
 * ──────────────────────────────────────────────────────────────── */

export interface StopsListItem {
  sequenceNumber: number;
  stopType: 'PICKUP' | 'DELIVERY';
  loadingType: 'APPT' | 'FCFS' | 'Live';
  address: string;
  city?: string;
  state?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  timeZone?: string;
  windowBeginDate: string;
  windowBeginTime: string;
  windowEndDate: string;
  windowEndTime: string;
  commodityDescription: string;
  commodityUnits: 'Pallets' | 'Boxes' | 'Pieces' | 'Lbs' | 'Kg';
  pieces: number;
  weight?: number;
  instructions?: string;
}

const STOP_TYPE_OPTIONS: FieldOption[] = [
  { value: 'PICKUP', label: 'Pickup' },
  { value: 'DELIVERY', label: 'Delivery' },
];

const LOADING_TYPE_OPTIONS: FieldOption[] = [
  { value: 'APPT', label: 'Appointment' },
  { value: 'FCFS', label: 'First-come' },
  { value: 'Live', label: 'Live load' },
];

const UNITS_OPTIONS: FieldOption[] = [
  { value: 'Pallets', label: 'Pallets' },
  { value: 'Boxes', label: 'Boxes' },
  { value: 'Pieces', label: 'Pieces' },
  { value: 'Lbs', label: 'Lbs' },
  { value: 'Kg', label: 'Kg' },
];

/** Default for a new stop. The kind defaults to DELIVERY because most
 *  loads have one pickup at index 0 (added on schema seed) followed
 *  by a delivery — flipping a delivery to a pickup is one click. */
function emptyStop(sequenceNumber: number, kind: StopsListItem['stopType'] = 'DELIVERY'): StopsListItem {
  return {
    sequenceNumber,
    stopType: kind,
    loadingType: 'APPT',
    address: '',
    city: '',
    state: '',
    postalCode: '',
    windowBeginDate: '',
    windowBeginTime: '',
    windowEndDate: '',
    windowEndTime: '',
    commodityDescription: '',
    commodityUnits: 'Pallets',
    pieces: 1,
    weight: undefined,
    instructions: '',
  };
}

export interface StopsListControlProps {
  id: string;
  value: StopsListItem[];
  onChange: (next: StopsListItem[]) => void;
  disabled?: boolean;
}

export function StopsListControl({
  value,
  onChange,
  disabled,
}: StopsListControlProps) {
  // Defensive: if the schema's default is omitted or the array is
  // empty, render at least one pickup row so the form is usable.
  const stops = value && value.length > 0 ? value : [emptyStop(1, 'PICKUP')];

  const updateStop = (index: number, patch: Partial<StopsListItem>) => {
    const next = stops.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(next);
  };

  const addStop = () => {
    const next = [...stops, emptyStop(stops.length + 1)];
    onChange(next);
  };

  const removeStop = (index: number) => {
    if (stops.length <= 1) return; // Always keep at least one stop.
    const next = stops
      .filter((_, i) => i !== index)
      .map((s, i) => ({ ...s, sequenceNumber: i + 1 }));
    onChange(next);
  };

  const moveStop = (index: number, dir: -1 | 1) => {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= stops.length) return;
    const next = stops.slice();
    [next[index], next[newIndex]] = [next[newIndex], next[index]];
    // Re-sequence after the swap so sequenceNumber tracks display
    // order. Server uses sequenceNumber for canonical order.
    next.forEach((s, i) => (s.sequenceNumber = i + 1));
    onChange(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stops.map((stop, i) => (
        <StopCard
          key={i}
          stop={stop}
          index={i}
          isFirst={i === 0}
          isLast={i === stops.length - 1}
          canRemove={stops.length > 1}
          disabled={disabled}
          onChange={(patch) => updateStop(i, patch)}
          onRemove={() => removeStop(i)}
          onMove={(dir) => moveStop(i, dir)}
        />
      ))}
      <div>
        <WBtn
          variant="secondary"
          size="sm"
          leading="plus"
          onClick={addStop}
          disabled={disabled}
        >
          Add stop
        </WBtn>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 *  Single stop card
 * ──────────────────────────────────────────────────────────────── */

interface StopCardProps {
  stop: StopsListItem;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
  disabled?: boolean;
  onChange: (patch: Partial<StopsListItem>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function StopCard({
  stop,
  index,
  isFirst,
  isLast,
  canRemove,
  disabled,
  onChange,
  onRemove,
  onMove,
}: StopCardProps) {
  const handleAddressSelect = (data: AddressData) => {
    onChange({
      address: data.address,
      city: data.city,
      state: data.state,
      postalCode: data.postalCode,
      latitude: data.latitude,
      longitude: data.longitude,
      timeZone: data.timeZone,
    });
  };

  return (
    <section
      style={{
        border: '1px solid var(--border-hairline)',
        borderRadius: 8,
        background: 'var(--bg-surface)',
        overflow: 'hidden',
      }}
    >
      {/* Stop header row: badge + kind segmented + reorder/remove */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 12px',
          background: 'var(--bg-surface-2)',
          borderBottom: '1px solid var(--border-hairline)',
        }}
      >
        <span
          aria-label={`Stop ${stop.sequenceNumber}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: 'var(--bg-row-hover)',
            color: 'var(--text-secondary)',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {stop.sequenceNumber}
        </span>
        <SegmentedControl
          id={`stop-${index}-type`}
          value={stop.stopType}
          onChange={(v) =>
            onChange({ stopType: v as StopsListItem['stopType'] })
          }
          options={STOP_TYPE_OPTIONS}
          disabled={disabled}
        />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn
            label="Move up"
            iconName="chevron-down"
            // chevron-up is just a rotated chevron-down via CSS to
            // avoid adding a new icon to the registry for one use.
            iconRotate={180}
            onClick={() => onMove(-1)}
            disabled={disabled || isFirst}
          />
          <IconBtn
            label="Move down"
            iconName="chevron-down"
            onClick={() => onMove(1)}
            disabled={disabled || isLast}
          />
          <IconBtn
            label="Remove stop"
            iconName="trash"
            onClick={onRemove}
            disabled={disabled || !canRemove}
          />
        </div>
      </header>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* Address row */}
        <FieldLabel>Address</FieldLabel>
        <AddressAutocomplete
          value={stop.address}
          onChange={(v) =>
            // Clear cached coordinates when the user edits manually;
            // lat/lng/timezone become stale once the address text
            // diverges from the picked place.
            onChange({
              address: v,
              latitude: undefined,
              longitude: undefined,
              timeZone: undefined,
            })
          }
          onSelect={handleAddressSelect}
          placeholder="Start typing an address…"
          disabled={disabled}
        />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr',
            gap: 8,
          }}
        >
          <Input
            value={stop.city ?? ''}
            onChange={(e) => onChange({ city: e.target.value })}
            placeholder="City"
            disabled={disabled}
          />
          <Input
            value={stop.state ?? ''}
            onChange={(e) => onChange({ state: e.target.value })}
            placeholder="State"
            disabled={disabled}
          />
          <Input
            value={stop.postalCode ?? ''}
            onChange={(e) => onChange({ postalCode: e.target.value })}
            placeholder="ZIP"
            disabled={disabled}
          />
        </div>

        {/* Window row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(180px, 1fr) repeat(4, minmax(120px, 1fr))',
            gap: 8,
            alignItems: 'flex-end',
            marginTop: 6,
          }}
        >
          <div>
            <FieldLabel>Loading type</FieldLabel>
            <SegmentedControl
              id={`stop-${index}-loading-type`}
              value={stop.loadingType}
              onChange={(v) =>
                onChange({ loadingType: v as StopsListItem['loadingType'] })
              }
              options={LOADING_TYPE_OPTIONS}
              disabled={disabled}
            />
          </div>
          <DateInput
            label="Begin date"
            value={stop.windowBeginDate}
            onChange={(v) => onChange({ windowBeginDate: v })}
            disabled={disabled}
          />
          <TimeInput
            label="Begin time"
            value={stop.windowBeginTime}
            onChange={(v) => onChange({ windowBeginTime: v })}
            disabled={disabled}
          />
          <DateInput
            label="End date"
            value={stop.windowEndDate}
            onChange={(v) => onChange({ windowEndDate: v })}
            disabled={disabled}
          />
          <TimeInput
            label="End time"
            value={stop.windowEndTime}
            onChange={(v) => onChange({ windowEndTime: v })}
            disabled={disabled}
          />
        </div>

        {/* Commodity row */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr 1fr',
            gap: 8,
            alignItems: 'flex-end',
            marginTop: 6,
          }}
        >
          <div>
            <FieldLabel>Commodity</FieldLabel>
            <Input
              value={stop.commodityDescription}
              onChange={(e) =>
                onChange({ commodityDescription: e.target.value })
              }
              placeholder="e.g. Frozen poultry"
              disabled={disabled}
            />
          </div>
          <div>
            <FieldLabel>Units</FieldLabel>
            <Select
              value={stop.commodityUnits}
              onValueChange={(v) =>
                onChange({
                  commodityUnits: v as StopsListItem['commodityUnits'],
                })
              }
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <FieldLabel>Pieces</FieldLabel>
            <Input
              type="number"
              value={String(stop.pieces ?? '')}
              onChange={(e) =>
                onChange({ pieces: Number(e.target.value) || 0 })
              }
              placeholder="0"
              disabled={disabled}
            />
          </div>
          <div>
            <FieldLabel>Weight (lbs)</FieldLabel>
            <Input
              type="number"
              value={stop.weight !== undefined ? String(stop.weight) : ''}
              onChange={(e) =>
                onChange({
                  weight: e.target.value ? Number(e.target.value) : undefined,
                })
              }
              placeholder="0"
              disabled={disabled}
            />
          </div>
        </div>

        {/* Instructions */}
        <div style={{ marginTop: 6 }}>
          <FieldLabel>Instructions</FieldLabel>
          <Textarea
            value={stop.instructions ?? ''}
            onChange={(e) => onChange({ instructions: e.target.value })}
            rows={2}
            placeholder="Check-in details, dock # if known, etc."
            disabled={disabled}
          />
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────
 *  Internal helpers
 * ──────────────────────────────────────────────────────────────── */

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--text-secondary)',
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

/** Tiny icon button used for stop-card reorder + remove. Mirrors
 *  WBtn's `ghost` look but at a tighter size so it doesn't crowd the
 *  header row. */
function IconBtn({
  label,
  iconName,
  iconRotate,
  onClick,
  disabled,
}: {
  label: string;
  iconName: 'chevron-down' | 'trash';
  iconRotate?: number;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="focus-ring"
      style={{
        all: 'unset',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 6,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        color: 'var(--text-tertiary)',
        transition: 'background 120ms, color 120ms',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = 'var(--bg-row-hover)';
        e.currentTarget.style.color = 'var(--text-primary)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = 'var(--text-tertiary)';
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          transform: iconRotate ? `rotate(${iconRotate}deg)` : undefined,
        }}
      >
        <WIcon name={iconName} size={13} />
      </span>
    </button>
  );
}

/** Date input that wraps DatePicker for compact use inside the stop card. */
function DateInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const dateValue = React.useMemo(() => {
    if (!value) return undefined;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!m) return undefined;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }, [value]);

  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <DatePicker
        name={label.toLowerCase().replace(/\s/g, '-')}
        value={dateValue}
        onChange={(d) =>
          onChange(d ? formatYmd(d) : '')
        }
        disabled={disabled}
      />
    </div>
  );
}

/** Native time input — shadcn doesn't ship one and the design just
 *  uses `<input type="time">`. Stored as `HH:MM`; the page wrapper
 *  passes it straight to the mutation, which accepts either `HH:MM`
 *  or a full ISO string. */
function TimeInput({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <Input
        type="time"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
