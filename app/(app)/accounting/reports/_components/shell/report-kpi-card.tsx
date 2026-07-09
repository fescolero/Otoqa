'use client';

import type { ReactNode } from 'react';
import { WIcon } from '@/components/web';
import { cn } from '@/lib/utils';
import { AC_NEG, AC_POS } from './tokens';

export type KpiTone = 'up' | 'down' | 'flat';

interface ReportKpiCardProps {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  tone?: KpiTone;
  onClick?: () => void;
}

const toneColor: Record<KpiTone, string> = {
  up: AC_POS,
  down: AC_NEG,
  flat: 'var(--text-tertiary)',
};

/** KPI scorecard used across the Reports views. Clickable when `onClick` is set. */
export function ReportKpiCard({ label, value, delta, tone = 'flat', onClick }: ReportKpiCardProps) {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-disabled={!clickable}
      className={cn(
        'group relative flex min-w-0 flex-col rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-3.5 text-left transition',
        clickable
          ? 'cursor-pointer hover:border-[var(--border-hairline-strong)] hover:shadow-[var(--shadow-popover)]'
          : 'cursor-default',
      )}
    >
      {clickable && (
        <WIcon
          name="chevron-right"
          size={13}
          className="absolute right-3 top-3 text-[var(--text-tertiary)] opacity-30 transition group-hover:opacity-90"
        />
      )}
      <div className="tw-label truncate pr-4 text-[10.5px] text-[var(--text-tertiary)]">{label}</div>
      <div className="num mt-2 text-[24px] font-semibold leading-[26px] tracking-[-0.015em]">{value}</div>
      {delta != null && (
        <div className="num mt-1 truncate text-[11.5px] font-medium" style={{ color: toneColor[tone] }}>
          {delta}
        </div>
      )}
    </button>
  );
}
