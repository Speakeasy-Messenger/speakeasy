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
