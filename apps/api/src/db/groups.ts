/** Spec §4a: small-group ceiling is 100 members. */
export const SMALL_GROUP_MAX_MEMBERS = 100;

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
}
