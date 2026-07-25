/**
 * useDensityTokens — one call to grab every density-aware token set
 * for the current App Settings choice. Screens call this instead of
 * reaching for `densitySpacing['dense']` at module scope so a flip in
 * App Settings → Appearance → Density rerenders the whole app live.
 */
import { useTheme } from './ThemeContext';
import {
  densityComponents,
  densitySpacing,
  typographyScales,
} from './design-tokens';

export function useDensityTokens() {
  const { density } = useTheme();
  return {
    density,
    sp: densitySpacing[density],
    comp: densityComponents[density],
    type: typographyScales[density],
  };
}
