export type CommunityRole = 'member' | 'moderator';

export interface EnvelopeRecord {
  communityId: string;
  recipientUserId: string;
  wrappedKey: Buffer;
  wrappedByUserId: string;
  keyEpoch: number;
  createdAt: Date;
}

export interface CommunityRepo {
  create(args: {
    communityId: string;
    createdBy: string;
    ttlDays?: number;
  }): Promise<void>;

  addMember(args: {
    communityId: string;
    userId: string;
    role?: CommunityRole;
    addedBy: string;
  }): Promise<'ok' | 'community_missing' | 'not_member'>;

  /**
   * Remove `userId` from `communityId`. The caller's authorization
   * is enforced upstream in the route handler (a moderator can
   * remove anyone; a member can remove themselves). The repo just
   * does the deletion and reports the post-removal member list so
   * the route can fan out the rotation-required signal without a
   * second query.
   *
   * Returns `'community_missing'` if no such community,
   * `'not_a_member'` if the user wasn't a member to begin with,
   * or `{ remaining }` with the user list AFTER removal (in
   * arbitrary order; does NOT include the removed user).
   */
  removeMember(args: {
    communityId: string;
    userId: string;
  }): Promise<{ remaining: string[] } | 'community_missing' | 'not_a_member'>;

  isMember(communityId: string, userId: string): Promise<boolean>;
  isModerator(communityId: string, userId: string): Promise<boolean>;
  /** All members of the community, in arbitrary order. */
  listMembers(communityId: string): Promise<string[]>;

  /** Insert a per-recipient envelope. Same (community,recipient,epoch) overwrites. */
  putEnvelope(args: {
    communityId: string;
    recipientUserId: string;
    wrappedKey: Buffer;
    wrappedByUserId: string;
    keyEpoch: number;
  }): Promise<void>;

  /** Latest-epoch envelope for `recipientUserId`. Undefined if none. */
  getLatestEnvelope(
    communityId: string,
    recipientUserId: string,
  ): Promise<EnvelopeRecord | undefined>;
}
