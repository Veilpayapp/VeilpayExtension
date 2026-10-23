import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'ui:theme';
export const LOCAL_STORAGE_KEY = 'veilpay_theme';

/**
 * Reads the synchronous fallback theme (localStorage or default 'dark').
 */
export function getInitialTheme(): Theme {
  try {
    const local = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (local === 'light' || local === 'dark') return local;
  } catch {
    // Ignore in environments where localStorage is unavailable
  }
  return 'dark';
}

/**
 * Applies the theme attributes and classes to the DOM document root.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    root.classList.add('dark');
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }
}

// Initial bootstrap before React mounts to avoid flashing
if (typeof document !== 'undefined') {
  applyTheme(getInitialTheme());
}

/**
 * Hook to manage wallet UI theme (light / dark).
 * Synchronizes with chrome.storage.local across popup, side panel, and options.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    applyTheme(theme);

    // Read stored preference from chrome.storage.local
    if (globalThis.chrome?.storage?.local) {
      chrome.storage.local
        .get(THEME_STORAGE_KEY)
        .then((result) => {
          const stored = result[THEME_STORAGE_KEY] as Theme | undefined;
          if (stored === 'light' || stored === 'dark') {
            setThemeState(stored);
            applyTheme(stored);
          }
        })
        .catch(() => undefined);
    }

    // Sync across popup, options page, and sidepanel windows
    const handleStorageChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName === 'local' && changes[THEME_STORAGE_KEY]) {
        const nextTheme = changes[THEME_STORAGE_KEY].newValue as Theme | undefined;
        if (nextTheme === 'light' || nextTheme === 'dark') {
          setThemeState(nextTheme);
          applyTheme(nextTheme);
        }
      }
    };

    if (globalThis.chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener(handleStorageChange);
      return () => {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      };
    }
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
    applyTheme(newTheme);
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, newTheme);
    } catch {
      // Ignore
    }
    if (globalThis.chrome?.storage?.local) {
      void chrome.storage.local.set({ [THEME_STORAGE_KEY]: newTheme });
    }
  };

  const toggleTheme = () => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  return {
    theme,
    isDark: theme === 'dark',
    isLight: theme === 'light',
    setTheme,
    toggleTheme,
  };
}
