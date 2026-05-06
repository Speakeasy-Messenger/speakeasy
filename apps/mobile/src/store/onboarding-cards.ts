import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

const STORAGE_KEY = 'speakeasy.onboardingCards.v1';

/**
 * Per-card "I dismissed this" memory for the Get Started row on the
 * conversations list. Each card is keyed by a stable id (`invite`,
 * `newGroup`, `newChat`); once the user taps `X` on a card it stays
 * gone across cold starts.
 */
interface State {
  dismissed: Record<string, true>;
  hydrated: boolean;
  dismiss: (id: string) => void;
  isDismissed: (id: string) => boolean;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

export const useOnboardingCards = create<State>((set, get) => ({
  dismissed: {},
  hydrated: false,

  dismiss: (id) => {
    const next = { ...get().dismissed, [id]: true as const };
    set({ dismissed: next });
    void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
  },

  isDismissed: (id) => !!get().dismissed[id],

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, true>;
        if (parsed && typeof parsed === 'object') set({ dismissed: parsed });
      }
    } catch {
      /* keep empty */
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ dismissed: {} });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
