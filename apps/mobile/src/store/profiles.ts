import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * Cache of `userId → { avatarB64?, fetchedAt }`. Filled by the avatar
 * loader hook (lazy GET /v1/users/:id) and by the local user's own
 * setAvatar round-trip. Persisted across cold starts so the
 * conversations list doesn't re-flicker on every launch.
 *
 * Stored values are plaintext server-side for the alpha — see the
 * server-side `users.avatar_b64` comment for the v2 encryption story.
 */

const STORAGE_KEY = 'speakeasy.profiles.v1';

const TTL_MS = 24 * 60 * 60 * 1000; // re-fetch a peer's avatar at most once a day

export interface PeerProfile {
  /** base64 JPEG, or undefined if the peer has no avatar set. */
  avatarB64?: string;
  /** ms epoch when we last hit the server for this peer. */
  fetchedAt: number;
}

interface ProfilesState {
  byUserId: Record<string, PeerProfile>;
  hydrated: boolean;
  /** Replace (or clear) the cached entry for `userId`. */
  set: (userId: string, profile: PeerProfile) => void;
  /** Whether we've fetched this user recently enough to skip the network. */
  isFresh: (userId: string) => boolean;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

async function persist(byUserId: Record<string, PeerProfile>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byUserId));
  } catch {
    /* best-effort; in-memory is the source of truth for the session */
  }
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  byUserId: {},
  hydrated: false,

  set: (userId, profile) => {
    set((s) => ({ byUserId: { ...s.byUserId, [userId]: profile } }));
    void persist(get().byUserId);
  },

  isFresh: (userId) => {
    const p = get().byUserId[userId];
    if (!p) return false;
    return Date.now() - p.fetchedAt < TTL_MS;
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, PeerProfile>;
        set({ byUserId: parsed });
      }
    } catch {
      /* corrupt / missing → empty */
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ byUserId: {} });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
