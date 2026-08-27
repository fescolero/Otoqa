/**
 * Theme-reactive access to the v8 tokens — the migration target for screens
 * that have moved their styles inside their components.
 *
 * Lives apart from `theme.ts` so that module stays free of `react-native`
 * and the token mapping can be unit-tested in the node vitest project.
 *
 * Read `theme.ts`'s header before adopting this: most screens still declare
 * styles at module scope and use the static `colors` export, which is always
 * dark. Converting one screen in isolation gives you an app that renders
 * light in one place and dark everywhere else. Convert the set, or none.
 *
 * Usage — destructuring shadows the static imports with the same shape, so a
 * converted screen keeps every call site byte-identical:
 *
 *   const { colors, typography, borderRadius } = useThemeTokens();
 */
import { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import {
  borderRadius,
  darkColors,
  lightColors,
  typography,
  type DispatchColors,
  type Scheme,
} from './theme';

export interface ThemeTokens {
  colors: DispatchColors;
  typography: typeof typography;
  borderRadius: typeof borderRadius;
  scheme: Scheme;
}

export function useThemeTokens(): ThemeTokens {
  const scheme: Scheme = useColorScheme() === 'light' ? 'light' : 'dark';
  return useMemo(
    () => ({
      colors: scheme === 'light' ? lightColors : darkColors,
      typography,
      borderRadius,
      scheme,
    }),
    [scheme],
  );
}
