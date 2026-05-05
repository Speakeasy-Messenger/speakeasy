import { eq, sql, and } from 'drizzle-orm';
import { getDb } from './client.js';
import { groups, groupMembers } from './schema.js';
import { SMALL_GROUP_MAX_MEMBERS, type GroupRepo, type GroupSummary } from './groups.js';

export class DrizzleGroupRepo implements GroupRepo {
  async create(args: { groupId: string; createdBy: string }): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(groups)
        .values({ id: args.groupId, createdBy: args.createdBy })
        .onConflictDoNothing()
        .returning({ id: groups.id });
      if (inserted.length === 0) {
        throw new Error(`Group ${args.groupId} already exists`);
      }

      await tx.insert(groupMembers).values({
        groupId: args.groupId,
        userId: args.createdBy,
      });
    });
  }

  async addMember(args: {
    groupId: string;
    userId: string;
    addedBy: string;
  }): Promise<number | 'group_full' | 'not_member' | 'group_missing'> {
    const db = getDb();
    return db.transaction(async (tx) => {
      // Check group exists
      const groupRows = await tx
        .select({ id: groups.id })
        .from(groups)
        .where(eq(groups.id, args.groupId))
        .limit(1);
      if (groupRows.length === 0) return 'group_missing';

      // Check addedBy is a member
      const addedByMember = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, args.groupId),
            eq(groupMembers.userId, args.addedBy),
          ),
        )
        .limit(1);
      if (addedByMember.length === 0) return 'not_member';

      // Check if userId is already a member
      const existingMember = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, args.groupId),
            eq(groupMembers.userId, args.userId),
          ),
        )
        .limit(1);
      if (existingMember.length > 0) {
        const countRows = await tx
          .select({ count: sql<number>`count(*)` })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, args.groupId));
        return Number(countRows[0]!.count);
      }

      // Check if group is full
      const countRows = await tx
        .select({ count: sql<number>`count(*)` })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, args.groupId));
      if (Number(countRows[0]!.count) >= SMALL_GROUP_MAX_MEMBERS) {
        return 'group_full';
      }

      // Insert new member
      await tx.insert(groupMembers).values({
        groupId: args.groupId,
        userId: args.userId,
      });

      const newCountRows = await tx
        .select({ count: sql<number>`count(*)` })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, args.groupId));
      return Number(newCountRows[0]!.count);
    });
  }

  async isMember(groupId: string, userId: string): Promise<boolean> {
    const db = getDb();
    const rows = await db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.userId, userId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async countMembers(groupId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ count: sql<number>`count(*)` })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    return Number(rows[0]!.count);
  }

  async listMembers(groupId: string): Promise<string[]> {
    const db = getDb();
    const rows = await db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    return rows.map((row) => row.userId);
  }

  async findById(groupId: string): Promise<GroupSummary | undefined> {
    const db = getDb();
    const rows = await db
      .select({
        id: groups.id,
        createdBy: groups.createdBy,
        avatarB64: groups.avatarB64,
      })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    const row = rows[0];
    return row
      ? { id: row.id, createdBy: row.createdBy, avatarB64: row.avatarB64 ?? undefined }
      : undefined;
  }

  async setAvatar(groupId: string, avatarB64: string | undefined): Promise<void> {
    const db = getDb();
    await db
      .update(groups)
      .set({ avatarB64: avatarB64 ?? null })
      .where(eq(groups.id, groupId));
  }
}
