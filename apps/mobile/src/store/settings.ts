import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const STORAGE_KEY = 'speakeasy.settings.v1';

interface SettingsState {
  inAppNotificationsEnabled: boolean;
  hydrated: boolean;
  setInAppNotificationsEnabled: (enabled: boolean) => void;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

interface PersistedShape {
  inAppNotificationsEnabled?: boolean;
}

async function persist(s: PersistedShape): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Best-effort. In-memory state is the source of truth for the session.
  }
}

export const useSettings = create<SettingsState>((set, get) => ({
  inAppNotificationsEnabled: true,
  hydrated: false,

  setInAppNotificationsEnabled: (enabled) => {
    set({ inAppNotificationsEnabled: enabled });
    void persist({ inAppNotificationsEnabled: enabled });
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedShape;
        if (typeof parsed.inAppNotificationsEnabled === 'boolean') {
          set({ inAppNotificationsEnabled: parsed.inAppNotificationsEnabled });
        }
      }
    } catch {
      // Corrupt / missing → keep defaults.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ inAppNotificationsEnabled: true });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
