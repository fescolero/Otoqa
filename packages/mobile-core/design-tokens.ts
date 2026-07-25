/**
 * Otoqa Driver design tokens — ports the CSS custom properties from the
 * HTML design bundle (styles/tokens.css) into a plain JS object so RN
 * screens can reach for `tokens.bgCanvas`, `tokens.textPrimary`, etc. in
 * StyleSheets.
 *
 * Separate from the existing `mobile/lib/theme.ts` (dark-orange theme) so
 * screens can migrate to the design incrementally — theme.ts stays intact
 * for non-driver surfaces until they're ported.
 *
 * Both `light` and `dark` palettes are exported. The app currently follows
 * the device color scheme; pick the matching palette in a screen via
 * `useColorScheme()`.
 */

// ============================================================================
// PRIMITIVES — raw hex, no semantics
// ============================================================================

const primitives = {
  blue50: '#EEF2FF',
  blue100: '#DEE5FF',
  blue200: '#BFCCFF',
  blue300: '#8BA3FF',
  blue400: '#5C82FF',
  blue500: '#2E5CFF',
  blue600: '#1A47E6',
  blue700: '#1539BF',

  n0: '#FFFFFF',
  n50: '#F7F8FC',
  n100: '#EEF0F5',
  n200: '#DFE3EB',
  n300: '#C8CED9',
  n400: '#9BA3B4',
  n500: '#6B7385',
  n600: '#4B5260',
  n700: '#363B48',
  n800: '#242934',
  n900: '#171A22',
  n950: '#0E1017',

  success300: '#6EE7B7',
  success400: '#34D399',
  success500: '#10B981',
  success600: '#059669',
  success700: '#047857',

  warning300: '#FCD34D',
  warning400: '#FBBF24',
  warning500: '#F59E0B',
  warning700: '#B45309',

  danger300: '#FCA5A5',
  danger400: '#F87171',
  danger500: '#EF4444',
  danger700: '#B91C1C',
};

export const accentBlue = primitives.blue500;

// ============================================================================
// SEMANTIC — light + dark palettes
// ============================================================================

const light = {
  // Backgrounds
  bgCanvas: primitives.n0,
  bgSurface: primitives.n0,
  bgSurfaceElevated: primitives.n0,
  bgMuted: primitives.n50,
  bgSubtle: primitives.n100,
  bgInverse: primitives.n900,
  bgOverlay: 'rgba(23, 26, 34, 0.5)',

  // Text
  textPrimary: primitives.n900,
  textSecondary: primitives.n600,
  textTertiary: primitives.n500,
  textDisabled: primitives.n400,
  textPlaceholder: primitives.n400,
  textOnAction: '#FFFFFF',
  textLink: primitives.blue600,

  // Borders
  borderSubtle: primitives.n200,
  borderDefault: primitives.n300,
  borderStrong: primitives.n400,
  borderFocus: primitives.blue500,

  // Accent
  accent: primitives.blue500,
  accentHover: primitives.blue600,
  accentPressed: primitives.blue700,
  accentTint: primitives.blue50,
  accentTintStrong: primitives.blue100,

  // Status (same hex light/dark — callers use `semantic` palettes rarely)
  success: primitives.success500,
  warning: primitives.warning500,
  danger: primitives.danger500,
};

const dark = {
  bgCanvas: primitives.n950,
  bgSurface: primitives.n900,
  bgSurfaceElevated: '#1F232D',
  bgMuted: primitives.n800,
  bgSubtle: '#2E3340',
  bgInverse: primitives.n50,
  bgOverlay: 'rgba(0, 0, 0, 0.6)',

  textPrimary: '#E8EBF2',
  textSecondary: '#B0B6C3',
  textTertiary: '#858B99',
  textDisabled: '#4E5463',
  textPlaceholder: '#4E5463',
  textOnAction: '#FFFFFF',
  textLink: primitives.blue300,

  borderSubtle: '#2E3340',
  borderDefault: '#3B414F',
  borderStrong: '#4E5463',
  borderFocus: primitives.blue400,

  accent: primitives.blue500,
  accentHover: primitives.blue400,
  accentPressed: primitives.blue300,
  accentTint: 'rgba(46, 92, 255, 0.12)',
  accentTintStrong: 'rgba(46, 92, 255, 0.20)',

  success: primitives.success500,
  warning: primitives.warning500,
  danger: primitives.danger500,
};

export type Palette = typeof light;

export const palettes = { light, dark };

// ============================================================================
// TYPOGRAPHY — comfortable + dense scales
// ============================================================================

/**
 * Comfortable density — generous spacing, readable from arm's length.
 * Used on tablets or when the user hasn't opted into the dense mode.
 */
const typographyComfortable = {
  headingSm: { fontSize: 18, lineHeight: 26, fontWeight: '600' as const },
  bodyMd: { fontSize: 15, lineHeight: 22, fontWeight: '400' as const },
  bodySm: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const },
  labelSm: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const },
};

/**
 * Dense density — 1 step smaller so more rows fit; still 44pt hit targets.
 */
const typographyDense = {
  headingSm: { fontSize: 16, lineHeight: 22, fontWeight: '600' as const },
  bodyMd: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  bodySm: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const },
  labelSm: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const },
  micro: { fontSize: 10, lineHeight: 13, fontWeight: '500' as const },
};

export const typographyScales = {
  comfortable: typographyComfortable,
  dense: typographyDense,
};

// Invariant type scales (match the HTML t-* helpers)
export const typeScale = {
  displayMd: { fontSize: 32, lineHeight: 40, fontWeight: '700' as const, letterSpacing: -0.48 },
  displaySm: { fontSize: 28, lineHeight: 36, fontWeight: '700' as const, letterSpacing: -0.28 },
  headingLg: { fontSize: 24, lineHeight: 32, fontWeight: '700' as const, letterSpacing: -0.24 },
  headingMd: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const, letterSpacing: -0.1 },
  headingSm: { fontSize: 18, lineHeight: 26, fontWeight: '600' as const },
  bodyLg: { fontSize: 17, lineHeight: 24, fontWeight: '400' as const },
  bodyMd: { fontSize: 15, lineHeight: 22, fontWeight: '400' as const },
  bodySm: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  labelLg: { fontSize: 15, lineHeight: 20, fontWeight: '500' as const },
  labelMd: { fontSize: 13, lineHeight: 18, fontWeight: '500' as const, letterSpacing: 0.13 },
  labelSm: { fontSize: 12, lineHeight: 16, fontWeight: '500' as const, letterSpacing: 0.24 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const, letterSpacing: 0.12 },
  micro: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const, letterSpacing: 0.33 },
};

// ============================================================================
// SPACING (invariant) + DENSITY-AWARE SPACING
// ============================================================================

export const spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 16,
  s5: 20,
  s6: 24,
  s8: 32,
  s10: 40,
  s12: 48,
  s16: 64,
};

// Comfortable is the roomier, less-cluttered variant — larger screen
// margins, deeper card padding, wider row breathing room. Dense is the
// in-vehicle default — tighter gaps, smaller paddings, more rows
// visible before scrolling. Deltas are 4-12px on every token so a
// flip is obviously visible, not subliminal.
export const spacingComfortable = {
  screenPx: 20,
  screenPy: 24,
  sectionGap: 24,
  rowGap: 10,
  rowPy: 16,
  headerPy: 14,
  tabPy: 12,
  cardPadding: 20,
  cardGap: 18,
  listPy: 14,
  listPx: 18,
  listGap: 12,
};

export const spacingDense = {
  screenPx: 10,
  screenPy: 10,
  sectionGap: 10,
  rowGap: 4,
  rowPy: 8,
  headerPy: 6,
  tabPy: 4,
  cardPadding: 10,
  cardGap: 8,
  listPy: 8,
  listPx: 10,
  listGap: 4,
};

export const densitySpacing = {
  comfortable: spacingComfortable,
  dense: spacingDense,
};

// ============================================================================
// RADII
// ============================================================================

export const radii = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
  full: 9999,
};

// ============================================================================
// COMPONENT TOKENS (density-aware)
// ============================================================================

export const componentsComfortable = {
  btnMd: { height: 48, paddingHorizontal: 20, radius: 12 },
  btnLg: { height: 60, radius: 14 },
  inputMd: { height: 52, paddingHorizontal: 16, radius: 12 },
  navBotHeight: 68,
  navTopHeight: 60,
};

export const componentsDense = {
  btnMd: { height: 36, paddingHorizontal: 12, radius: 10 },
  btnLg: { height: 44, radius: 12 },
  inputMd: { height: 40, paddingHorizontal: 12, radius: 10 },
  navBotHeight: 56,
  navTopHeight: 48,
};

export const densityComponents = {
  comfortable: componentsComfortable,
  dense: componentsDense,
};

// ============================================================================
// TAG COLORS (per design's TAG_STYLES in dashboard-screen.jsx)
// ============================================================================

export const tagStyles: Record<
  string,
  { bg: string; fg: string } | undefined
> = {
  '917DK': { bg: 'rgba(46,92,255,0.16)', fg: primitives.blue400 },
  '801': { bg: 'rgba(124,58,237,0.14)', fg: '#A78BFA' },
  REEF: { bg: 'rgba(6,182,212,0.14)', fg: '#22D3EE' },
  HAZ: { bg: 'rgba(234,88,12,0.16)', fg: '#FB923C' },
  LTL: { bg: 'rgba(255,255,255,0.06)', fg: primitives.n400 },
  OVR: { bg: 'rgba(16,185,129,0.14)', fg: '#34D399' },
};

export const tagFallback = { bg: 'rgba(255,255,255,0.06)', fg: primitives.n400 };

// ============================================================================
// EASING
// ============================================================================

// The HTML design uses `cubic-bezier(0.2, 0, 0, 1)` — RN doesn't map directly
// but Animated/Reanimated can accept the same curve via Easing.bezier(0.2, 0, 0, 1).
export const motionEasingBezier = [0.2, 0, 0, 1] as const;
