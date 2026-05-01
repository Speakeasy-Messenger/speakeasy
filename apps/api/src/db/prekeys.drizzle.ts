import { eq, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { prekeyBundles, users } from './schema.js';
import type { PreKey } from './users.js';
import type { PreKeyRepo, PublicPreKeyBundle } from './prekeys.js';

export class DrizzlePreKeyRepo implements PreKeyRepo {
  async fetchBundleConsume(userId: string): Promise<PublicPreKeyBundle | undefined> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          userId: users.id,
          publicKey: users.publicKey,
          registrationId: prekeyBundles.registrationId,
          signedPreKeyId: prekeyBundles.signedPrekeyId,
          signedPrekey: prekeyBundles.signedPrekey,
          signedPrekeySig: prekeyBundles.signedPrekeySig,
          prekeys: prekeyBundles.prekeys,
        })
        .from(users)
        .innerJoin(prekeyBundles, eq(users.id, prekeyBundles.userId))
        .where(eq(users.id, userId))
        .limit(1);

      const row = rows[0];
      if (!row) return undefined;

      const prekeysArr = (row.prekeys ?? []) as PreKey[];
      const oneTimePreKey = prekeysArr.length > 0 ? prekeysArr.shift()! : null;
      const remainingPreKeys = prekeysArr.length;

      await tx
        .update(prekeyBundles)
        .set({ prekeys: sql`${JSON.stringify(prekeysArr)}::jsonb` })
        .where(eq(prekeyBundles.userId, userId));

      return {
        userId: row.userId,
        identityPublicKey: row.publicKey,
        registrationId: row.registrationId,
        signedPreKeyId: row.signedPreKeyId,
        signedPreKey: row.signedPrekey,
        signedPreKeySig: row.signedPrekeySig,
        oneTimePreKey,
        remainingPreKeys,
      };
    });
  }

  async replenish(args: {
    userId: string;
    signedPreKeyId: number;
    signedPreKey: string;
    signedPreKeySig: string;
    preKeys: PreKey[];
  }): Promise<void> {
    const db = getDb();
    await db
      .update(prekeyBundles)
      .set({
        signedPrekeyId: args.signedPreKeyId,
        signedPrekey: Buffer.from(args.signedPreKey, 'base64'),
        signedPrekeySig: Buffer.from(args.signedPreKeySig, 'base64'),
        prekeys: sql`${JSON.stringify(args.preKeys)}::jsonb`,
        updatedAt: sql`now()`,
      })
      .where(eq(prekeyBundles.userId, args.userId));
  }

  async countRemaining(userId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ prekeys: prekeyBundles.prekeys })
      .from(prekeyBundles)
      .where(eq(prekeyBundles.userId, userId))
      .limit(1);
    const row = rows[0];
    if (!row) return 0;
    return ((row.prekeys ?? []) as PreKey[]).length;
  }
}
