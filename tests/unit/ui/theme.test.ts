import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useTheme,
  applyTheme,
  getInitialTheme,
  LOCAL_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from '@/ui/theme/useTheme';

describe('useTheme and theme utilities', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.className = '';
    vi.clearAllMocks();
  });

  it('getInitialTheme defaults to dark when nothing is stored', () => {
    expect(getInitialTheme()).toBe('dark');
  });

  it('getInitialTheme reads stored preference from localStorage', () => {
    localStorage.setItem(LOCAL_STORAGE_KEY, 'light');
    expect(getInitialTheme()).toBe('light');

    localStorage.setItem(LOCAL_STORAGE_KEY, 'dark');
    expect(getInitialTheme()).toBe('dark');
  });

  it('applyTheme sets data-theme attribute and class list', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    applyTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.classList.contains('light')).toBe(false);
  });

  it('useTheme hook provides current theme and toggle function', () => {
    const { result } = renderHook(() => useTheme());

    expect(result.current.theme).toBe('dark');
    expect(result.current.isDark).toBe(true);

    act(() => {
      result.current.toggleTheme();
    });

    expect(result.current.theme).toBe('light');
    expect(result.current.isDark).toBe(false);
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    act(() => {
      result.current.setTheme('dark');
    });

    expect(result.current.theme).toBe('dark');
    expect(result.current.isDark).toBe(true);
    expect(localStorage.getItem(LOCAL_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('useTheme responds to chrome.storage.onChanged event', async () => {
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;

    if (globalThis.chrome?.storage?.onChanged) {
      vi.spyOn(globalThis.chrome.storage.onChanged, 'addListener').mockImplementation((fn) => {
        storageListener = fn as typeof storageListener;
      });
    }

    const { result } = renderHook(() => useTheme());

    if (storageListener) {
      act(() => {
        storageListener!({
          [THEME_STORAGE_KEY]: {
            oldValue: 'dark',
            newValue: 'light',
          },
        }, 'local');
      });

      expect(result.current.theme).toBe('light');
      expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    }
  });
});
