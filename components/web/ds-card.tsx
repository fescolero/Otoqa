/**
 * Detail-Slide card primitives.
 *
 *   DSCard         — bordered card with optional header bar (title + action)
 *   DSProps        — key/value grid (120px label col, 1fr value col) with
 *                    hairline dividers between rows; falsy items dropped
 *   DSStat         — large number stat with label and optional delta
 *   DSSectionBlock — labeled section grouping for the scroll layout
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';

interface DSCardProps {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}

export function DSCard({ title, action, children, className, bodyClassName }: DSCardProps) {
  return (
    <section
      className={cn('rounded-xl border border-[var(--border-hairline)] bg-card overflow-hidden', className)}
    >
      {(title || action) && (
        <header
          className="flex items-center justify-between gap-2 px-4 h-11 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-2)]"
        >
          {title && (
            <h3 className="m-0 text-[13px] font-semibold text-foreground tracking-[0.002em]">{title}</h3>
          )}
          {action && <div className="flex items-center gap-1.5">{action}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface DSPropItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Optional editable wrapper / chip / etc. — render-only sentinel. */
  hint?: React.ReactNode;
}

interface DSPropsProps {
  items: Array<DSPropItem | null | undefined | false>;
  className?: string;
  /** Width of the label column in pixels. Default 120. */
  labelWidth?: number;
}

export function DSProps({ items, className, labelWidth = 120 }: DSPropsProps) {
  const live = items.filter(Boolean) as DSPropItem[];
  return (
    <dl className={cn('grid gap-0', className)} style={{ gridTemplateColumns: `${labelWidth}px 1fr` }}>
      {live.map((it, i) => (
        <React.Fragment key={i}>
          <dt
            className={cn(
              'py-2.5 pr-3 text-[12.5px] text-[var(--text-tertiary)]',
              i > 0 && 'border-t border-[var(--border-hairline)]',
            )}
          >
            {it.label}
          </dt>
          <dd
            className={cn(
              'py-2.5 m-0 text-[13px] text-foreground inline-flex items-center gap-2',
              i > 0 && 'border-t border-[var(--border-hairline)]',
            )}
          >
            {it.value}
            {it.hint}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

interface DSStatProps {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: { value: React.ReactNode; tone?: 'up' | 'down' | 'neutral' };
  className?: string;
}

export function DSStat({ label, value, delta, className }: DSStatProps) {
  const deltaColor =
    delta?.tone === 'up'   ? '#0F8C5F' :
    delta?.tone === 'down' ? '#B43030' :
                             'var(--text-tertiary)';
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="tw-label">{label}</span>
      <span className="num text-[24px] leading-7 font-semibold tracking-[-0.01em] text-foreground">{value}</span>
      {delta && (
        <span className="text-[11.5px] font-medium" style={{ color: deltaColor }}>
          {delta.value}
        </span>
      )}
    </div>
  );
}

interface DSSectionBlockProps {
  icon?: IconName;
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function DSSectionBlock({ icon, label, children, className }: DSSectionBlockProps) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <header className="flex items-center gap-2 text-[var(--text-tertiary)]">
        {icon && <WIcon name={icon} size={13} />}
        <span className="tw-label">{label}</span>
      </header>
      {children}
    </section>
  );
}
