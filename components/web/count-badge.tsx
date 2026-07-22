/**
 * CountBadge — small inline numeric badge with tone variants.
 *
 * Used in saved-view tabs ("Active 17"), filter pills, sidebar attention
 * counters. Animates with a quick pop on value change.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export type CountTone = 'neutral' | 'accent' | 'warn' | 'danger';

const TONE: Record<CountTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: 'var(--bg-surface-2)',     fg: 'var(--text-secondary)', bd: 'var(--border-hairline)' },
  accent:  { bg: 'rgba(46,92,255,0.10)',    fg: 'var(--accent)',         bd: 'transparent' },
  warn:    { bg: 'rgba(245,158,11,0.14)',   fg: '#A66800',               bd: 'transparent' },
  danger:  { bg: 'rgba(239,68,68,0.12)',    fg: '#B43030',               bd: 'transparent' },
};

interface CountBadgeProps {
  n: number | string;
  tone?: CountTone;
  className?: string;
}

export function CountBadge({ n, tone = 'neutral', className }: CountBadgeProps) {
  const t = TONE[tone];
  const [bump, setBump] = React.useState(0);
  const prev = React.useRef(n);

  React.useEffect(() => {
    if (prev.current !== n) {
      setBump((b) => b + 1);
      prev.current = n;
    }
  }, [n]);

  return (
    <span
      key={bump}
      className={cn(
        'badge-pop num inline-flex items-center justify-center rounded-full',
        'min-w-[18px] h-[18px] px-[5px]',
        'text-[10.5px] font-semibold tracking-[0.02em]',
        className,
      )}
      style={{ background: t.bg, color: t.fg, border: `1px solid ${t.bd}` }}
    >
      {n}
    </span>
  );
}
