/** Spec §4a: small-group ceiling is 100 members. */
export const SMALL_GROUP_MAX_MEMBERS = 100;

export interface GroupSummary {
  id: string;
  createdBy: string;
  /** base64 JPEG, ~256px square, plaintext. Undefined = no avatar set. */
  avatarB64?: string;
}

export interface GroupRepo {
  create(args: { groupId: string; createdBy: string }): Promise<void>;
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
  /** Existence + avatar + creator lookup. Undefined when the group is missing. */
  findById(groupId: string): Promise<GroupSummary | undefined>;
  /**
   * Set or clear (`undefined`) the group's avatar. Caller must enforce
   * the creator-only policy upstream — this method writes whatever is
   * passed.
   */
  setAvatar(groupId: string, avatarB64: string | undefined): Promise<void>;
}
