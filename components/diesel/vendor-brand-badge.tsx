/**
 * VendorBrandBadge — colored rounded square with the vendor's 2-3 letter
 * initials. Used in the vendors list, the saved-views, the detail hero,
 * and any cross-reference (e.g. fuel-entry detail showing the vendor).
 *
 * The brand color is derived deterministically from the vendor name when
 * not explicitly supplied — same name → same color across the app. This
 * lets vendors visually carry their own identity without needing a brand
 * color column on the schema yet.
 */

'use client';

import * as React from 'react';

const BRAND_PALETTE = [
  '#C0432B', '#B23838', '#2F7D55', '#2E5CFF', '#8A5A1E',
  '#C98A1E', '#5A6172', '#7C3AED', '#0F8C5F', '#1F6FEB',
];

/**
 * Stable hash → palette index. Different strings can collide on color
 * (that's fine — the initials disambiguate); identical strings always map
 * to the same color.
 */
function brandColorFor(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) {
    h = ((h * 33) ^ seed.charCodeAt(i)) >>> 0;
  }
  return BRAND_PALETTE[h % BRAND_PALETTE.length];
}

/**
 * Pick 2 initials from the vendor name. Multi-word → first letter of the
 * first two words ("Pilot Flying J" → "PF"). Single word → first 2 chars.
 */
function brandInitials(name: string, code?: string | null): string {
  if (code && code.trim().length > 0) return code.trim().slice(0, 3).toUpperCase();
  const cleaned = name.trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

interface VendorBrandBadgeProps {
  name: string;
  code?: string | null;
  /** Manually override the color (per-vendor brand colors land later). */
  color?: string;
  size?: number;
  /** Border-radius override; defaults to ~26% of the box. */
  radius?: number;
  className?: string;
}

export function VendorBrandBadge({
  name,
  code,
  color,
  size = 28,
  radius,
  className,
}: VendorBrandBadgeProps) {
  const bg = color ?? brandColorFor(name);
  const initials = brandInitials(name, code);
  const r = radius ?? Math.round(size * 0.26);
  const fontSize = size <= 30 ? 9.5 : Math.round(size * 0.32);
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: r,
        background: bg,
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize,
        fontWeight: 700,
        letterSpacing: 0.04,
        flexShrink: 0,
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14)',
      }}
    >
      {initials}
    </div>
  );
}

export { brandColorFor, brandInitials };
