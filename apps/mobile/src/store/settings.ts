import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const STORAGE_KEY = 'speakeasy.settings.v1';

/**
 * What gets shown on the system notification banner. Default is 'rich'
 * — the user explicitly asked for content-rich-by-default behaviour
 * matching other messaging apps. 'private' falls back to a generic
 * "speakeasy: New message" with no sender attribution.
 *
 * This is per-device by design — the privacy choice is "what does
 * *this* device's lock screen reveal," not a user-account-wide knob.
 * The server respects whichever preference each device most recently
 * sent up via POST /v1/devices/push-token.
 */
export type NotificationPrivacy = 'rich' | 'private';

interface SettingsState {
  inAppNotificationsEnabled: boolean;
  notificationPrivacy: NotificationPrivacy;
  hydrated: boolean;
  setInAppNotificationsEnabled: (enabled: boolean) => void;
  setNotificationPrivacy: (privacy: NotificationPrivacy) => void;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

interface PersistedShape {
  inAppNotificationsEnabled?: boolean;
  notificationPrivacy?: NotificationPrivacy;
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
  notificationPrivacy: 'rich',
  hydrated: false,

  setInAppNotificationsEnabled: (enabled) => {
    set({ inAppNotificationsEnabled: enabled });
    const s = get();
    void persist({
      inAppNotificationsEnabled: enabled,
      notificationPrivacy: s.notificationPrivacy,
    });
  },

  setNotificationPrivacy: (privacy) => {
    set({ notificationPrivacy: privacy });
    const s = get();
    void persist({
      inAppNotificationsEnabled: s.inAppNotificationsEnabled,
      notificationPrivacy: privacy,
    });
    // The server-side push of this preference happens via the existing
    // POST /v1/devices/push-token call. Caller (SettingsScreen) is
    // responsible for invoking that — we don't reach into services.ts
    // from a Zustand store to keep this pure / side-effect-free.
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedShape;
        if (typeof parsed.inAppNotificationsEnabled === 'boolean') {
          set({ inAppNotificationsEnabled: parsed.inAppNotificationsEnabled });
        }
        if (parsed.notificationPrivacy === 'rich' || parsed.notificationPrivacy === 'private') {
          set({ notificationPrivacy: parsed.notificationPrivacy });
        }
      }
    } catch {
      // Corrupt / missing → keep defaults.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ inAppNotificationsEnabled: true, notificationPrivacy: 'rich' });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
