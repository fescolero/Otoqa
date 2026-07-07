/**
 * AttentionBand — tone-driven banner that anchors a record Overview.
 *
 *   <AttentionBand
 *     headline={<span>{firstName} is in transit on <em>OT-2026-0418</em>…</span>}
 *     items={[{ tone: 'info', icon: 'truck', tab: 'trips',
 *               title: 'On OT-2026-0418', detail: 'ETA 18:42 PT' }, …]}
 *     onJump={(tabId) => …}
 *   />
 *
 * The band's overall tone is the worst of its items (ok < info < warn < crit).
 * Items render as clickable chip-rows that emit `onJump(tab)` to navigate to
 * the relevant section. When `items` is empty, just the headline row renders.
 *
 * Replaces the cold "4-up KPI grid" in the hero — the band tells you what
 * needs doing now, in one sentence + targeted actions.
 */

'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';

export type AttentionTone = 'ok' | 'info' | 'warn' | 'crit';

export interface AttentionItem {
  tone?: AttentionTone;
  icon?: IconName;
  /** Section id to navigate to when clicked (passed to `onJump`). */
  tab?: string;
  /** Custom click handler. Takes precedence over `tab`/`onJump`. */
  onClick?: () => void;
  title: React.ReactNode;
  detail?: React.ReactNode;
}

interface AttentionBandProps {
  headline: React.ReactNode;
  items?: AttentionItem[];
  onJump?: (tab: string) => void;
  className?: string;
}

const TONE_RANK: Record<AttentionTone, number> = { ok: 0, info: 1, warn: 2, crit: 3 };

const TONES: Record<AttentionTone, { fg: string; bg: string; bd: string; dot: string; icon: IconName }> = {
  ok:   { fg: '#0F8C5F', bg: 'rgba(16,185,129,0.06)', bd: 'rgba(16,185,129,0.20)', dot: '#10B981', icon: 'check' },
  info: { fg: '#1A47E6', bg: 'rgba(46,92,255,0.05)',  bd: 'rgba(46,92,255,0.18)',  dot: '#2E5CFF', icon: 'circle-dot' },
  warn: { fg: '#A66800', bg: 'rgba(245,158,11,0.06)', bd: 'rgba(245,158,11,0.22)', dot: '#F59E0B', icon: 'alert' },
  crit: { fg: '#B43030', bg: 'rgba(239,68,68,0.06)',  bd: 'rgba(239,68,68,0.22)',  dot: '#EF4444', icon: 'alert' },
};

export function AttentionBand({ headline, items, onJump, className }: AttentionBandProps) {
  const overall = (items ?? []).reduce<AttentionTone>(
    (acc, it) => (TONE_RANK[it.tone ?? 'info'] > TONE_RANK[acc] ? (it.tone ?? 'info') : acc),
    'ok',
  );
  const t = TONES[overall];

  return (
    <div
      className={cn('flex flex-col rounded-xl overflow-hidden', className)}
      style={{ background: t.bg, border: `1px solid ${t.bd}` }}
    >
      {/* Headline */}
      <div className="flex items-center gap-3 px-[18px] py-3.5">
        <span
          aria-hidden
          className="inline-block rounded-full shrink-0"
          style={{
            width: 8,
            height: 8,
            background: t.dot,
            boxShadow: `0 0 0 4px ${t.bd}`,
          }}
        />
        <div className="flex-1 min-w-0 text-[15px] leading-[20px] font-medium text-foreground">
          {headline}
        </div>
      </div>

      {/* Action items */}
      {items && items.length > 0 && (
        <div
          className="flex items-stretch flex-wrap"
          style={{ borderTop: `1px solid ${t.bd}`, background: 'var(--bg-surface)' }}
        >
          {items.map((it, i) => {
            const tone = TONES[it.tone ?? 'info'];
            const clickable = Boolean(it.onClick || (it.tab && onJump));
            return (
              <button
                key={i}
                type="button"
                onClick={() => {
                  if (it.onClick) it.onClick();
                  else if (it.tab && onJump) onJump(it.tab);
                }}
                className={cn(
                  'focus-ring flex items-center gap-2.5 px-4 py-3 border-0 text-left text-foreground',
                  'transition-colors duration-100',
                  clickable && 'hover:bg-[var(--bg-surface-2)] cursor-pointer',
                )}
                style={{
                  flex: '1 1 220px',
                  minWidth: 220,
                  borderLeft: i > 0 ? `1px solid ${t.bd}` : '0',
                  background: 'transparent',
                  cursor: clickable ? 'pointer' : 'default',
                }}
                disabled={!clickable}
              >
                <span
                  aria-hidden
                  className="inline-flex items-center justify-center rounded-md shrink-0"
                  style={{
                    width: 26,
                    height: 26,
                    background: tone.bg,
                    color: tone.fg,
                  }}
                >
                  <WIcon name={it.icon ?? tone.icon} size={13} />
                </span>
                <div className="flex-1 min-w-0 leading-[17px]">
                  <div className="text-[12.5px] font-medium text-foreground truncate">{it.title}</div>
                  {it.detail && (
                    <div className="text-[11.5px] mt-px truncate" style={{ color: tone.fg }}>
                      {it.detail}
                    </div>
                  )}
                </div>
                {clickable && <WIcon name="chevron-right" size={12} color="var(--text-tertiary)" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
