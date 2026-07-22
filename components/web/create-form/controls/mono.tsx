/**
 * Mono control — monospaced text input with optional prefix/suffix
 * addons. Used for VIN, MC#, DOT#, plates, receipt #, etc.
 *
 * The prefix/suffix slots wrap via shadcn's <InputGroup>: the addons
 * render as part of the same control chrome, so focus styling and
 * border treatment stay coherent.
 */

'use client';

import * as React from 'react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { cn } from '@/lib/utils';

export interface MonoControlProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  disabled?: boolean;
  hasError?: boolean;
}

export function MonoControl({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  prefix,
  suffix,
  disabled,
  hasError,
}: MonoControlProps) {
  return (
    <InputGroup
      className={cn(hasError && 'border-[#B43030]')}
      aria-invalid={hasError ? true : undefined}
    >
      {prefix && (
        <InputGroupAddon align="inline-start">{prefix}</InputGroupAddon>
      )}
      <InputGroupInput
        id={id}
        type="text"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        disabled={disabled}
        className="font-mono"
      />
      {suffix && (
        <InputGroupAddon align="inline-end">{suffix}</InputGroupAddon>
      )}
    </InputGroup>
  );
}
