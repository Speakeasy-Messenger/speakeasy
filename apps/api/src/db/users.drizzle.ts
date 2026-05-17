import { eq, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { prekeyBundles, users } from './schema.js';
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

  async listAllUserIds(): Promise<string[]> {
    const db = getDb();
    const rows = await db.select({ id: users.id }).from(users);
    return rows.map((r) => r.id);
  }
}
