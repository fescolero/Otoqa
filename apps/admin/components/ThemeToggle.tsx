'use client';

import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';

export const THEME_KEY = 'otoqa-console-theme';
type Theme = 'system' | 'light' | 'dark';

const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = {
  system: 'Theme: following the system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/**
 * Three states, not two. "System" is a real answer — an operator whose machine
 * flips at sunset wants the console to flip with it — and a two-way toggle
 * silently destroys it the first time anyone touches the control.
 *
 * The chosen value is written to <html data-theme>, which the stylesheet reads.
 * `system` removes the attribute entirely so the prefers-color-scheme block
 * takes over. The pre-paint script in app/layout.tsx applies the stored value
 * before first paint, so there is no flash of the wrong theme.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark') setTheme(stored);
  }, []);

  function cycle() {
    const next = NEXT[theme];
    setTheme(next);
    try {
      if (next === 'system') {
        localStorage.removeItem(THEME_KEY);
        document.documentElement.removeAttribute('data-theme');
      } else {
        localStorage.setItem(THEME_KEY, next);
        document.documentElement.setAttribute('data-theme', next);
      }
    } catch {
      // Private mode or a blocked store: the attribute still applied above, so
      // the choice holds for this tab and simply doesn't survive a reload.
    }
  }

  // Until mounted, the server and client disagree about the stored value.
  // Render the neutral icon rather than guessing and hydrating wrong.
  const Icon = !mounted || theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;

  return (
    <button
      type="button"
      className="icon-button"
      onClick={cycle}
      aria-label={LABEL[theme]}
      title={`${LABEL[theme]} — click for ${NEXT[theme]}`}
    >
      <Icon strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}
