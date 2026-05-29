/**
 * Spec §4a: small-group ceiling. Lowered from 100 → 50 in rc.33 to
 * match the Play Store listing copy. Conversations above this size
 * must be a Community (server-side encrypted channel-key model).
 */
export const SMALL_GROUP_MAX_MEMBERS = 50;

export interface GroupSummary {
  id: string;
  createdBy: string;
  /** Display name set by the creator. Null until rc.48 callers (or
   *  an explicit setName) populate it; mobile falls back to a default. */
  name: string | null;
  // No avatar field — Phase 2 dropped group photos in favor of the
  // deterministic geometric room mark client-side. AVATAR-SYSTEM.md §7.
}

export interface GroupRepo {
  create(args: {
    groupId: string;
    createdBy: string;
    name?: string;
  }): Promise<void>;
  /** Returns the new member count, or `'group_full'`, or `'not_member'` (if `addedBy` isn't a member). */
  addMember(args: {
    groupId: string;
    userId: string;
    addedBy: string;
  }): Promise<number | 'group_full' | 'not_member' | 'group_missing'>;
  isMember(groupId: string, userId: string): Promise<boolean>;
  countMembers(groupId: string): Promise<number>;
  /** All members of the group, in arbitrary order. */
  listMembers(groupId: string): Promise<string[]>;
  /**
   * Remove a member. The caller must already be authorized upstream
   * (in our case the routes layer enforces creator-only). Returns:
   *   `'group_missing'` — group doesn't exist
   *   `'not_member'`    — `userId` isn't currently in the group
   *   `'cannot_remove_creator'` — refuse to evict the creator (they'd
   *                              still own the room and the next /v1/groups
   *                              GET would then fail their own membership
   *                              check; cleanest semantics is to forbid)
   *   number            — new member count after removal.
   */
  removeMember(args: {
    groupId: string;
    userId: string;
  }): Promise<number | 'group_missing' | 'not_member' | 'cannot_remove_creator'>;
  /** Creator-only metadata update, authorized by the routes layer. */
  setName(args: {
    groupId: string;
    name: string;
  }): Promise<GroupSummary | 'group_missing'>;
  /**
   * Voluntary leave. If the creator leaves, ownership passes to the
   * oldest remaining member. If the last member leaves, the room is
   * deleted.
   */
  leaveMember(args: {
    groupId: string;
    userId: string;
  }): Promise<
    | { members: number; createdBy: string | null; deleted: boolean }
    | 'group_missing'
    | 'not_member'
  >;
  /** Existence + creator lookup. Undefined when the group is missing. */
  findById(groupId: string): Promise<GroupSummary | undefined>;
}
