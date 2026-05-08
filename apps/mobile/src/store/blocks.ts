import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * BLOCK.md §10 — local block list.
 *
 * Server endpoints (`POST /v1/blocks`, `POST /v1/blocks/<h>/remove`,
 * `GET /v1/blocks`) don't exist yet. Until they ship, blocks are a
 * **client-only** mechanism: this store decides whether the local UI
 * shows a frozen conversation, but it doesn't actually stop the
 * blocked party from messaging or calling. The privacy properties
 * the spec calls "load-bearing" (the blocker's act of blocking is
 * undetectable to the blocked) require the server-side block model
 * to enforce them on every wire surface — flagged as a §10
 * follow-up.
 */

const STORAGE_KEY = 'speakeasy-blocks';

export interface BlockEntry {
  handle: string;
  /** Wall-clock ms when the block was committed. */
  blockedAt: number;
}

interface BlocksState {
  byHandle: Record<string, BlockEntry>;
  hydrated: boolean;
  /** True if the local user has blocked `handle`. */
  isBlocked: (handle: string) => boolean;
  /** Sorted by `blockedAt` desc — newest first, for the list screen. */
  list: () => BlockEntry[];
  block: (handle: string) => void;
  unblock: (handle: string) => void;
  hydrate: () => Promise<void>;
  reset: () => Promise<void>;
}

async function persist(byHandle: Record<string, BlockEntry>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byHandle));
  } catch {
    // Persistence failure is non-fatal — in-memory state is the
    // source of truth for the current session.
  }
}

export const useBlocks = create<BlocksState>((set, get) => ({
  byHandle: {},
  hydrated: false,

  isBlocked: (handle) => !!get().byHandle[handle],

  list: () =>
    Object.values(get().byHandle).sort((a, b) => b.blockedAt - a.blockedAt),

  block: (handle) =>
    set((s) => {
      if (s.byHandle[handle]) return s;
      const entry: BlockEntry = { handle, blockedAt: Date.now() };
      const next = { ...s.byHandle, [handle]: entry };
      void persist(next);
      return { byHandle: next };
    }),

  unblock: (handle) =>
    set((s) => {
      if (!s.byHandle[handle]) return s;
      const { [handle]: _gone, ...rest } = s.byHandle;
      void persist(rest);
      return { byHandle: rest };
    }),

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, BlockEntry>;
        set({ byHandle: parsed });
      }
    } catch {
      // Corrupt / missing → keep empty state.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ byHandle: {} });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
