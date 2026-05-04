/**
 * useUserPreferences — provider + hook for UI shell preferences.
 *
 * Source of truth is the `userPreferences` Convex table (per user + org).
 * `localStorage` mirrors the last known values so the very first paint
 * doesn't flash to defaults while Convex hydrates.
 *
 * Used by:
 *   - Topbar density / theme toggle (writes back via updateUiPreferences)
 *   - Sidebar pin / rail / hover toggle
 *   - The Otoqa Web shell's <html data-theme data-density> sync effect
 *
 * The provider must sit inside <OrganizationProvider> and the Convex
 * client provider — i.e. inside `(app)/layout.tsx`, not in the root.
 */

'use client';

import * as React from 'react';
import { useMutation, useQuery } from 'convex/react';
import { useTheme } from 'next-themes';
import { api } from '@/convex/_generated/api';
import { useOrganizationId } from '@/contexts/organization-context';

export type UiTheme = 'light' | 'dark' | 'system';
export type UiDensity = 'compact' | 'comfortable';
export type SidebarMode = 'hover' | 'pinned' | 'rail';

export interface UiPreferences {
  theme: UiTheme;
  density: UiDensity;
  sidebarMode: SidebarMode;
}

const DEFAULTS: UiPreferences = {
  theme: 'light',
  density: 'compact',
  sidebarMode: 'pinned',
};

const STORAGE_KEY = 'otoqa.ui-prefs.v1';

interface Ctx extends UiPreferences {
  setTheme: (t: UiTheme) => void;
  setDensity: (d: UiDensity) => void;
  setSidebarMode: (m: SidebarMode) => void;
  /** True until the first Convex query result is in. */
  isHydrating: boolean;
}

const PrefsContext = React.createContext<Ctx | null>(null);

function readLocal(): Partial<UiPreferences> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<UiPreferences>;
    return parsed;
  } catch {
    return null;
  }
}

function writeLocal(prefs: UiPreferences) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* no-op (Safari private mode etc.) */
  }
}

export function UiPreferencesProvider({ children }: { children: React.ReactNode }) {
  const workosOrgId = useOrganizationId();
  const remote = useQuery(api.settings.getUserPreferences, { workosOrgId });
  const updateUi = useMutation(api.settings.updateUiPreferences);
  const { setTheme: setNextTheme } = useTheme();

  // Initial state: localStorage > defaults. Convex result overrides once it
  // arrives.
  const initial = React.useMemo<UiPreferences>(() => {
    const local = readLocal();
    return {
      theme: (local?.theme as UiTheme) ?? DEFAULTS.theme,
      density: (local?.density as UiDensity) ?? DEFAULTS.density,
      sidebarMode: (local?.sidebarMode as SidebarMode) ?? DEFAULTS.sidebarMode,
    };
  }, []);

  const [prefs, setPrefs] = React.useState<UiPreferences>(initial);
  const [isHydrating, setIsHydrating] = React.useState(true);

  // When Convex hydrates, prefer its value over local cache.
  React.useEffect(() => {
    if (remote === undefined) return;
    setIsHydrating(false);
    if (remote === null) return;
    const next: UiPreferences = {
      theme: (remote.theme as UiTheme) ?? prefs.theme,
      density: (remote.density as UiDensity | undefined) ?? prefs.density,
      sidebarMode: (remote.sidebarMode as SidebarMode | undefined) ?? prefs.sidebarMode,
    };
    setPrefs(next);
    writeLocal(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);

  // Apply theme via next-themes; apply density via document attribute.
  React.useEffect(() => {
    setNextTheme(prefs.theme);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.density = prefs.density;
    }
  }, [prefs.theme, prefs.density, setNextTheme]);

  const persist = React.useCallback(
    (next: UiPreferences, partial: Partial<UiPreferences>) => {
      setPrefs(next);
      writeLocal(next);
      updateUi({ workosOrgId, ...partial }).catch((err) => {
        // Roll back local state if the server write fails so the UI doesn't
        // diverge silently. Toast / log handled by the consuming surface.
        console.error('[useUserPreferences] failed to persist UI prefs', err);
      });
    },
    [workosOrgId, updateUi],
  );

  const setTheme = React.useCallback(
    (theme: UiTheme) => persist({ ...prefs, theme }, { theme }),
    [prefs, persist],
  );
  const setDensity = React.useCallback(
    (density: UiDensity) => persist({ ...prefs, density }, { density }),
    [prefs, persist],
  );
  const setSidebarMode = React.useCallback(
    (sidebarMode: SidebarMode) => persist({ ...prefs, sidebarMode }, { sidebarMode }),
    [prefs, persist],
  );

  const value = React.useMemo<Ctx>(
    () => ({ ...prefs, setTheme, setDensity, setSidebarMode, isHydrating }),
    [prefs, setTheme, setDensity, setSidebarMode, isHydrating],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function useUserPreferences(): Ctx {
  const ctx = React.useContext(PrefsContext);
  if (!ctx) {
    throw new Error('useUserPreferences must be used within UiPreferencesProvider');
  }
  return ctx;
}
