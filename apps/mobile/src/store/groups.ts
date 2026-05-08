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
  /**
   * Server-side creator. Populated when the local user creates the
   * group (handleCreate) or when a peer's `GET /v1/groups/:id` round-
   * trip lands. The mobile UI only surfaces the "change avatar"
   * affordance to the creator.
   */
  createdBy?: string;
  // No avatar field — Phase 2 dropped group photos entirely. Group
  // visual identity is the deterministic geometric room mark, derived
  // client-side from `id` (see `<RoomMark roomId={id}>`).
  /** ms epoch of the last `GET /v1/groups/:id` round-trip. */
  metadataFetchedAt?: number;
}

interface GroupsState {
  byId: Record<string, Group>;
  /** True once `hydrate()` has run (loaded from disk on startup). */
  hydrated: boolean;
  /** Insert or merge a group entry. Member set unioned, name preserved if unset. */
  upsert: (group: Group) => void;
  /** Add a single member to an existing group (no-op if missing). */
  addMember: (groupId: string, userId: string) => void;
  /** Remove a single member from a group (no-op if missing). */
  removeMember: (groupId: string, userId: string) => void;
  /** Replace the entire member list — used after a server-side roster
   * resync so the local view doesn't drift if a member was removed
   * out-of-band. */
  setMembers: (groupId: string, members: string[]) => void;
  /** Rename a group locally. The wire broadcast lives in a server
   * endpoint that doesn't exist yet (`POST /v1/rooms/<id>/name`); for
   * now the rename is creator-local only. */
  setName: (groupId: string, name: string) => void;
  /** Drop a group from the local store entirely. Used by the leave
   * action when the server-side leave endpoint isn't available — the
   * user disappears the group from their device. Peers continue to
   * see the local user as a member until a real `/leave` endpoint
   * lands. */
  remove: (groupId: string) => void;
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
            createdBy: group.createdBy ?? existing.createdBy,
            metadataFetchedAt: group.metadataFetchedAt ?? existing.metadataFetchedAt,
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

  removeMember: (groupId, userId) =>
    set((s) => {
      const g = s.byId[groupId];
      if (!g || !g.members.includes(userId)) return s;
      const newById = {
        ...s.byId,
        [groupId]: { ...g, members: g.members.filter((m) => m !== userId) },
      };
      void persist(newById);
      return { byId: newById };
    }),

  setMembers: (groupId, members) =>
    set((s) => {
      const g = s.byId[groupId];
      if (!g) return s;
      const newById = { ...s.byId, [groupId]: { ...g, members: [...members] } };
      void persist(newById);
      return { byId: newById };
    }),

  setName: (groupId, name) =>
    set((s) => {
      const g = s.byId[groupId];
      if (!g) return s;
      const trimmed = name.trim();
      if (!trimmed || trimmed === g.name) return s;
      const newById = { ...s.byId, [groupId]: { ...g, name: trimmed } };
      void persist(newById);
      return { byId: newById };
    }),

  remove: (groupId) =>
    set((s) => {
      if (!s.byId[groupId]) return s;
      const { [groupId]: _gone, ...rest } = s.byId;
      void persist(rest);
      return { byId: rest };
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
