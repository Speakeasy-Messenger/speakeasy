import { create } from 'zustand';

/**
 * Per-process knowledge of groups the local user is a member of.
 *
 * Phase 5e: in-memory only — created groups + groups we're added to are
 * tracked here so the conversations list can render them and the
 * GroupChatScreen knows the member set. Persistence (so groups survive
 * cold starts) lands when the conversation store moves to SQLCipher;
 * for now a relaunch loses the local group registry, but server-side
 * membership and the on-disk Sender Keys (SQLCipher) are intact, so the
 * recovery path is "the user re-adds the group locally" or "the next
 * group message arriving teaches the client about it again."
 */

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
  /** Insert or merge a group entry. Member set unioned, name preserved if unset. */
  upsert: (group: Group) => void;
  /** Add a single member to an existing group (no-op if missing). */
  addMember: (groupId: string, userId: string) => void;
  reset: () => void;
}

export const useGroups = create<GroupsState>((set) => ({
  byId: {},

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
      return { byId: { ...s.byId, [group.id]: merged } };
    }),

  addMember: (groupId, userId) =>
    set((s) => {
      const g = s.byId[groupId];
      if (!g) return s;
      if (g.members.includes(userId)) return s;
      return {
        byId: { ...s.byId, [groupId]: { ...g, members: [...g.members, userId] } },
      };
    }),

  reset: () => set({ byId: {} }),
}));
