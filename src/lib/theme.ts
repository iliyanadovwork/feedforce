'use client';

import { useSyncExternalStore } from 'react';

// App theme picker. The source of truth at runtime is `data-theme` on <html> (set before first
// paint by the no-flash script in layout.tsx, and updated here on pick); localStorage persists
// the choice across visits. Default / no or unknown stored value = 'dark' — the app's original
// single theme, so existing users see no change. "light" is the neutral zinc-on-white light;
// "light-hard" is "Warm Light" — the warm Gruvbox-hard palette (from the VSCode Vim Light Hard theme). The
// marketing landing themes itself separately (.ff-landing).
//
// KEEP IN SYNC: the allowed-values list also lives in layout.tsx's no-flash script.

export type Theme = 'dark' | 'dark-hard' | 'light' | 'light-hard';

// Order = the order the sidebar picker lists them (grouped by luminance: darks then lights).
// `swatch` is each theme's page background, shown as the little disc in the picker menu.
export const THEMES: ReadonlyArray<{ value: Theme; label: string; swatch: string }> = [
  { value: 'dark', label: 'Dark', swatch: '#0a0a0a' },
  { value: 'dark-hard', label: 'Warm Dark', swatch: '#1d2021' },
  { value: 'light', label: 'Light', swatch: '#ffffff' },
  { value: 'light-hard', label: 'Warm Light', swatch: '#f9f5d7' },
];

const VALID = new Set<string>(THEMES.map(t => t.value));
const STORAGE_KEY = 'ff-theme';
const coerce = (v: string | null | undefined): Theme => {
  if (v && VALID.has(v)) return v as Theme;
  // Retired variants ('light-soft'/'light-medium') collapse to the surviving warm theme rather
  // than dumping a light-mode user back into dark.
  if (v && v.startsWith('light-')) return 'light-hard';
  return 'dark';
};

const listeners = new Set<() => void>();

export function getTheme(): Theme {
  if (typeof document === 'undefined') return 'dark';
  return coerce(document.documentElement.dataset.theme);
}

export function setTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* private mode — runtime attr still applies */ }
  listeners.forEach(l => l());
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => { listeners.delete(onChange); };
}

// Cross-tab sync: a pick in another tab writes localStorage; mirror it into this tab's <html>
// and notify subscribers so useTheme consumers re-render. Module scope (guarded for SSR imports)
// so it's wired once, not per component.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== STORAGE_KEY || e.newValue === null) return;
    document.documentElement.dataset.theme = coerce(e.newValue);
    listeners.forEach(l => l());
  });
}

// Server + hydration snapshot is 'dark' so it matches the un-attributed server HTML; the client
// re-reads the real <html> value right after mount (useSyncExternalStore handles the swap without a
// hydration mismatch).
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => 'dark');
}
