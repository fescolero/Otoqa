/**
 * Lane-stops composite — repeating contract-lane stop cards.
 *
 * Richer than a load's `stops-list` (which describes a single booked
 * load): each contract-lane stop can bind to a customer facility so
 * imported loads snap to the facility's verified pin for driver
 * geofencing. Facility rows are injected by the page wrapper through
 * the schema factory (`field.facilities`) — the control itself never
 * queries Convex, keeping the create-form shell backend-free.
 *
 * Storage shape mirrors the `stops` array validator on
 * `api.contractLanes.create`/`update` exactly, so the page wrapper's
 * mapping is a straight copy. Ported from the legacy
 * `components/contract-lanes/stop-input.tsx` (retired with the
 * contract-lane page redesign) with the design-system card chrome
 * from record-create-shell.jsx's LaneStops.
 */

'use client';

import * as React from 'react';
import {
  AddressAutocomplete,
  type AddressData,
} from '@/components/ui/address-autocomplete';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { WBtn } from '@/components/web/btn';
import { WIcon } from '@/components/web/icons';
import { SegmentedControl } from './segmented';
import type { FieldOption } from '../schema-types';

/* ────────────────────────────────────────────────────────────────────
 *  Wire shape — matches `api.contractLanes.create`'s `stops` array
 *  validator exactly. `facilityId` is kept as a plain string here so
 *  this file stays free of `convex/_generated` imports; the page
 *  wrapper casts to `Id<'facilities'>` on save.
 * ──────────────────────────────────────────────────────────────── */

export interface LaneStopItem {
  address: string;
  city: string;
  state: string;
  zip: string;
  stopOrder: number;
  stopType: 'Pickup' | 'Delivery';
  type: 'APPT' | 'FCFS' | 'Live';
  arrivalTime: string;
  facilityId?: string;
  nassCode?: string;
}

/** Facility row injected by the page wrapper — enough payload to fill
 *  the address fields when a stop binds to it. */
export interface LaneFacilityOption {
  id: string;
  label: string;
  addressLine1?: string;
  city: string;
  state: string;
  postalCode?: string;
  externalCode?: string;
  verified?: boolean;
}

const STOP_TYPE_OPTIONS: FieldOption[] = [
  { value: 'Pickup', label: 'Pickup' },
  { value: 'Delivery', label: 'Delivery' },
];

const APPT_TYPE_OPTIONS: FieldOption[] = [
  { value: 'APPT', label: 'Appointment' },
  { value: 'FCFS', label: 'First come' },
  { value: 'Live', label: 'Live' },
];

const NO_FACILITY = '__none__';

export function emptyLaneStop(
  stopOrder: number,
  stopType: LaneStopItem['stopType'] = 'Pickup',
): LaneStopItem {
  return {
    address: '',
    city: '',
    state: '',
    zip: '',
    stopOrder,
    stopType,
    type: 'APPT',
    arrivalTime: '',
  };
}

export interface LaneStopsControlProps {
  id: string;
  value: LaneStopItem[];
  onChange: (next: LaneStopItem[]) => void;
  facilities?: LaneFacilityOption[];
  disabled?: boolean;
}

export function LaneStopsControl({
  value,
  onChange,
  facilities,
  disabled,
}: LaneStopsControlProps) {
  // Defensive: an empty array still renders one editable pickup row.
  const stops = value && value.length > 0 ? value : [emptyLaneStop(1)];

  const updateStop = (index: number, patch: Partial<LaneStopItem>) => {
    onChange(stops.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const addStop = () => {
    // First stop defaults to Pickup, later ones to Delivery — the
    // common lane is one pickup followed by deliveries.
    onChange([...stops, emptyLaneStop(stops.length + 1, 'Delivery')]);
  };

  const removeStop = (index: number) => {
    if (stops.length <= 1) return;
    onChange(
      stops
        .filter((_, i) => i !== index)
        .map((s, i) => ({ ...s, stopOrder: i + 1 })),
    );
  };

  const moveStop = (index: number, dir: -1 | 1) => {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= stops.length) return;
    const next = stops.slice();
    [next[index], next[newIndex]] = [next[newIndex], next[index]];
    onChange(next.map((s, i) => ({ ...s, stopOrder: i + 1 })));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stops.map((stop, i) => (
        <LaneStopCard
          key={i}
          stop={stop}
          index={i}
          isFirst={i === 0}
          isLast={i === stops.length - 1}
          canRemove={stops.length > 1}
          facilities={facilities}
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

interface LaneStopCardProps {
  stop: LaneStopItem;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
  facilities?: LaneFacilityOption[];
  disabled?: boolean;
  onChange: (patch: Partial<LaneStopItem>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}

function LaneStopCard({
  stop,
  index,
  isFirst,
  isLast,
  canRemove,
  facilities,
  disabled,
  onChange,
  onRemove,
  onMove,
}: LaneStopCardProps) {
  const handleAddressSelect = (data: AddressData) => {
    onChange({
      address: data.address,
      city: data.city,
      state: data.state,
      zip: data.postalCode,
    });
  };

  // Binding a facility fills the address fields from the registry row —
  // one source of truth for where the stop physically is.
  const bindFacility = (facilityId: string) => {
    if (facilityId === NO_FACILITY) {
      onChange({ facilityId: undefined });
      return;
    }
    const facility = facilities?.find((f) => f.id === facilityId);
    onChange({
      facilityId,
      ...(facility
        ? {
            address: facility.addressLine1 || stop.address,
            city: facility.city,
            state: facility.state,
            zip: facility.postalCode || stop.zip,
            ...(facility.externalCode ? { nassCode: facility.externalCode } : {}),
          }
        : {}),
    });
  };

  return (
    <section
      style={{
        border: '1px solid var(--border-hairline-strong)',
        borderRadius: 10,
        background: 'var(--bg-surface)',
        overflow: 'hidden',
      }}
    >
      {/* Header row: badge + pickup/delivery segmented + reorder/remove */}
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
          aria-label={`Stop ${stop.stopOrder}`}
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
          {stop.stopOrder}
        </span>
        <SegmentedControl
          id={`lane-stop-${index}-type`}
          value={stop.stopType}
          onChange={(v) => onChange({ stopType: v as LaneStopItem['stopType'] })}
          options={STOP_TYPE_OPTIONS}
          disabled={disabled}
        />
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          <IconBtn
            label="Move up"
            iconName="chevron-down"
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
        {(facilities?.length ?? 0) > 0 && (
          <div>
            <FieldLabel>Facility</FieldLabel>
            <Select
              value={stop.facilityId ?? NO_FACILITY}
              onValueChange={bindFacility}
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Bind to a facility (optional)" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_FACILITY}>No facility binding</SelectItem>
                {facilities!.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.label}
                    {f.verified ? ' ✓' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Hint>
              Imported loads snap this stop to the facility&apos;s pin for driver
              geofencing.
            </Hint>
          </div>
        )}

        <div>
          <FieldLabel>Address</FieldLabel>
          <AddressAutocomplete
            value={stop.address}
            onChange={(v) => onChange({ address: v })}
            onSelect={handleAddressSelect}
            placeholder="Start typing an address…"
            disabled={disabled}
          />
          <Hint>Type to search or enter manually.</Hint>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 0.7fr 0.9fr',
            gap: 10,
          }}
        >
          <div>
            <FieldLabel>City</FieldLabel>
            <Input
              value={stop.city}
              onChange={(e) => onChange({ city: e.target.value })}
              placeholder="City"
              disabled={disabled}
            />
          </div>
          <div>
            <FieldLabel>State</FieldLabel>
            <Input
              value={stop.state}
              onChange={(e) => onChange({ state: e.target.value })}
              placeholder="CA"
              disabled={disabled}
            />
          </div>
          <div>
            <FieldLabel>ZIP</FieldLabel>
            <Input
              value={stop.zip}
              onChange={(e) => onChange({ zip: e.target.value })}
              placeholder="00000"
              disabled={disabled}
            />
          </div>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
          }}
        >
          <div>
            <FieldLabel>Appointment type</FieldLabel>
            <Select
              value={stop.type}
              onValueChange={(v) => onChange({ type: v as LaneStopItem['type'] })}
              disabled={disabled}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {APPT_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <FieldLabel>Arrival time</FieldLabel>
            <Input
              type="time"
              value={stop.arrivalTime}
              onChange={(e) => onChange({ arrivalTime: e.target.value })}
              disabled={disabled}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────
 *  Internal helpers — same look as stops-list.tsx's
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

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 5 }}>
      {children}
    </div>
  );
}

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
