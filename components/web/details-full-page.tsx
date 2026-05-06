/**
 * DetailsFullPage — full-screen record landing page.
 *
 * Sub-toolbar (back / breadcrumb / prev-next / actions) → hero block
 * (title + status + identity subtitle + 4-up KPI grid) → horizontal
 * section tabs → 2-col body (section content left, persistent right rail
 * with comments toggle).
 *
 * The hero, KPIs, sections, and rail are pluggable via props so each
 * record type (Driver/Load/Truck) can build its own layout while reusing
 * the shell.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';
import { WBtn } from './btn';
import { DSStat } from './ds-card';

export interface FPSection {
  id: string;
  label: React.ReactNode;
  icon?: IconName;
  count?: number;
  attention?: number;
  content: React.ReactNode;
}

export interface FPKpi {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: { value: React.ReactNode; tone?: 'up' | 'down' | 'neutral' };
}

interface DetailsFullPageProps {
  /** Top sub-toolbar content. */
  breadcrumb?: React.ReactNode;
  onBack?: () => void;
  prevLabel?: React.ReactNode;
  onPrev?: (() => void) | null;
  nextLabel?: React.ReactNode;
  onNext?: (() => void) | null;
  toolbarActions?: React.ReactNode;

  /** Hero block. */
  title: React.ReactNode;
  /** Optional row above the title (status chip etc.). */
  eyebrow?: React.ReactNode;
  /** Identity subtitle (phone · email · license, etc.). */
  subtitle?: React.ReactNode;
  /** 4-up KPI grid. */
  kpis?: FPKpi[];

  sections: FPSection[];
  rightRail?: React.ReactNode;
  className?: string;
  /** Controlled active-section id. Combine with `onActiveChange` so an
   *  outer composer (e.g. an AttentionBand jump) can drive the tabs. */
  activeId?: string;
  onActiveChange?: (id: string) => void;
}

export function DetailsFullPage({
  breadcrumb,
  onBack,
  prevLabel,
  onPrev,
  nextLabel,
  onNext,
  toolbarActions,
  title,
  eyebrow,
  subtitle,
  kpis,
  sections,
  rightRail,
  className,
  activeId: controlledActiveId,
  onActiveChange,
}: DetailsFullPageProps) {
  const [internalActiveId, setInternalActiveId] = React.useState(sections[0]?.id ?? '');
  const isControlled = controlledActiveId !== undefined;
  const activeId = isControlled ? controlledActiveId : internalActiveId;
  const setActiveId = (id: string) => {
    if (!isControlled) setInternalActiveId(id);
    onActiveChange?.(id);
  };
  React.useEffect(() => {
    if (isControlled) return;
    if (!sections.find((s) => s.id === internalActiveId) && sections[0]) {
      setInternalActiveId(sections[0].id);
    }
  }, [sections, internalActiveId, isControlled]);

  const active = sections.find((s) => s.id === activeId) ?? sections[0];

  return (
    <div className={cn('flex-1 flex flex-col min-h-0 bg-background', className)}>
      {/* Sub-toolbar */}
      <div className="h-12 px-6 flex items-center gap-2 border-b border-[var(--border-hairline)] bg-card shrink-0">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            className="focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground"
            title="Back"
          >
            <WIcon name="chevron-left" size={14} />
          </button>
        )}
        {breadcrumb && <div className="flex items-center text-[12.5px] text-[var(--text-secondary)]">{breadcrumb}</div>}
        <div className="flex-1" />
        {(onPrev || onNext) && (
          <div className="flex items-center gap-1 mr-2">
            <button
              type="button"
              disabled={!onPrev}
              onClick={() => onPrev?.()}
              title={typeof prevLabel === 'string' ? `← ${prevLabel}` : 'Previous'}
              className={cn(
                'focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md',
                onPrev ? 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground' : 'text-[var(--text-disabled)] cursor-not-allowed',
              )}
            >
              <WIcon name="chevron-left" size={14} />
            </button>
            <button
              type="button"
              disabled={!onNext}
              onClick={() => onNext?.()}
              title={typeof nextLabel === 'string' ? `${nextLabel} →` : 'Next'}
              className={cn(
                'focus-ring h-8 w-8 inline-flex items-center justify-center rounded-md',
                onNext ? 'text-[var(--text-secondary)] hover:bg-[var(--bg-row-hover)] hover:text-foreground' : 'text-[var(--text-disabled)] cursor-not-allowed',
              )}
            >
              <WIcon name="chevron-right" size={14} />
            </button>
          </div>
        )}
        {toolbarActions}
      </div>

      <div className="flex-1 overflow-auto scroll-thin">
        {/* Hero */}
        <header className="px-6 py-6 flex flex-col gap-4 border-b border-[var(--border-hairline)]">
          {eyebrow && <div className="flex items-center gap-2">{eyebrow}</div>}
          <h1 className="m-0 text-[32px] leading-10 font-semibold tracking-[-0.015em] text-foreground">{title}</h1>
          {subtitle && <p className="m-0 text-[13px] text-[var(--text-secondary)]">{subtitle}</p>}
          {kpis && kpis.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-0 mt-2 rounded-xl border border-[var(--border-hairline)] bg-card overflow-hidden">
              {kpis.map((k, i) => (
                <div
                  key={i}
                  className={cn(
                    'p-4',
                    i > 0 && 'border-l border-[var(--border-hairline)]',
                  )}
                >
                  <DSStat label={k.label} value={k.value} delta={k.delta} />
                </div>
              ))}
            </div>
          )}
        </header>

        {/* Section tabs */}
        <div className="px-6 flex items-end h-10 border-b border-[var(--border-hairline)] bg-card sticky top-0 z-[1] overflow-x-auto scroll-thin">
          {sections.map((s) => {
            const a = s.id === activeId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setActiveId(s.id)}
                className={cn(
                  'focus-ring relative h-10 px-3 inline-flex items-center gap-1.5 text-[12.5px] cursor-pointer',
                  a ? 'text-foreground font-medium' : 'text-[var(--text-secondary)] hover:text-foreground',
                )}
              >
                {s.icon && <WIcon name={s.icon} size={12} />}
                <span>{s.label}</span>
                {s.count != null && (
                  <span className="num text-[10.5px] text-[var(--text-tertiary)]">{s.count}</span>
                )}
                {s.attention != null && s.attention > 0 && (
                  <span
                    className="num inline-flex items-center justify-center min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold"
                    style={{ background: 'rgba(245,158,11,0.18)', color: '#A66800' }}
                  >
                    {s.attention}
                  </span>
                )}
                <span
                  aria-hidden
                  className="absolute -bottom-px left-2 right-2 h-0.5 rounded-sm"
                  style={{ background: a ? 'var(--accent)' : 'transparent' }}
                />
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
          <div className="flex flex-col gap-4 min-w-0">{active?.content}</div>
          {rightRail && <aside className="flex flex-col gap-4">{rightRail}</aside>}
        </div>
      </div>
    </div>
  );
}

/** Compact toolbar action button used inside DetailsFullPage's sub-toolbar. */
export function FPToolbarBtn({
  icon,
  children,
  onClick,
  variant,
}: {
  icon?: IconName;
  children?: React.ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
}) {
  return (
    <WBtn variant={variant ?? 'ghost'} size="sm" leading={icon} onClick={onClick}>
      {children}
    </WBtn>
  );
}
