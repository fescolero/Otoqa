/**
 * ThemeContext — driver-app appearance preferences.
 *
 * Two independent knobs, both persisted to AsyncStorage:
 *   - `preference` (theme): 'system' | 'light' | 'dark'
 *   - `density`           : 'comfortable' | 'dense'
 *
 * The theme follows the phone's color scheme by default; density defaults
 * to 'dense' so drivers see more rows without scrolling. Both can be
 * overridden from the App Settings screen.
 *
 * The dashboard reads `density` alongside `palette` so its spacing,
 * button heights, and row paddings swap live when the user flips the
 * setting. Other screens that don't yet observe density will pick it up
 * as they migrate.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { palettes, type Palette } from './design-tokens';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedScheme = 'light' | 'dark';
export type Density = 'comfortable' | 'dense';

const THEME_KEY = 'otoqa.themePreference.v1';
const DENSITY_KEY = 'otoqa.density.v1';
const VALID_THEME: ReadonlyArray<ThemePreference> = ['system', 'light', 'dark'];
const VALID_DENSITY: ReadonlyArray<Density> = ['comfortable', 'dense'];

interface ThemeContextValue {
  /** What the driver picked. `'system'` means follow device. */
  preference: ThemePreference;
  /** The actually-applied scheme after resolving the preference against the OS. */
  scheme: ResolvedScheme;
  /** Resolved palette for the current scheme — pass this to StyleSheets. */
  palette: Palette;
  /** Persist a new theme preference. Changing to `'system'` re-follows the OS. */
  setPreference: (p: ThemePreference) => Promise<void>;
  /** How tightly rows / controls pack. Drivers default to `'dense'`. */
  density: Density;
  /** Persist a new density choice. */
  setDensity: (d: Density) => Promise<void>;
  /** True until AsyncStorage has been read. Use it to gate flash-of-wrong-theme. */
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme: ResolvedScheme = useColorScheme() === 'light' ? 'light' : 'dark';

  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [density, setDensityState] = useState<Density>('dense');
  const [isLoading, setIsLoading] = useState(true);

  // Hydrate both preferences once on mount. Each read is independent so
  // a corrupt value in one doesn't wipe the other.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [themeRaw, densityRaw] = await Promise.all([
          AsyncStorage.getItem(THEME_KEY),
          AsyncStorage.getItem(DENSITY_KEY),
        ]);
        if (!cancelled && themeRaw && VALID_THEME.includes(themeRaw as ThemePreference)) {
          setPreferenceState(themeRaw as ThemePreference);
        }
        if (!cancelled && densityRaw && VALID_DENSITY.includes(densityRaw as Density)) {
          setDensityState(densityRaw as Density);
        }
      } catch (err) {
        console.warn('[ThemeContext] preference read failed:', err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback(async (next: ThemePreference) => {
    setPreferenceState(next);
    try {
      await AsyncStorage.setItem(THEME_KEY, next);
    } catch (err) {
      console.warn('[ThemeContext] theme persist failed:', err);
    }
  }, []);

  const setDensity = useCallback(async (next: Density) => {
    setDensityState(next);
    try {
      await AsyncStorage.setItem(DENSITY_KEY, next);
    } catch (err) {
      console.warn('[ThemeContext] density persist failed:', err);
    }
  }, []);

  const scheme: ResolvedScheme = preference === 'system' ? systemScheme : preference;
  const palette = palettes[scheme];

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, scheme, palette, setPreference, density, setDensity, isLoading }),
    [preference, scheme, palette, setPreference, density, setDensity, isLoading],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
