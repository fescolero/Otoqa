/**
 * Textarea control — wraps the shadcn <Textarea>. Defaults to 3 rows
 * (matches the schema's `rows` default in `record-create-shell.jsx`).
 */

'use client';

import * as React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface TextareaControlProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  hasError?: boolean;
}

export function TextareaControl({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 3,
  disabled,
  hasError,
}: TextareaControlProps) {
  return (
    <Textarea
      id={id}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      rows={rows}
      disabled={disabled}
      aria-invalid={hasError ? true : undefined}
      className={cn(
        hasError && 'border-[#B43030] focus-visible:ring-[#B43030]/40',
      )}
    />
  );
}
