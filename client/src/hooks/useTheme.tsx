import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const KEY = 'afx-theme';
const read = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
};
const systemTheme = (): Resolved => (typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

const Ctx = createContext<{ pref: ThemePref; theme: Resolved; setPref(p: ThemePref): void; toggle(): void }>({ pref: 'system', theme: 'dark', setPref: () => undefined, toggle: () => undefined });

/** Light / dark / system theme. The choice is a per-browser convenience stored in localStorage. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(read);
  const [sys, setSys] = useState<Resolved>(systemTheme);
  const theme: Resolved = pref === 'system' ? sys : pref;

  useEffect(() => {
    if (typeof matchMedia === 'undefined') return;
    const mq = matchMedia('(prefers-color-scheme: light)');
    const on = () => setSys(mq.matches ? 'light' : 'dark');
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);

  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('light', theme === 'light');
    el.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    try {
      localStorage.setItem(KEY, p);
    } catch {
      /* storage unavailable - theme still applies for this session */
    }
  }, []);
  const toggle = useCallback(() => setPref(theme === 'dark' ? 'light' : 'dark'), [theme, setPref]);
  return <Ctx.Provider value={{ pref, theme, setPref, toggle }}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

/** Resolve a palette CSS variable (for canvas charts that cannot use classes). */
export function cssVar(name: string, fallback: string) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
