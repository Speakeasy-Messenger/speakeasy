import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { accent, brand, workspace, type Mode, type WorkspaceTokens } from './tokens.js';

/**
 * Workspace tokens for the active mode plus the mode-invariant brand
 * palette and accent. Consumed via `useTheme()`. Brand-canvas screens
 * reach for `theme.brand.*` directly when they need the aubergine.
 */
export interface Theme extends WorkspaceTokens {
  mode: Mode;
  /** Brass — same value across brand, dark, and light contexts. */
  accent: string;
  accentPressed: string;
  accentFg: string;
  brand: typeof brand;
}

const ThemeCtx = createContext<Theme>({
  ...workspace.dark,
  mode: 'dark',
  accent: accent.base,
  accentPressed: accent.pressed,
  accentFg: accent.foreground,
  brand,
});

/**
 * User's mode preference: `'system'` follows the OS setting, `'dark'` /
 * `'light'` pin it. Persisted via AsyncStorage so the choice survives a
 * cold start. Default `'system'` on first launch.
 */
type ModePreference = Mode | 'system';
const STORAGE_KEY = 'speakeasy.themeMode.v1';

interface ThemePrefState {
  preference: ModePreference;
  hydrated: boolean;
  set: (p: ModePreference) => void;
  hydrate: () => Promise<void>;
}

export const useThemePref = create<ThemePrefState>((set) => ({
  preference: 'system',
  hydrated: false,
  set: (p) => {
    set({ preference: p });
    void AsyncStorage.setItem(STORAGE_KEY, p).catch(() => {});
  },
  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw === 'system' || raw === 'dark' || raw === 'light') {
        set({ preference: raw });
      }
    } catch {
      /* keep defaults */
    } finally {
      set({ hydrated: true });
    }
  },
}));

interface ProviderProps {
  /** Override for tests or stories. Default: read from `useThemePref`. */
  mode?: ModePreference;
  children: ReactNode;
}

export function ThemeProvider({ mode, children }: ProviderProps): React.JSX.Element {
  const systemScheme = useColorScheme();
  const storedPreference = useThemePref((s) => s.preference);
  const hydrated = useThemePref((s) => s.hydrated);
  const hydratePref = useThemePref((s) => s.hydrate);

  // Hydrate once on mount. Any further change flows through the store.
  useEffect(() => {
    if (!hydrated) void hydratePref();
  }, [hydrated, hydratePref]);

  const preference = mode ?? storedPreference;
  const resolved: Mode =
    preference === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : preference;

  const theme = useMemo<Theme>(
    () => ({
      ...workspace[resolved],
      mode: resolved,
      accent: accent.base,
      accentPressed: accent.pressed,
      accentFg: accent.foreground,
      brand,
    }),
    [resolved],
  );

  return <ThemeCtx.Provider value={theme}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeCtx);
}
