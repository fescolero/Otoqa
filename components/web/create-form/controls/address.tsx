/**
 * Address composite — wraps <AddressAutocomplete> from components/ui/
 * (NOT components/web/EditableAddress, which is shaped for inline edit
 * on detail pages and has a click-to-enter state inappropriate here).
 *
 * The schema declares the field as
 *   { kind: 'address',
 *     ids: { street: 'addrStreet', suite: 'addrSuite',
 *            city: 'addrCity', state: 'addrState', zip: 'addrZip' } }
 *
 * The control reads/writes those 5 sibling field ids in `vals`. The
 * autocomplete dropdown commits all 5 at once when the user picks a
 * place; the suite line stays user-editable below.
 *
 * Layout is always full-row (Rule 3 composite kinds), but inside the
 * row we split into a 3-column subgrid: street autocomplete (full),
 * suite (1/3), then city / state / zip on the next visual line.
 */

'use client';

import * as React from 'react';
import {
  AddressAutocomplete,
  type AddressData,
} from '@/components/ui/address-autocomplete';
import { Input } from '@/components/ui/input';
import type { FormValues } from '../schema-types';

interface AddressIdMap {
  street: string;
  suite?: string;
  city: string;
  state: string;
  zip: string;
  /** Optional — see the note on `FormField.ids.country`. */
  country?: string;
}

/**
 * Google returns the country as a long name ("United States",
 * "Canada"), while `state` already comes through as a short code.
 * Schemas that store a country expect the two-letter form, so
 * normalize the North American set this app actually operates in and
 * pass anything else through unchanged rather than guessing.
 */
const COUNTRY_CODES: Record<string, string> = {
  'united states': 'US',
  usa: 'US',
  canada: 'CA',
  mexico: 'MX',
  méxico: 'MX',
};

function toCountryCode(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
  return COUNTRY_CODES[trimmed.toLowerCase()] ?? trimmed;
}

export interface AddressControlProps {
  ids: AddressIdMap;
  vals: FormValues;
  set: (id: string, value: unknown) => void;
  errors: Record<string, string | null | undefined>;
  disabled?: boolean;
}

export function AddressControl({
  ids,
  vals,
  set,
  errors,
  disabled,
}: AddressControlProps) {
  const streetVal = String(vals[ids.street] ?? '');
  const cityVal = String(vals[ids.city] ?? '');
  const stateVal = String(vals[ids.state] ?? '');
  const zipVal = String(vals[ids.zip] ?? '');
  const suiteVal = ids.suite ? String(vals[ids.suite] ?? '') : '';

  const handleSelect = React.useCallback(
    (data: AddressData) => {
      set(ids.street, data.address);
      set(ids.city, data.city);
      set(ids.state, data.state);
      set(ids.zip, data.postalCode);
      // Without this the country silently keeps its seeded default, so
      // autocompleting a Toronto address still saves the record as US.
      if (ids.country && data.country) {
        set(ids.country, toCountryCode(data.country));
      }
    },
    [ids.street, ids.city, ids.state, ids.zip, ids.country, set],
  );

  const anyError =
    errors[ids.street] || errors[ids.city] || errors[ids.state] || errors[ids.zip];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
        <AddressAutocomplete
          value={streetVal}
          onChange={(v) => set(ids.street, v)}
          onSelect={handleSelect}
          placeholder="Start typing an address…"
          disabled={disabled}
        />
        {ids.suite && (
          <Input
            id={ids.suite}
            value={suiteVal}
            onChange={(e) => set(ids.suite!, e.target.value)}
            placeholder="Suite / Apt (optional)"
            disabled={disabled}
          />
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
        <Input
          id={ids.city}
          value={cityVal}
          onChange={(e) => set(ids.city, e.target.value)}
          placeholder="City"
          disabled={disabled}
          aria-invalid={errors[ids.city] ? true : undefined}
        />
        <Input
          id={ids.state}
          value={stateVal}
          onChange={(e) => set(ids.state, e.target.value)}
          placeholder="State"
          disabled={disabled}
          aria-invalid={errors[ids.state] ? true : undefined}
        />
        <Input
          id={ids.zip}
          value={zipVal}
          onChange={(e) => set(ids.zip, e.target.value)}
          placeholder="ZIP"
          disabled={disabled}
          aria-invalid={errors[ids.zip] ? true : undefined}
        />
      </div>
      {anyError && (
        <div
          role="alert"
          style={{
            fontSize: 11.5,
            color: '#B43030',
            lineHeight: 1.45,
          }}
        >
          {anyError}
        </div>
      )}
    </div>
  );
}
