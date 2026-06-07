/**
 * Number control — wraps the shadcn <NumberInput>. Emits `undefined`
 * for empty input (which the shell treats as "empty" for tier1 check)
 * and a plain `number` otherwise. The display formats with thousands
 * separators automatically.
 *
 * Used by:
 *   - kind: 'number'   → optional `suffix` (e.g. "gal", "lbs", "ft³")
 *   - kind: 'currency' → forces `$` prefix via the wrapping field
 */

'use client';

import * as React from 'react';
import { NumberInput } from '@/components/ui/number-input';
import {
  InputGroup,
  InputGroupAddon,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

export interface NumberControlProps {
  id: string;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  onBlur?: () => void;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
  hasError?: boolean;
}

export function NumberControl({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  prefix,
  suffix,
  disabled,
  hasError,
}: NumberControlProps) {
  const input = (
    <NumberInput
      id={id}
      value={value}
      onValueChange={onChange}
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={hasError ? true : undefined}
      className={cn(
        hasError && 'border-[#B43030] focus-visible:ring-[#B43030]/40',
        (prefix || suffix) && 'border-0 focus-visible:ring-0 focus-visible:ring-offset-0',
      )}
    />
  );

  // Bare number — no prefix/suffix.
  if (!prefix && !suffix) return input;

  // Wrapped with addon(s). The NumberInput already handles its own
  // border; collapse it when wrapped so the InputGroup chrome takes over.
  return (
    <InputGroup
      className={cn(hasError && 'border-[#B43030]')}
      aria-invalid={hasError ? true : undefined}
    >
      {prefix && (
        <InputGroupAddon align="inline-start">{prefix}</InputGroupAddon>
      )}
      {input}
      {suffix && (
        <InputGroupAddon align="inline-end">{suffix}</InputGroupAddon>
      )}
    </InputGroup>
  );
}
