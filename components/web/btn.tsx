/**
 * WBtn — Otoqa Web button.
 *
 * Sized for dense web tables (xs/sm/md/lg) with five variants:
 *   - primary: brand accent fill
 *   - secondary: surface w/ hairline border (default)
 *   - ghost: transparent, soft hover
 *   - soft: muted surface
 *   - danger: outlined red
 *
 * Use `leading` / `trailing` to attach an icon by name (see icons.ts).
 * Distinct from shadcn's `<Button>` because the design's height/padding/
 * radius scale doesn't fit shadcn's variants — the two coexist.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import { WIcon, type IconName } from './icons';

export type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger';
export type BtnSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE: Record<BtnSize, { h: number; px: number; fs: number; iconSize: number }> = {
  xs: { h: 24, px: 8,  fs: 12,   iconSize: 12 },
  sm: { h: 30, px: 10, fs: 12.5, iconSize: 14 },
  md: { h: 36, px: 14, fs: 13.5, iconSize: 14 },
  lg: { h: 42, px: 18, fs: 14,   iconSize: 16 },
};

const VARIANT: Record<BtnVariant, string> = {
  primary:   'bg-[var(--accent)] text-white border border-[var(--accent)] hover:bg-[var(--accent-hover)] hover:border-[var(--accent-hover)]',
  secondary: 'bg-card text-foreground border border-[var(--border-hairline-strong)] hover:bg-[var(--bg-row-hover)]',
  ghost:     'bg-transparent text-[var(--text-secondary)] border border-transparent hover:bg-[var(--bg-row-hover)] hover:text-foreground',
  soft:      'bg-[var(--bg-surface-2)] text-foreground border border-[var(--border-hairline)] hover:bg-[var(--bg-row-hover)]',
  danger:    'bg-transparent text-[#B43030] border border-[rgba(239,68,68,0.30)] hover:bg-[rgba(239,68,68,0.06)]',
};

interface WBtnProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: BtnVariant;
  size?: BtnSize;
  leading?: IconName;
  trailing?: IconName;
  full?: boolean;
  /** Convenience flag — equivalent to variant="primary". */
  accent?: boolean;
  /** Convenience flag — equivalent to variant="danger". */
  danger?: boolean;
  children?: React.ReactNode;
}

export const WBtn = React.forwardRef<HTMLButtonElement, WBtnProps>(function WBtn(
  { variant = 'secondary', size = 'sm', leading, trailing, full, accent, danger, children, className, style, ...rest },
  ref,
) {
  const v: BtnVariant = danger ? 'danger' : accent ? 'primary' : variant;
  const s = SIZE[size];
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      className={cn(
        'focus-ring inline-flex items-center justify-center gap-1.5 rounded-lg leading-none whitespace-nowrap',
        'font-medium transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] active:translate-y-[0.5px]',
        // Disabled state — native `disabled` already blocks clicks, but
        // visually the button needs to read as inactive. Mute opacity, drop
        // the press-effect, and switch cursor. We deliberately do NOT clobber
        // the variant's hover background — `disabled:hover:bg-inherit` made
        // the primary/accent button turn white on hover-while-loading, which
        // hides the in-progress signal. Opacity-50 alone is enough to read
        // as inactive while preserving the variant's own color.
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0',
        full && 'w-full',
        VARIANT[v],
        className,
      )}
      style={{ height: s.h, padding: `0 ${s.px}px`, fontSize: s.fs, ...style }}
    >
      {leading && <WIcon name={leading} size={s.iconSize} />}
      {children}
      {trailing && <WIcon name={trailing} size={s.iconSize} />}
    </button>
  );
});
