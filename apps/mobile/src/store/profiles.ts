import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * Cache of `userId → { selectedAvatarId?, fetchedAt }`. Filled by the
 * <Avatar> component on first render (lazy GET /v1/users/:id) and by
 * the local user's own setAvatar round-trip. Persisted across cold
 * starts so the conversations list doesn't re-flicker on every launch.
 *
 * Phase 2 brand overhaul: was `avatarB64` (JPEG blob); now stores the
 * peer's selected animal id. Bumped storage key v1 → v2 so old cached
 * blobs fall off cleanly without a migration step (the data lives only
 * for `TTL_MS` between fetches anyway).
 */

const STORAGE_KEY = 'speakeasy.profiles.v2';

// Re-fetch a peer's profile at most once an hour. Was 24h, but that
// meant an avatar change took up to a day to propagate to contacts
// (rc.56 report). Call screens additionally force-refresh on mount
// (see refresh-profile.ts) so the most visible surface is never stale.
const TTL_MS = 60 * 60 * 1000;

export interface PeerProfile {
  /** Animal id from the launch set, or undefined if the peer hasn't
   * selected one yet (rendering falls back to defaultAnimalForUser). */
  selectedAvatarId?: string;
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
        // rc.6 rename: free common bird `raven` → `pigeon`; the
        // `raven` id is now the rare paid avatar. Any pre-rc.6 cached
        // selection that referenced 'raven' was the old free bird —
        // remap so users don't suddenly appear as the (unowned) rare.
        let migrated = false;
        for (const userId of Object.keys(parsed)) {
          const entry = parsed[userId];
          if (entry?.selectedAvatarId === 'raven') {
            parsed[userId] = { ...entry, selectedAvatarId: 'pigeon' };
            migrated = true;
          }
        }
        set({ byUserId: parsed });
        if (migrated) void persist(parsed);
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
