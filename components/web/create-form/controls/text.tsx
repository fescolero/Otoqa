/**
 * Text control — wraps the shadcn <Input>. The shell never imports
 * components/ui/* directly; controls are the boundary.
 */

'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface TextControlProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
  /** Apply monospace font (mono kind). */
  mono?: boolean;
  /** type="email" / "tel" / etc. when needed. */
  type?: string;
}

export function TextControl({
  id,
  value,
  onChange,
  onBlur,
  placeholder,
  disabled,
  hasError,
  mono,
  type,
}: TextControlProps) {
  return (
    <Input
      id={id}
      type={type ?? 'text'}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={hasError ? true : undefined}
      className={cn(
        hasError && 'border-[#B43030] focus-visible:ring-[#B43030]/40',
        mono && 'font-mono',
      )}
    />
  );
}
