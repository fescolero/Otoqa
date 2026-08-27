/**
 * Text control — wraps the shadcn <Input>. The shell never imports
 * components/ui/* directly; controls are the boundary.
 *
 * When `format` is set, every keystroke runs through the formatter
 * before being committed to state. We do NOT track selection ranges:
 * the trade-off is that backspacing across a separator (e.g. the `)`
 * after the area code) lands you on a separator that re-renders on
 * the next keystroke. Acceptable for a 10-char input — most users
 * type forwards or paste; the formatter handles both.
 */

'use client';

import * as React from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatUsPhone } from '@/lib/format-phone';

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
  /**
   * Live formatter applied on input. Currently `'phone-us'` only —
   * forces `type="tel"` so mobile keyboards default to numeric.
   */
  format?: 'phone-us';
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
  format,
}: TextControlProps) {
  const inputType = format === 'phone-us' ? 'tel' : (type ?? 'text');

  const handleChange = React.useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value;
      if (format === 'phone-us') {
        onChange(formatUsPhone(raw));
        return;
      }
      onChange(raw);
    },
    [onChange, format],
  );

  return (
    <Input
      id={id}
      type={inputType}
      // Browser-level guardrail to keep the on-screen keyboard
      // numeric on mobile, even though `type="tel"` already nudges
      // that direction on most platforms.
      inputMode={format === 'phone-us' ? 'tel' : undefined}
      autoComplete={format === 'phone-us' ? 'tel' : undefined}
      // `maxLength` matches the longest formatted output for a 10-
      // digit NANP number — `(XXX) XXX-XXXX` = 14 chars. Prevents
      // paste-bombs from a 30-digit string from blowing past the
      // visible field even though the formatter already caps digits.
      maxLength={format === 'phone-us' ? 14 : undefined}
      value={value ?? ''}
      onChange={handleChange}
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
