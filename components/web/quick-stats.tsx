/**
 * QuickStats — small KPI strip used inside record Overview composers.
 *
 * Replaces the cold "4-up KPI grid" the v1 hero showed for every record.
 * v2 puts the stats inside the body so they sit close to the Now /
 * Compliance / Recent activity cards that explain them.
 *
 *   <QuickStats stats={[
 *     { label: 'Active loads', value: 1 },
 *     { label: 'Loads YTD',    value: '142' },
 *     { label: 'Score',        value: '92', delta: '+3', deltaTone: 'up' },
 *   ]} />
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export type DeltaTone = 'up' | 'down' | 'neutral';

export interface QuickStat {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: DeltaTone;
}

export function QuickStats({ stats, className }: { stats: QuickStat[]; className?: string }) {
  if (stats.length === 0) return null;
  const cols = Math.min(stats.length, 5);
  return (
    <div
      className={cn(
        'grid bg-card rounded-[10px] border border-[var(--border-hairline)] overflow-hidden',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
    >
      {stats.map((s, i) => (
        <div
          key={i}
          className="px-3.5 py-2.5"
          style={{ borderLeft: i > 0 ? '1px solid var(--border-hairline)' : 0 }}
        >
          <div className="tw-label text-[10px] text-[var(--text-tertiary)]">{s.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <div className="num text-[17px] font-semibold tracking-[-0.01em] text-foreground">
              {s.value}
            </div>
            {s.delta != null && (
              <div
                className="num text-[11px] font-medium"
                style={{
                  color:
                    s.deltaTone === 'up'   ? '#0F8C5F' :
                    s.deltaTone === 'down' ? '#B43030' :
                                             'var(--text-tertiary)',
                }}
              >
                {s.delta}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
