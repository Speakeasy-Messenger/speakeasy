import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { getCachedDeviceToken } from '../native/cached-device-token.js';

/**
 * Persisted identity. Keeps the user signed-in across app restarts so:
 *   - Backgrounding the app + Android killing the process doesn't force
 *     a fresh enroll on relaunch.
 *   - Re-tapping the launcher icon lands directly on Conversations rather
 *     than Onboarding, with the same userId.
 *
 * What we persist to AsyncStorage:
 *   - userId — the canonical handle the user picked at signup (or a
 *     legacy adj-adj-noun id for pre-handle-cutover accounts). Not a
 *     secret.
 *   - deviceTokenIssuedAt — when the token was last refreshed; drives
 *     the launch-verify freshness skip. Not a secret.
 *
 * What we do NOT persist to AsyncStorage:
 *   - deviceToken — Vouchflow's bearer-like per-device credential. It is
 *     owned by the Vouchflow SDK and lives in native secure storage
 *     (Android AccountManager / iOS Keychain). `hydrate()` loads the
 *     in-memory working copy from there via `getCachedDeviceToken()`;
 *     AsyncStorage (an unencrypted on-disk SQLite file) never sees it.
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
  deviceTokenIssuedAt?: number;
}

/** Legacy shape — pre-migration installs also stored `deviceToken` here. */
type LegacyPersistedShape = PersistedShape & { deviceToken?: string };

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
    void persist({ userId, deviceTokenIssuedAt: get().deviceTokenIssuedAt });
  },

  setDeviceToken: (deviceToken) => {
    const issuedAt = deviceToken ? Date.now() : undefined;
    // The token itself is held only in memory — the durable copy lives in
    // the Vouchflow SDK's native secure store. Only the (non-secret)
    // issued-at timestamp is persisted.
    set({ deviceToken, deviceTokenIssuedAt: issuedAt });
    void persist({ userId: get().userId, deviceTokenIssuedAt: issuedAt });
  },

  hydrate: async () => {
    let scrubLegacyToken = false;
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LegacyPersistedShape;
        set({
          userId: parsed.userId,
          deviceTokenIssuedAt: parsed.deviceTokenIssuedAt,
        });
        // Migration: builds before this change persisted the bearer-like
        // deviceToken here in cleartext. If one is present, scrub it —
        // the token now lives only in native secure storage.
        if (parsed.deviceToken !== undefined) scrubLegacyToken = true;
      }
    } catch {
      // Corrupt / missing → fall through with empty state.
    }
    // Load the in-memory working copy of the device token from the
    // Vouchflow SDK's native secure storage. No biometric / network —
    // safe at launch. `undefined` when not enrolled (or in test envs
    // with no native module); App.tsx then drives a fresh verify.
    let deviceToken: string | undefined;
    try {
      deviceToken = await getCachedDeviceToken();
    } catch {
      /* leave undefined — a verify will repopulate it */
    }
    set({ deviceToken, hydrated: true });
    if (scrubLegacyToken) {
      void persist({
        userId: get().userId,
        deviceTokenIssuedAt: get().deviceTokenIssuedAt,
      });
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
