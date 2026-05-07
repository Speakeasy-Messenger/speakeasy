import type {
  CommunityRepo,
  CommunityRole,
  EnvelopeRecord,
} from './communities.js';

interface Community {
  createdBy: string;
  ttlDays: number;
  members: Map<string, CommunityRole>;
  /** key: `${recipient}:${epoch}` */
  envelopes: Map<string, EnvelopeRecord>;
}

export class InMemoryCommunityRepo implements CommunityRepo {
  readonly communities = new Map<string, Community>();

  async create(args: {
    communityId: string;
    createdBy: string;
    ttlDays?: number;
  }): Promise<void> {
    if (this.communities.has(args.communityId)) {
      throw new Error(`community ${args.communityId} already exists`);
    }
    this.communities.set(args.communityId, {
      createdBy: args.createdBy,
      ttlDays: args.ttlDays ?? 7,
      members: new Map([[args.createdBy, 'moderator']]),
      envelopes: new Map(),
    });
  }

  async addMember(args: {
    communityId: string;
    userId: string;
    role?: CommunityRole;
    addedBy: string;
  }): Promise<'ok' | 'community_missing' | 'not_member'> {
    const c = this.communities.get(args.communityId);
    if (!c) return 'community_missing';
    if (!c.members.has(args.addedBy)) return 'not_member';
    c.members.set(args.userId, args.role ?? 'member');
    return 'ok';
  }

  async removeMember(args: {
    communityId: string;
    userId: string;
  }): Promise<{ remaining: string[] } | 'community_missing' | 'not_a_member'> {
    const c = this.communities.get(args.communityId);
    if (!c) return 'community_missing';
    if (!c.members.has(args.userId)) return 'not_a_member';
    c.members.delete(args.userId);
    return { remaining: Array.from(c.members.keys()) };
  }

  async isMember(communityId: string, userId: string): Promise<boolean> {
    return this.communities.get(communityId)?.members.has(userId) ?? false;
  }

  async isModerator(communityId: string, userId: string): Promise<boolean> {
    return this.communities.get(communityId)?.members.get(userId) === 'moderator';
  }

  async listMembers(communityId: string): Promise<string[]> {
    return Array.from(this.communities.get(communityId)?.members.keys() ?? []);
  }

  async putEnvelope(args: {
    communityId: string;
    recipientUserId: string;
    wrappedKey: Buffer;
    wrappedByUserId: string;
    keyEpoch: number;
  }): Promise<void> {
    const c = this.communities.get(args.communityId);
    if (!c) throw new Error(`community ${args.communityId} missing`);
    c.envelopes.set(`${args.recipientUserId}:${args.keyEpoch}`, {
      communityId: args.communityId,
      recipientUserId: args.recipientUserId,
      wrappedKey: args.wrappedKey,
      wrappedByUserId: args.wrappedByUserId,
      keyEpoch: args.keyEpoch,
      createdAt: new Date(),
    });
  }

  async getLatestEnvelope(
    communityId: string,
    recipientUserId: string,
  ): Promise<EnvelopeRecord | undefined> {
    const c = this.communities.get(communityId);
    if (!c) return undefined;
    let best: EnvelopeRecord | undefined;
    for (const env of c.envelopes.values()) {
      if (env.recipientUserId !== recipientUserId) continue;
      if (!best || env.keyEpoch > best.keyEpoch) best = env;
    }
    return best;
  }
}
