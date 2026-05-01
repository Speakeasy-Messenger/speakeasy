import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';

/**
 * Per-process knowledge of groups the local user is a member of.
 *
 * Persisted to AsyncStorage so groups survive app restarts.
 * Each group has an id, display name, member list, and creation timestamp.
 */

const STORAGE_KEY = 'speakeasy-groups';

export interface Group {
  id: string;
  /** Display name (shown with `#` prefix in the conversations list per spec §14). */
  name: string;
  /** Member user ids. Always includes the local user. */
  members: string[];
  /** Wall-clock ms when the group was registered locally. */
  createdAt: number;
}

interface GroupsState {
  byId: Record<string, Group>;
  /** True once `hydrate()` has run (loaded from disk on startup). */
  hydrated: boolean;
  /** Insert or merge a group entry. Member set unioned, name preserved if unset. */
  upsert: (group: Group) => void;
  /** Add a single member to an existing group (no-op if missing). */
  addMember: (groupId: string, userId: string) => void;
  /** Read persisted state from disk. Idempotent. */
  hydrate: () => Promise<void>;
  /** Wipe groups locally AND on disk. */
  reset: () => Promise<void>;
}

async function persist(byId: Record<string, Group>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byId));
  } catch {
    // Persistence failure is non-fatal — in-memory state is the source
    // of truth for the current session.
  }
}

export const useGroups = create<GroupsState>((set, get) => ({
  byId: {},
  hydrated: false,

  upsert: (group) =>
    set((s) => {
      const existing = s.byId[group.id];
      const merged: Group = existing
        ? {
            ...existing,
            // Keep the existing name if the new one is empty (lets a
            // group taught by a server message keep the name the user
            // gave it locally).
            name: group.name || existing.name,
            members: Array.from(new Set([...existing.members, ...group.members])),
          }
        : group;
      const newById = { ...s.byId, [group.id]: merged };
      void persist(newById);
      return { byId: newById };
    }),

  addMember: (groupId, userId) =>
    set((s) => {
      const g = s.byId[groupId];
      if (!g) return s;
      if (g.members.includes(userId)) return s;
      const newById = { ...s.byId, [groupId]: { ...g, members: [...g.members, userId] } };
      void persist(newById);
      return { byId: newById };
    }),

  hydrate: async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Group>;
        set({ byId: parsed });
      }
    } catch {
      // Corrupt / missing → keep empty state.
    } finally {
      set({ hydrated: true });
    }
  },

  reset: async () => {
    set({ byId: {}, hydrated: false });
    try {
      await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
}));
