import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * Persisted identity. Keeps the user signed-in across app restarts so:
 *   - Backgrounding the app + Android killing the process doesn't force
 *     a fresh enroll on relaunch.
 *   - Re-tapping the launcher icon lands directly on Conversations rather
 *     than Onboarding, with the same userId.
 *
 * What we persist:
 *   - userId — the canonical adjective-adjective-noun id the server
 *     minted at signup.
 *   - deviceToken — Vouchflow's per-device token. Reused for every
 *     authenticated request so we don't re-prompt biometric / re-attest
 *     on every interaction.
 *
 * What we do NOT persist (yet):
 *   - Conversation messages (intentional — spec §5: "say it & leave").
 *   - Group registry (loses on restart; recoverable when group messages
 *     re-arrive). Phase 5e SQLCipher pickup.
 *   - Distribution-id allocations (re-derive on demand; cost is one
 *     extra SKDM per group on first send after restart).
 */

const STORAGE_KEY = 'speakeasy.identity.v1';

export interface IdentityState {
  userId: string | undefined;
  deviceToken: string | undefined;
  /**
   * Wall-clock ms when `deviceToken` was last refreshed via a successful
   * `vouchflow.verify()`. Used by App.tsx to skip a launch-verify when
   * the token is still inside the server's freshness window — there's
   * no reason to re-attest (and possibly prompt biometric) when the
   * server would still accept the cached token.
   */
  deviceTokenIssuedAt: number | undefined;
  /**
   * `false` until `hydrate()` has run on app start. Gates the initial
   * navigation: the RootNavigator shows a blank/splash screen while
   * hydrating, then routes to Onboarding (no userId) or Conversations
   * (userId persisted).
   */
  hydrated: boolean;
  setUserId: (id: string | undefined) => void;
  setDeviceToken: (token: string | undefined) => void;
  /** Read identity from disk and populate the store. Idempotent. */
  hydrate: () => Promise<void>;
  /**
   * Wipe identity locally AND on disk. Called on sign-out / re-enroll;
   * the next render shows Onboarding.
   */
  reset: () => Promise<void>;
}

interface PersistedShape {
  userId?: string;
  deviceToken?: string;
  deviceTokenIssuedAt?: number;
}

async function persist(s: PersistedShape): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Persistence failure is non-fatal — in-memory state is the source
    // of truth for the current session; we'll just lose it on restart.
  }
}

export const useIdentity = create<IdentityState>((set, get) => ({
  userId: undefined,
  deviceToken: undefined,
  deviceTokenIssuedAt: undefined,
  hydrated: false,

  setUserId: (userId) => {
    set({ userId });
    void persist({
      userId,
      deviceToken: get().deviceToken,
      deviceTokenIssuedAt: get().deviceTokenIssuedAt,
    });
  },

  setDeviceToken: (deviceToken) => {
    const issuedAt = deviceToken ? Date.now() : undefined;
    set({ deviceToken, deviceTokenIssuedAt: issuedAt });
    void persist({
      userId: get().userId,
      deviceToken,
      deviceTokenIssuedAt: issuedAt,
    });
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedShape;
        set({
          userId: parsed.userId,
          deviceToken: parsed.deviceToken,
          deviceTokenIssuedAt: parsed.deviceTokenIssuedAt,
        });
      }
    } catch {
      // Corrupt / missing → fall through with empty state.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({
      userId: undefined,
      deviceToken: undefined,
      deviceTokenIssuedAt: undefined,
    });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));

export const isEnrolled = (s: IdentityState): boolean => Boolean(s.userId);
