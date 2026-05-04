/**
 * Web Checkbox — accent-filled square with checkmark / indeterminate bar.
 *
 * Distinct from shadcn's Checkbox because the table needs a tighter visual
 * (16x16, 4px radius) and indeterminate state for "some-rows-selected".
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon } from './icons';

interface CheckboxProps {
  checked?: boolean;
  indeterminate?: boolean;
  onChange?: (next: boolean) => void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
}

export function Checkbox({
  checked = false,
  indeterminate = false,
  onChange,
  ariaLabel,
  className,
  disabled,
}: CheckboxProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  const filled = checked || indeterminate;

  return (
    <label
      className={cn('inline-flex relative h-4 w-4', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', className)}
    >
      <input
        ref={ref}
        type="checkbox"
        aria-label={ariaLabel}
        disabled={disabled}
        checked={checked}
        onChange={(e) => onChange?.(e.target.checked)}
        className="absolute inset-0 m-0 opacity-0"
      />
      <span
        aria-hidden
        className={cn(
          'h-4 w-4 rounded inline-flex items-center justify-center transition-all duration-[var(--dur-fast)] ease-[var(--ease-out)] text-white',
          filled
            ? 'bg-[var(--accent)] border border-[var(--accent)]'
            : 'bg-card border border-[var(--border-hairline-strong)]',
        )}
      >
        {indeterminate ? (
          <span className="block h-0.5 w-2 rounded-sm bg-white" />
        ) : checked ? (
          <WIcon name="check" size={10} strokeWidth={2.4} color="#fff" />
        ) : null}
      </span>
    </label>
  );
}
