/**
 * DSActivity — vertical timeline for record activity feeds.
 *
 * Each entry is `{ icon, text, when, who? }`. Renders as a left-rail of
 * dot-icons connected by a hairline, with text and metadata to the right.
 * Used in the right-rail of the full-page details ("Recent activity").
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';

export interface DSActivityItem {
  id?: string | number;
  icon?: IconName;
  text: React.ReactNode;
  when: React.ReactNode;
  who?: React.ReactNode;
}

interface DSActivityProps {
  items: DSActivityItem[];
  className?: string;
  emptyText?: React.ReactNode;
}

export function DSActivity({ items, className, emptyText = 'No activity yet.' }: DSActivityProps) {
  if (items.length === 0) {
    return (
      <p className={cn('text-[12.5px] text-[var(--text-tertiary)] py-3', className)}>{emptyText}</p>
    );
  }
  return (
    <ol className={cn('relative flex flex-col gap-3 m-0 p-0 list-none', className)}>
      <span
        aria-hidden
        className="absolute left-[10px] top-1.5 bottom-1.5 w-px"
        style={{ background: 'var(--border-hairline)' }}
      />
      {items.map((it, i) => (
        <li key={it.id ?? i} className="relative pl-7 flex flex-col">
          <span
            className="absolute left-1 top-1.5 h-[18px] w-[18px] rounded-full flex items-center justify-center bg-card text-[var(--text-tertiary)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <WIcon name={it.icon ?? 'circle-dot'} size={10} />
          </span>
          <p className="m-0 text-[12.5px] leading-[18px] text-foreground">{it.text}</p>
          <p className="m-0 text-[11.5px] leading-[16px] text-[var(--text-tertiary)]">
            {it.when}
            {it.who && (
              <>
                {' · '}
                {it.who}
              </>
            )}
          </p>
        </li>
      ))}
    </ol>
  );
}
