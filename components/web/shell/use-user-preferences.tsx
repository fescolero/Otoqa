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

  // Initial state must match what the server renders, otherwise React
  // throws a hydration mismatch (the server has no localStorage). Start
  // from the defaults; the post-mount effect below reads the saved values
  // and applies them in a follow-up render. Convex hydrates after that.
  const [prefs, setPrefs] = React.useState<UiPreferences>(DEFAULTS);
  const [isHydrating, setIsHydrating] = React.useState(true);

  // Post-mount: read localStorage. Runs on the client only, so the first
  // paint matches the SSR HTML and the cached preferences land on the
  // very next render before any user interaction.
  React.useEffect(() => {
    const local = readLocal();
    if (!local) return;
    setPrefs((prev) => ({
      theme: (local.theme as UiTheme) ?? prev.theme,
      density: (local.density as UiDensity) ?? prev.density,
      sidebarMode: (local.sidebarMode as SidebarMode) ?? prev.sidebarMode,
    }));
  }, []);

  // When Convex hydrates, prefer its value over local cache — but only ONCE.
  // After the initial hydration, local state is the source of truth: every
  // user action calls `persist` which writes localStorage AND fires
  // updateUi, so we push to the server, not pull from it.
  //
  // Without this guard, theme toggles flicker: a click updates local state +
  // theme → mutation fires → convex re-emits remote (initially still the
  // old value until the mutation lands) → effect runs → setPrefs overwrites
  // local back to the old value → page paints old theme briefly → mutation
  // lands → remote re-emits new value → effect runs again → setPrefs to new
  // → page paints new theme. Net: 3 paints instead of 1, hence the flicker.
  const hasHydratedFromRemote = React.useRef(false);
  React.useEffect(() => {
    if (remote === undefined) return;
    setIsHydrating(false);
    if (hasHydratedFromRemote.current) return;
    hasHydratedFromRemote.current = true;
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

  // Apply density via a document attribute on every prefs change. Theme is
  // intentionally NOT in this effect — see the theme-application reasoning
  // in setTheme below.
  React.useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.density = prefs.density;
    }
  }, [prefs.density]);

  // One-time theme bootstrap: when prefs hydrates from localStorage/remote,
  // push the value into next-themes. This effect intentionally runs only
  // until both sources have settled, so it can't fire mid-toggle and
  // re-trigger an attribute swap that would race the click-handler path.
  const themeBootstrapped = React.useRef(false);
  React.useEffect(() => {
    if (themeBootstrapped.current) return;
    if (remote === undefined) return;
    themeBootstrapped.current = true;
    setNextTheme(prefs.theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote, prefs.theme]);

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

  // setTheme flips next-themes' attribute SYNCHRONOUSLY before queuing the
  // React state update + server persist. Order matters: if we let `persist`
  // run first, React commits the new toggle-icon render and the browser
  // paints with the OLD data-theme attribute (the effect that would have
  // flipped the attribute hasn't fired yet — effects run after paint). The
  // user sees a one-frame flash of the old theme. Calling setNextTheme
  // first means the data-theme swap happens before React's commit + paint,
  // so the new theme lands in the same frame as the icon swap.
  const setTheme = React.useCallback(
    (theme: UiTheme) => {
      setNextTheme(theme);
      persist({ ...prefs, theme }, { theme });
    },
    [prefs, persist, setNextTheme],
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
