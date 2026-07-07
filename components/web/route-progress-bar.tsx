/**
 * RouteProgressBar — gradient track + dot markers + endpoint labels.
 *
 *   <RouteProgressBar
 *     percent={67}
 *     from="Sacramento, CA"
 *     to="Salt Lake City, UT"
 *     markers={[
 *       { at: 28, tone: 'warn', label: 'Traffic',  detail: 'Reno · 14m delay' },
 *       { at: 67, tone: 'info', label: 'Now',      detail: '14 mi W of Wells' },
 *     ]}
 *   />
 *
 * Used inside the load Overview's Live tracking card. The composer feeds it
 * real progress (% complete) and any incident pins it has from the trip.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export type ProgressMarkerTone = 'ok' | 'info' | 'warn' | 'crit';

export interface ProgressMarker {
  at: number;
  tone: ProgressMarkerTone;
  label?: string;
  detail?: string;
}

const TONE_HEX: Record<ProgressMarkerTone, string> = {
  ok:   '#10B981',
  info: '#1A47E6',
  warn: '#F59E0B',
  crit: '#EF4444',
};

interface RouteProgressBarProps {
  percent: number;
  from: React.ReactNode;
  to: React.ReactNode;
  markers?: ProgressMarker[];
  className?: string;
}

export function RouteProgressBar({ percent, from, to, markers, className }: RouteProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div
        className="relative h-1.5 rounded-[3px] border border-[var(--border-hairline)]"
        style={{ background: 'var(--bg-surface-2)' }}
      >
        <div
          className="absolute inset-y-0 left-0 rounded-[3px]"
          style={{
            width: `${clamped}%`,
            background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 80%, transparent))',
          }}
        />
        {(markers ?? []).map((m, i) => {
          const tone = TONE_HEX[m.tone];
          return (
            <div
              key={i}
              title={`${m.label ?? ''}${m.label && m.detail ? ' — ' : ''}${m.detail ?? ''}`}
              className="absolute rounded-full cursor-help"
              style={{
                top: -1,
                left: `calc(${m.at}% - 4px)`,
                width: 8,
                height: 8,
                background: tone,
                border: '1.5px solid var(--bg-surface)',
                boxShadow: `0 0 0 1px ${tone}55`,
              }}
            />
          );
        })}
        <div
          aria-hidden
          className="absolute rounded-full"
          style={{
            top: -3,
            left: `calc(${clamped}% - 6px)`,
            width: 12,
            height: 12,
            background: 'var(--bg-surface)',
            border: '2px solid var(--accent)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
          }}
        />
      </div>
      <div className="flex justify-between text-[11px] text-[var(--text-tertiary)]">
        <span>{from}</span>
        <span className="num font-medium text-foreground">{clamped}%</span>
        <span>{to}</span>
      </div>
      {markers && markers.length > 0 && (
        <div className="flex flex-wrap gap-2.5 mt-1 text-[11px] text-[var(--text-tertiary)]">
          {markers.map((m, i) => (
            <span key={i} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block rounded-full"
                style={{ width: 6, height: 6, background: TONE_HEX[m.tone] }}
              />
              {m.label && <span className="text-[var(--text-secondary)]">{m.label}</span>}
              {m.detail && <span>· {m.detail}</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
