/**
 * @otoqa/mobile-core — shared mobile design system.
 *
 * theme.ts is the classic driver theme (colors/typography/spacing/…);
 * design-tokens.ts is the v4 density-aware token set. Both export a
 * `spacing`, so design-tokens' is re-exported as `tokenSpacing` — import
 * the rest of the token set by name.
 */
export * from './theme';
export {
  accentBlue,
  palettes,
  typographyScales,
  typeScale,
  spacing as tokenSpacing,
  spacingComfortable,
  spacingDense,
  densitySpacing,
  radii,
  componentsComfortable,
  componentsDense,
  densityComponents,
  tagStyles,
  tagFallback,
  motionEasingBezier,
} from './design-tokens';
export type { Palette } from './design-tokens';
