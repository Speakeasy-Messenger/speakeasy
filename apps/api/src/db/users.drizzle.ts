import { eq, or, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import {
  communities,
  communityKeyEnvelopes,
  groups,
  messages,
  prekeyBundles,
  users,
} from './schema.js';
import type { PreKeyBundleInput, UserRepo, UserSummary } from './users.js';

export class DrizzleUserRepo implements UserRepo {
  async tryCreate(args: {
    userId: string;
    deviceToken: string;
    publicKey: Buffer;
    bundle: PreKeyBundleInput;
  }): Promise<boolean> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const inserted = await tx
        .insert(users)
        .values({
          id: args.userId,
          publicKey: args.publicKey,
          deviceToken: args.deviceToken,
        })
        .onConflictDoNothing()
        .returning({ id: users.id });
      if (inserted.length === 0) return false;

      await tx.insert(prekeyBundles).values({
        userId: args.userId,
        registrationId: args.bundle.registrationId,
        signedPrekeyId: args.bundle.signedPreKeyId,
        signedPrekey: Buffer.from(args.bundle.signedPreKey, 'base64'),
        signedPrekeySig: Buffer.from(args.bundle.signedPreKeySig, 'base64'),
        prekeys: sql`${JSON.stringify(args.bundle.preKeys)}::jsonb`,
      });
      return true;
    });
  }

  async findById(userId: string): Promise<UserSummary | undefined> {
    const db = getDb();
    const rows = await db
      .select({
        id: users.id,
        publicKey: users.publicKey,
        createdAt: users.createdAt,
        selectedAvatarId: users.selectedAvatarId,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          id: row.id,
          publicKey: row.publicKey,
          createdAt: row.createdAt,
          selectedAvatarId: row.selectedAvatarId ?? undefined,
        }
      : undefined;
  }

  async findUserIdByDeviceToken(deviceToken: string): Promise<string | undefined> {
    const db = getDb();
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.deviceToken, deviceToken))
      .limit(1);
    return rows[0]?.id;
  }

  async setSelectedAvatar(userId: string, animalId: string | undefined): Promise<void> {
    const db = getDb();
    await db
      .update(users)
      .set({ selectedAvatarId: animalId ?? null })
      .where(eq(users.id, userId));
  }

  async deleteUser(userId: string): Promise<void> {
    const db = getDb();
    // Ordered to satisfy the non-cascading FKs back to `users.id`
    // (messages.sender_id, groups/communities.created_by,
    // community_key_envelopes.wrapped_by_user_id). The remaining
    // children — devices, prekey_bundles, *_members, recipient
    // envelopes — cascade off the final `users` delete.
    await db.transaction(async (tx) => {
      await tx
        .delete(messages)
        .where(or(eq(messages.senderId, userId), eq(messages.recipientId, userId)));
      await tx
        .delete(communityKeyEnvelopes)
        .where(eq(communityKeyEnvelopes.wrappedByUserId, userId));
      // Groups/communities the user created go too (cascades their
      // members + key envelopes) — the created_by FK doesn't cascade.
      await tx.delete(groups).where(eq(groups.createdBy, userId));
      await tx.delete(communities).where(eq(communities.createdBy, userId));
      await tx.delete(users).where(eq(users.id, userId));
    });
  }
}
