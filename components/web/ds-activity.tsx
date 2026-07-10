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
  /** Colors the icon dot: 'ok' green, 'warn' amber. Default neutral. */
  tone?: 'ok' | 'warn';
  text: React.ReactNode;
  when: React.ReactNode;
  who?: React.ReactNode;
}

const TONE_CLASSES: Record<NonNullable<DSActivityItem['tone']>, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
};

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
      {items.map((it, i) => {
        // Treat empty string / null / undefined `when` as "no metadata" so
        // the empty <p> doesn't reserve a 16px row beneath the text —
        // otherwise items with metadata and items without were stacking
        // at different heights.
        const hasMeta =
          (it.when !== undefined && it.when !== null && it.when !== '') ||
          (it.who !== undefined && it.who !== null && it.who !== '');
        return (
          <li key={it.id ?? i} className="relative pl-7 flex flex-col">
            {/* Icon dot — `top-0` aligns the dot's center with the first
                line of text (both are 18px tall). The previous `top-1.5`
                shifted the dot ~6px below the text baseline. */}
            <span
              className={cn(
                'absolute left-1 top-0 h-[18px] w-[18px] rounded-full flex items-center justify-center bg-card',
                it.tone ? TONE_CLASSES[it.tone] : 'text-[var(--text-tertiary)]',
              )}
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <WIcon name={it.icon ?? 'circle-dot'} size={10} />
            </span>
            <p className="m-0 text-[12.5px] leading-[18px] text-foreground">{it.text}</p>
            {hasMeta && (
              <p className="m-0 text-[11.5px] leading-[16px] text-[var(--text-tertiary)]">
                {it.when}
                {it.who && it.when ? ' · ' : null}
                {it.who}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
