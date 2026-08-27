/**
 * Select control — wraps the shadcn radix-based <Select> family.
 *
 * Empty value semantics: an option with `value: ''` is rendered as the
 * placeholder choice — many of our reference schemas seed the option
 * list with `{ value: '', label: '— Select —' }`. Radix select does
 * NOT allow an empty string as an item value (it throws at runtime),
 * so we filter those out and rely on the Trigger's `placeholder` prop
 * instead.
 *
 * That leaves no way to return a select to "no value" once one is
 * picked — the placeholder is ghost text, not a selectable item. Set
 * `clearable` to render a real "— None —" item. It carries a
 * non-empty sentinel value (Radix's constraint) that is translated
 * back to '' before it reaches the form state, so schemas keep using
 * '' as their one representation of "unset".
 */

'use client';

import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { FieldOption } from '../schema-types';

/** Radix forbids an empty item value, so the clear item carries this
 *  instead and `onValueChange` maps it back to ''. Deliberately
 *  unlikely to collide with a real option value or a Convex id. */
const CLEAR_SENTINEL = '__create_form_clear__';

export interface SelectControlProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  options: FieldOption[];
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
  /** Render a "— None —" item so an existing value can be un-set. */
  clearable?: boolean;
  /** Label for that item. Defaults to '— None —'. */
  clearLabel?: string;
}

export function SelectControl({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  hasError,
  clearable,
  clearLabel,
}: SelectControlProps) {
  // Radix throws if an item value is empty string. Drop those — they're
  // always sentinel placeholder entries in the source schemas.
  const realOptions = options.filter((o) => o.value !== '');

  return (
    <Select
      value={value || undefined}
      onValueChange={(next) =>
        onChange(next === CLEAR_SENTINEL ? '' : next)
      }
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-invalid={hasError ? true : undefined}
        className={cn(
          'w-full',
          hasError && 'border-[#B43030] focus-visible:ring-[#B43030]/40',
        )}
      >
        <SelectValue placeholder={placeholder ?? '— Select —'} />
      </SelectTrigger>
      <SelectContent>
        {/* Only worth showing once there is something to clear. */}
        {clearable && value !== '' && (
          <SelectItem value={CLEAR_SENTINEL}>
            {clearLabel ?? '— None —'}
          </SelectItem>
        )}
        {realOptions.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
