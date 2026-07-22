/**
 * Select control — wraps the shadcn radix-based <Select> family.
 *
 * Empty value semantics: an option with `value: ''` is rendered as the
 * placeholder choice — many of our reference schemas seed the option
 * list with `{ value: '', label: '— Select —' }`. Radix select does
 * NOT allow an empty string as an item value (it throws at runtime),
 * so we filter those out and rely on the Trigger's `placeholder` prop
 * instead.
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

export interface SelectControlProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  options: FieldOption[];
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
}

export function SelectControl({
  id,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  hasError,
}: SelectControlProps) {
  // Radix throws if an item value is empty string. Drop those — they're
  // always sentinel placeholder entries in the source schemas.
  const realOptions = options.filter((o) => o.value !== '');

  return (
    <Select
      value={value || undefined}
      onValueChange={onChange}
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
        {realOptions.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
