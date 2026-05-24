import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { KNOWN_CALL_KINDS, type CallKind } from '@speakeasy/shared';

/**
 * Cache of `userId → { kinds, fetchedAt }` from `GET /v1/users/:id`'s
 * `supported_call_kinds` UNION. Separate from `profiles.ts` for two
 * reasons (Codex tension #4 from /plan-eng-review):
 *
 *  1. **Different freshness needs.** Profile data (selected animal) is
 *     fine on a 24-hour TTL because animals rarely change and stale
 *     guesses are cheap to repair. Capability data drives whether the
 *     CallTypeSheet shows the Private row — a stale "yes Private" hint
 *     can lead the user to ring a peer whose old phone CAN'T answer
 *     (server-side fan-out filter saves the brand promise but the user
 *     sees an awkward dead ring). Refresh hourly at most, every
 *     15 min in practice.
 *  2. **Different lifecycle.** Capability changes when a peer's app
 *     upgrades or downgrades. Profile changes when the peer taps a
 *     new avatar. Bolting capability onto `profiles` either churns
 *     avatar data (wasted reads) or leaves capability stale (wasted
 *     opportunity to ring Private). Separating is cleaner.
 *
 * Persisted across cold starts so the CallTypeSheet's async row reveal
 * doesn't always wait for a network roundtrip on every chat open.
 */

const STORAGE_KEY = 'speakeasy.call-capabilities.v1';

const TTL_MS = 15 * 60 * 1000; // 15 minutes — see header comment

export interface PeerCallCapabilities {
  /**
   * UNION of capabilities across the peer's currently-connected devices,
   * as returned by `GET /v1/users/:id`. Empty array means "user exists
   * but no live or persisted device-level info available" — UI treats
   * this the same as missing data (no Private row).
   */
  kinds: CallKind[];
  /** ms epoch when we last fetched this. */
  fetchedAt: number;
}

interface CallCapabilitiesState {
  byUserId: Record<string, PeerCallCapabilities>;
  hydrated: boolean;
  /** Replace the cached entry for `userId`. Validates the kinds set. */
  set: (userId: string, kinds: readonly string[]) => void;
  /** Whether we've fetched this user's capabilities recently enough. */
  isFresh: (userId: string) => boolean;
  /** Convenience: true when the cached entry includes the named kind. */
  supports: (userId: string, kind: CallKind) => boolean;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

async function persist(
  byUserId: Record<string, PeerCallCapabilities>,
): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byUserId));
  } catch {
    /* best-effort; in-memory is the source of truth for the session */
  }
}

export const useCallCapabilities = create<CallCapabilitiesState>((set, get) => ({
  byUserId: {},
  hydrated: false,

  set: (userId, kinds) => {
    // Filter to known kinds — defense in depth against a stale server
    // returning a future kind this client doesn't understand.
    const validated = kinds.filter((k): k is CallKind =>
      typeof k === 'string' && KNOWN_CALL_KINDS.has(k as CallKind),
    );
    set((s) => ({
      byUserId: {
        ...s.byUserId,
        [userId]: { kinds: validated, fetchedAt: Date.now() },
      },
    }));
    void persist(get().byUserId);
  },

  isFresh: (userId) => {
    const entry = get().byUserId[userId];
    if (!entry) return false;
    return Date.now() - entry.fetchedAt < TTL_MS;
  },

  supports: (userId, kind) => {
    const entry = get().byUserId[userId];
    return !!entry && entry.kinds.includes(kind);
  },

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, PeerCallCapabilities>;
        set({ byUserId: parsed });
      }
    } catch {
      /* corrupt cache — start empty */
    }
    set({ hydrated: true });
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
