/**
 * ThemeContext — driver-app palette preference.
 *
 * Default behaviour: follow the phone's system setting (useColorScheme).
 * Override: the driver can force 'light' or 'dark' in Settings. Persists to
 * AsyncStorage so the choice survives restarts.
 *
 * The driver dashboard + Start Shift screens read `palette` from this
 * context instead of hardcoding `palettes.dark`. Other screens continue
 * using the legacy `theme.ts` palette until they're ported — there's no
 * cross-talk between the two systems.
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

const STORAGE_KEY = 'otoqa.themePreference.v1';
const VALID_PREFS: ReadonlyArray<ThemePreference> = ['system', 'light', 'dark'];

interface ThemeContextValue {
  /** What the driver picked. `'system'` means follow device. */
  preference: ThemePreference;
  /** The actually-applied scheme after resolving the preference against the OS. */
  scheme: ResolvedScheme;
  /** Resolved palette for the current scheme — pass this to StyleSheets. */
  palette: Palette;
  /** Persist a new preference. Changing to `'system'` re-follows the OS. */
  setPreference: (p: ThemePreference) => Promise<void>;
  /** True until AsyncStorage has been read. Use it to gate flash-of-wrong-theme. */
  isLoading: boolean;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme: ResolvedScheme = useColorScheme() === 'light' ? 'light' : 'dark';

  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [isLoading, setIsLoading] = useState(true);

  // Hydrate saved preference once on mount. Swallow errors — a corrupt
  // storage value is strictly worse than the default, so fall back to
  // `'system'` rather than blocking app boot.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && stored && VALID_PREFS.includes(stored as ThemePreference)) {
          setPreferenceState(stored as ThemePreference);
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
      await AsyncStorage.setItem(STORAGE_KEY, next);
    } catch (err) {
      // Non-fatal: the in-memory state still updates; persistence just fails.
      console.warn('[ThemeContext] preference persist failed:', err);
    }
  }, []);

  const scheme: ResolvedScheme = preference === 'system' ? systemScheme : preference;
  const palette = palettes[scheme];

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, scheme, palette, setPreference, isLoading }),
    [preference, scheme, palette, setPreference, isLoading],
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
