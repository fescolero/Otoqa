/**
 * Dispatch theme — the v8 (Otoqa_Mobile8) design system, served under the
 * token names the screens already use.
 *
 * The app was built against `@otoqa/mobile-core`'s `theme.ts`: the legacy
 * "Dark Logistics" palette, dark-only, orange accent. The approved design —
 * and the driver app, which adopted it — is the blue/neutral token set in
 * `design-tokens.ts` (a faithful port of the bundle's `styles/tokens.css`).
 * Dispatch shipping the old theme is why the two apps look like different
 * products.
 *
 * This module closes that gap without restructuring 19 screens: it keeps the
 * legacy *names* (`colors.foreground`, `typography.sm`, `borderRadius.md`)
 * and re-sources every *value* from the v8 palette. Each screen changes by
 * exactly one line — its import — so the diff stays reviewable and the risk
 * stays near zero.
 *
 * ## Why the static export is the sanctioned path (for now)
 *
 * Most screens declare their styles at module scope (`const s = {...}`), and
 * several helper components are arrows that return JSX directly. Neither can
 * call a hook, so a theme-*reactive* migration means hoisting those styles
 * into component bodies first — a genuine refactor, file by file.
 *
 * `useThemeTokens()` (lib/useThemeTokens.ts) is that migration's target: it
 * returns the same
 * shape, resolved live against `useColorScheme()`, which is what
 * `userInterfaceStyle: "automatic"` in app.json has always promised and the
 * dark-only legacy theme could never deliver. Adopt it per screen *after*
 * that screen's styles move inside its component. Until every screen is
 * converted, prefer the static export everywhere — a half-converted app
 * renders light and dark side by side.
 *
 * Two things this pass deliberately does NOT do, both left to visual review:
 *   - `foregroundMuted` covers both the design's `text-secondary` and
 *     `text-tertiary` roles. It maps to secondary (the legible default);
 *     captions and section headers that should be tertiary can reach for
 *     `foregroundSubtle`.
 *   - The v8 ramp pairs each size with a line-height and letter-spacing.
 *     `typography.*` is consumed as a bare `fontSize` number, so only the
 *     sizes transfer here.
 */
// Imported from the pure token file rather than the package barrel: the barrel
// re-exports the legacy `theme.ts`, which pulls in react-native and would drag
// Flow syntax into the node test environment.
import { palettes, radii, type Palette } from '@otoqa/mobile-core/design-tokens';

export type Scheme = 'light' | 'dark';

/** Legacy color names → v8 semantic roles. */
function mapColors(p: Palette) {
  return {
    // Surfaces
    background: p.bgCanvas,
    card: p.bgSurface,
    cardElevated: p.bgSurfaceElevated,
    muted: p.bgMuted,
    subtle: p.bgSubtle,
    overlay: p.bgOverlay,

    // Text
    foreground: p.textPrimary,
    foregroundMuted: p.textSecondary,
    foregroundSubtle: p.textTertiary,
    foregroundDisabled: p.textDisabled,

    // Accent — the headline change: orange #FF6B00 → v8 blue #2E5CFF.
    primary: p.accent,
    primaryLight: p.accentHover,
    primaryDark: p.accentPressed,
    primaryForeground: p.textOnAction,
    accentTint: p.accentTint,

    // Borders
    border: p.borderDefault,
    borderSubtle: p.borderSubtle,
    borderStrong: p.borderStrong,

    // Status
    success: p.success,
    warning: p.warning,
    error: p.danger,
    destructive: p.danger,
  } as const;
}

/**
 * Legacy size ramp snapped onto the v8 scale. `xs` moves 10→11 and `md`
 * 16→15; the rest already matched. Weights are unchanged — the legacy set
 * and the v8 scale agree on 400/500/600/700.
 */
export const typography = {
  fontSans: 'System',
  fontMono: 'Courier',

  xs: 11, // v8 micro
  sm: 12, // v8 labelSm / caption
  base: 14, // v8 bodySm
  md: 15, // v8 bodyMd / labelLg
  lg: 18, // v8 headingSm
  xl: 20, // v8 headingMd
  '2xl': 24, // v8 headingLg
  '3xl': 28, // v8 displaySm

  normal: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
};

/** v8 radii. Identical values to the legacy set for every key dispatch uses. */
export const borderRadius = radii;

/** Resolved palettes. `useThemeTokens()` picks between them per color scheme. */
export const lightColors = mapColors(palettes.light);
export const darkColors = mapColors(palettes.dark);

export type DispatchColors = ReturnType<typeof mapColors>;

/**
 * The drop-in replacement for `@otoqa/mobile-core`'s `colors`. Dark palette —
 * matching what the app renders today, but in v8 blue/neutral rather than the
 * legacy orange. Safe at module scope.
 */
export const colors: DispatchColors = darkColors;
