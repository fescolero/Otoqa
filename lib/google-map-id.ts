/**
 * Themed Google Maps configuration.
 *
 * Otoqa uses a **single** Cloud-styled Map ID configured in the Google
 * Cloud Console to support both light and dark color schemes. The map
 * surface switches palette at runtime via the `colorScheme` prop on
 * `<Map>` (LIGHT | DARK | FOLLOW_SYSTEM) — no remount needed.
 *
 * Why single-ID + colorScheme instead of two separate Map IDs:
 *   • Tile cache is shared between modes — toggling theme doesn't burn
 *     a fresh tile fetch for every visible region.
 *   • The map instance stays mounted across theme toggles, so polylines,
 *     markers, and pan/zoom state aren't reset.
 *   • One Cloud-styled Map ID to maintain instead of two diverging
 *     definitions.
 *
 * Usage:
 *
 *   const mapId = useThemedMapId();
 *   const colorScheme = useMapColorScheme();
 *   return <Map mapId={mapId} colorScheme={colorScheme} ... />
 */

'use client';

import { useTheme } from 'next-themes';

/**
 * The single Cloud-styled Map ID for the Otoqa app. Configured in the
 * Google Cloud Console with both light and dark color schemes attached
 * to the same Map Style. Override per-deploy via env if a staging GCP
 * project has a different ID.
 */
export const OTOQA_MAP_ID =
  process.env.NEXT_PUBLIC_GOOGLE_MAP_ID || '4ebb23f894537989968955a1';

export type MapColorScheme = 'LIGHT' | 'DARK' | 'FOLLOW_SYSTEM';

/**
 * Returns the Otoqa Map ID. Kept as a hook (not a constant) so future
 * per-page/per-org overrides can plug in without touching callsites.
 */
export function useThemedMapId(): string {
  return OTOQA_MAP_ID;
}

/**
 * Returns the color scheme that `<Map>` should render in, matched to
 * the app's `next-themes` state. SSR / pre-hydration falls back to
 * LIGHT so the initial paint matches the default app chrome.
 *
 * The map remains mounted across theme toggles — Google handles the
 * palette swap internally.
 */
export function useMapColorScheme(): MapColorScheme {
  const { resolvedTheme } = useTheme();
  return resolvedTheme === 'dark' ? 'DARK' : 'LIGHT';
}
