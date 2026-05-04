/**
 * InfiniteFooter — table footer that replaces page controls.
 *
 * Shows "Showing M of N" on the left, and either an animated dots loader
 * with "Scroll for more" / "Loading more…" on the right, or an
 * "End of list" sentinel once `loaded >= total`.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

interface InfiniteFooterProps {
  loaded: number;
  total: number;
  loading?: boolean;
  className?: string;
}

export function InfiniteFooter({ loaded, total, loading = false, className }: InfiniteFooterProps) {
  const done = loaded >= total;
  return (
    <div
      className={cn(
        'h-9 px-6 flex items-center gap-2.5 bg-card border-t border-[var(--border-hairline)]',
        'text-[12px] text-[var(--text-tertiary)]',
        className,
      )}
    >
      <span>
        Showing{' '}
        <span className="num font-medium text-[var(--text-secondary)]">{loaded.toLocaleString()}</span> of{' '}
        <span className="num font-medium text-[var(--text-secondary)]">{total.toLocaleString()}</span>
      </span>
      <div className="flex-1" />
      {done ? (
        <span className="inline-flex items-center gap-1.5 text-[11.5px]">
          <span className="h-1 w-1 rounded-sm opacity-50" style={{ background: 'var(--text-tertiary)' }} />
          End of list
        </span>
      ) : (
        <span className="inline-flex items-center gap-2 text-[11.5px]">
          <span className="inf-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          {loading ? 'Loading more…' : 'Scroll for more'}
        </span>
      )}
    </div>
  );
}
