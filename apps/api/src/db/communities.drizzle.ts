import { eq, desc, sql, and } from 'drizzle-orm';
import { getDb } from './client.js';
import {
  communities,
  communityMembers,
  communityKeyEnvelopes,
} from './schema.js';
import type {
  CommunityRepo,
  CommunityRole,
  EnvelopeRecord,
} from './communities.js';

export class DrizzleCommunityRepo implements CommunityRepo {
  async create(args: {
    communityId: string;
    createdBy: string;
    ttlDays?: number;
  }): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.insert(communities).values({
        id: args.communityId,
        createdBy: args.createdBy,
        ttlDays: args.ttlDays ?? 7,
      });
      await tx.insert(communityMembers).values({
        communityId: args.communityId,
        userId: args.createdBy,
        role: 'moderator',
      });
    });
  }

  async addMember(args: {
    communityId: string;
    userId: string;
    role?: CommunityRole;
    addedBy: string;
  }): Promise<'ok' | 'community_missing' | 'not_member'> {
    const db = getDb();
    const c = await db
      .select({ id: communities.id })
      .from(communities)
      .where(eq(communities.id, args.communityId))
      .limit(1);
    if (c.length === 0) return 'community_missing';

    const adder = await db
      .select({ userId: communityMembers.userId })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, args.communityId),
          eq(communityMembers.userId, args.addedBy),
        ),
      )
      .limit(1);
    if (adder.length === 0) return 'not_member';

    await db
      .insert(communityMembers)
      .values({
        communityId: args.communityId,
        userId: args.userId,
        role: args.role ?? 'member',
      })
      .onConflictDoNothing();
    return 'ok';
  }

  async removeMember(args: {
    communityId: string;
    userId: string;
  }): Promise<{ remaining: string[] } | 'community_missing' | 'not_a_member'> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const c = await tx
        .select({ id: communities.id })
        .from(communities)
        .where(eq(communities.id, args.communityId))
        .limit(1);
      if (c.length === 0) return 'community_missing' as const;

      const deleted = await tx
        .delete(communityMembers)
        .where(
          and(
            eq(communityMembers.communityId, args.communityId),
            eq(communityMembers.userId, args.userId),
          ),
        )
        .returning({ userId: communityMembers.userId });
      if (deleted.length === 0) return 'not_a_member' as const;

      const remaining = await tx
        .select({ userId: communityMembers.userId })
        .from(communityMembers)
        .where(eq(communityMembers.communityId, args.communityId));
      return { remaining: remaining.map((r) => r.userId) };
    });
  }

  async isMember(communityId: string, userId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ userId: communityMembers.userId })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async isModerator(communityId: string, userId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ role: communityMembers.role })
      .from(communityMembers)
      .where(
        and(
          eq(communityMembers.communityId, communityId),
          eq(communityMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows.length > 0 && rows[0]!.role === 'moderator';
  }

  async listMembers(communityId: string): Promise<string[]> {
    const db = getDb();
    const rows = await db
      .select({ userId: communityMembers.userId })
      .from(communityMembers)
      .where(eq(communityMembers.communityId, communityId));
    return rows.map((r) => r.userId);
  }

  async putEnvelope(args: {
    communityId: string;
    recipientUserId: string;
    wrappedKey: Buffer;
    wrappedByUserId: string;
    keyEpoch: number;
  }): Promise<void> {
    const db = getDb();
    await db
      .insert(communityKeyEnvelopes)
      .values({
        communityId: args.communityId,
        recipientUserId: args.recipientUserId,
        wrappedKey: args.wrappedKey,
        wrappedByUserId: args.wrappedByUserId,
        keyEpoch: args.keyEpoch,
      })
      .onConflictDoUpdate({
        target: [
          communityKeyEnvelopes.communityId,
          communityKeyEnvelopes.recipientUserId,
          communityKeyEnvelopes.keyEpoch,
        ],
        set: {
          wrappedKey: args.wrappedKey,
          wrappedByUserId: args.wrappedByUserId,
        },
      });
  }

  async getLatestEnvelope(
    communityId: string,
    recipientUserId: string,
  ): Promise<EnvelopeRecord | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(communityKeyEnvelopes)
      .where(
        and(
          eq(communityKeyEnvelopes.communityId, communityId),
          eq(communityKeyEnvelopes.recipientUserId, recipientUserId),
        ),
      )
      .orderBy(desc(communityKeyEnvelopes.keyEpoch))
      .limit(1);
    if (rows.length === 0) return undefined;
    const r = rows[0]!;
    return {
      communityId: r.communityId,
      recipientUserId: r.recipientUserId,
      wrappedKey: r.wrappedKey,
      wrappedByUserId: r.wrappedByUserId,
      keyEpoch: r.keyEpoch,
      createdAt: r.createdAt,
    };
  }
}
