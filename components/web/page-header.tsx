/**
 * PageHeader — fixed-height header strip at the top of every list page.
 *
 * Title on the left, optional comma-separated stat dividers, actions on the
 * right. Lives on a surface fill with a hairline border-bottom to separate
 * from the toolbar/saved-views beneath it.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface PageHeaderStat {
  value: React.ReactNode;
  label: React.ReactNode;
}

interface PageHeaderProps {
  title: React.ReactNode;
  stats?: PageHeaderStat[];
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({ title, stats = [], actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'shrink-0 flex items-center gap-4 px-6',
        'h-[var(--pageheader-h)] bg-card border-b border-[var(--border-hairline)]',
        className,
      )}
    >
      <h1 className="m-0 text-[18px] font-semibold tracking-[-0.005em] text-foreground">{title}</h1>
      {stats.length > 0 && (
        <div className="flex items-center pl-1">
          {stats.map((s, i) => (
            <React.Fragment key={i}>
              {i > 0 && (
                <span
                  aria-hidden
                  className="mx-3 h-3.5 w-px opacity-60"
                  style={{ background: 'var(--border-hairline-strong)' }}
                />
              )}
              <span className="inline-flex items-baseline gap-1.5">
                <span className="num text-[13px] font-semibold text-foreground">{s.value}</span>
                <span className="text-[12px] text-[var(--text-tertiary)]">{s.label}</span>
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
      <div className="flex-1" />
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
