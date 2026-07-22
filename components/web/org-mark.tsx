/**
 * OrgMark — the organization's visual mark, shared by every surface that
 * shows one (sidebar header, Settings → General logo slot and workspace
 * rail). Renders the uploaded logo when the org has one, otherwise an
 * accent-filled monogram built from the name. One component so the mark
 * can never diverge between surfaces.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import type { LogoTraits } from '@/lib/logo-analysis';

/** First letters of the first two words, uppercased — "Central Valley
 *  Freight LLC" → "CV". */
export function orgMonogram(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase() || '?'
  );
}

interface OrgMarkProps {
  name: string;
  logoUrl?: string | null;
  /** Upload-time analysis (organizations.logoTraits) — a transparent
   *  monochrome logo gets a tile background of the opposite tone so it
   *  stays visible in both themes; colorful or self-backgrounded logos
   *  keep the neutral tile. */
  logoTraits?: Pick<LogoTraits, 'tone' | 'hasAlpha'> | null;
  /** Tile edge in px — radius and type scale with it. Default 28. */
  size?: number;
  className?: string;
}

export function OrgMark({ name, logoUrl, logoTraits, size = 28, className }: OrgMarkProps) {
  const radius = Math.round(size * 0.22);

  if (logoUrl) {
    const forcedBg =
      logoTraits?.hasAlpha && logoTraits.tone === 'dark'
        ? '#FFFFFF'
        : logoTraits?.hasAlpha && logoTraits.tone === 'light'
          ? '#0F172A'
          : null;
    return (
      <span
        className={cn('inline-flex items-center justify-center overflow-hidden shrink-0', className)}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: forcedBg ?? 'var(--bg-surface-2)',
          border: '1px solid var(--border-hairline)',
          // A forced background reads as a plate — give the mark breathing
          // room so it doesn't touch the plate's edges.
          padding: forcedBg ? Math.max(2, Math.round(size * 0.09)) : 0,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt={`${name} logo`} className="h-full w-full object-contain" />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex items-center justify-center shrink-0 select-none text-white font-bold',
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: 'var(--accent)',
        fontSize: Math.max(10, Math.round(size * 0.36)),
        letterSpacing: '-0.02em',
      }}
    >
      {orgMonogram(name)}
    </span>
  );
}
