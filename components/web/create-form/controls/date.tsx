/**
 * Date control — wraps shadcn <DatePicker>. The shell stores dates as
 * `YYYY-MM-DD` strings (ISO date, no time), so the wrapper converts:
 *
 *   string ↔ Date at the boundary
 *
 * This keeps `vals[fieldId]` JSON-stringifiable for autosave drafts
 * and makes it trivial for the page wrapper to remap into whatever the
 * Convex mutation expects (a Unix ms number for `fuelEntries.create`'s
 * `entryDate`; the same ISO string for `drivers.create`'s `dob`; etc.).
 */

'use client';

import * as React from 'react';
import { DatePicker } from '@/components/ui/date-picker';

export interface DateControlProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
}

export function DateControl({
  id,
  value,
  onChange,
  placeholder,
  disabled,
}: DateControlProps) {
  // The picker wants a Date; we hand it back the ISO YYYY-MM-DD slice
  // of whatever it gives us. `new Date('2026-06-05')` would parse as
  // UTC midnight and shift on display — instead we parse the parts
  // explicitly so the picker keeps the same calendar day the user sees.
  const dateValue = React.useMemo(() => parseYmd(value), [value]);

  return (
    <DatePicker
      id={id}
      name={id}
      value={dateValue}
      onChange={(d) => onChange(d ? formatYmd(d) : '')}
      placeholder={placeholder ?? 'yyyy-mm-dd'}
      disabled={disabled}
    />
  );
}

function parseYmd(s: string | undefined | null): Date | undefined {
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
  }
  // Construct in local time so the picker's calendar day matches input.
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
