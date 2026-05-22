import { asc, eq, sql, and } from 'drizzle-orm';
import { getDb } from './client.js';
import { groups, groupMembers } from './schema.js';
import { SMALL_GROUP_MAX_MEMBERS, type GroupRepo, type GroupSummary } from './groups.js';

export class DrizzleGroupRepo implements GroupRepo {
  async create(args: {
    groupId: string;
    createdBy: string;
    name?: string;
  }): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(groups)
        .values({
          id: args.groupId,
          createdBy: args.createdBy,
          name: args.name ?? null,
        })
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

  async removeMember(args: {
    groupId: string;
    userId: string;
  }): Promise<number | 'group_missing' | 'not_member' | 'cannot_remove_creator'> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const groupRows = await tx
        .select({ id: groups.id, createdBy: groups.createdBy })
        .from(groups)
        .where(eq(groups.id, args.groupId))
        .limit(1);
      if (groupRows.length === 0) return 'group_missing';
      if (groupRows[0]!.createdBy === args.userId) return 'cannot_remove_creator';

      const existing = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, args.groupId),
            eq(groupMembers.userId, args.userId),
          ),
        )
        .limit(1);
      if (existing.length === 0) return 'not_member';

      await tx
        .delete(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, args.groupId),
            eq(groupMembers.userId, args.userId),
          ),
        );

      const countRows = await tx
        .select({ count: sql<number>`count(*)` })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, args.groupId));
      return Number(countRows[0]!.count);
    });
  }

  async setName(args: {
    groupId: string;
    name: string;
  }): Promise<GroupSummary | 'group_missing'> {
    const db = getDb();
    const rows = await db
      .update(groups)
      .set({ name: args.name })
      .where(eq(groups.id, args.groupId))
      .returning({
        id: groups.id,
        createdBy: groups.createdBy,
        name: groups.name,
      });
    const row = rows[0];
    return row
      ? { id: row.id, createdBy: row.createdBy, name: row.name }
      : 'group_missing';
  }

  async leaveMember(args: {
    groupId: string;
    userId: string;
  }): Promise<
    | { members: number; createdBy: string | null; deleted: boolean }
    | 'group_missing'
    | 'not_member'
  > {
    const db = getDb();
    return db.transaction(async (tx) => {
      const groupRows = await tx
        .select({ id: groups.id, createdBy: groups.createdBy })
        .from(groups)
        .where(eq(groups.id, args.groupId))
        .limit(1);
      const group = groupRows[0];
      if (!group) return 'group_missing';

      const existing = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, args.groupId),
            eq(groupMembers.userId, args.userId),
          ),
        )
        .limit(1);
      if (existing.length === 0) return 'not_member';

      await tx
        .delete(groupMembers)
        .where(
          and(
            eq(groupMembers.groupId, args.groupId),
            eq(groupMembers.userId, args.userId),
          ),
        );

      const remaining = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, args.groupId))
        .orderBy(asc(groupMembers.joinedAt), asc(groupMembers.userId));

      if (remaining.length === 0) {
        await tx.delete(groups).where(eq(groups.id, args.groupId));
        return { members: 0, createdBy: null, deleted: true };
      }

      let createdBy = group.createdBy;
      if (group.createdBy === args.userId) {
        createdBy = remaining[0]!.userId;
        await tx
          .update(groups)
          .set({ createdBy })
          .where(eq(groups.id, args.groupId));
      }

      return { members: remaining.length, createdBy, deleted: false };
    });
  }

  async findById(groupId: string): Promise<GroupSummary | undefined> {
    const db = getDb();
    const rows = await db
      .select({
        id: groups.id,
        createdBy: groups.createdBy,
        name: groups.name,
      })
      .from(groups)
      .where(eq(groups.id, groupId))
      .limit(1);
    const row = rows[0];
    return row
      ? { id: row.id, createdBy: row.createdBy, name: row.name }
      : undefined;
  }
}
