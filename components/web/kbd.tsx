/**
 * Kbd — keyboard shortcut hint badge.
 *
 * Inline element that renders inside search inputs, command-palette rows,
 * and tooltip body. Visually quiet — doesn't compete with surrounding text.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

interface KbdProps extends React.HTMLAttributes<HTMLElement> {
  children: React.ReactNode;
}

export function Kbd({ children, className, ...rest }: KbdProps) {
  return (
    <kbd
      {...rest}
      className={cn(
        'inline-flex items-center justify-center rounded',
        'min-w-[18px] h-[18px] px-[5px]',
        'bg-card text-[var(--text-secondary)]',
        'border border-[var(--border-hairline)]',
        'text-[10.5px] font-medium font-sans',
        className,
      )}
      style={{ boxShadow: 'inset 0 -1px 0 var(--border-hairline)' }}
    >
      {children}
    </kbd>
  );
}
