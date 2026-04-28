import type { PreKey } from './users.js';
import type { PreKeyRepo, PublicPreKeyBundle } from './prekeys.js';
import type { InMemoryUserRepo } from './users.memory.js';

/**
 * In-memory PreKey repo backed by an InMemoryUserRepo. Mutates the user's
 * stored bundle on consume / replenish. Tests only.
 */
export class InMemoryPreKeyRepo implements PreKeyRepo {
  constructor(private readonly users: InMemoryUserRepo) {}

  async fetchBundleConsume(userId: string): Promise<PublicPreKeyBundle | undefined> {
    const stored = this.users.users.get(userId);
    if (!stored) return undefined;
    const oneTime = stored.bundle.preKeys.shift() ?? null;
    return {
      userId,
      identityPublicKey: stored.publicKey,
      registrationId: stored.bundle.registrationId,
      signedPreKeyId: stored.bundle.signedPreKeyId,
      signedPreKey: Buffer.from(stored.bundle.signedPreKey, 'base64'),
      signedPreKeySig: Buffer.from(stored.bundle.signedPreKeySig, 'base64'),
      oneTimePreKey: oneTime,
      remainingPreKeys: stored.bundle.preKeys.length,
    };
  }

  async replenish(args: {
    userId: string;
    signedPreKeyId: number;
    signedPreKey: string;
    signedPreKeySig: string;
    preKeys: PreKey[];
  }): Promise<void> {
    const stored = this.users.users.get(args.userId);
    if (!stored) throw new Error(`replenish: user ${args.userId} not found`);
    stored.bundle = {
      registrationId: stored.bundle.registrationId,
      signedPreKeyId: args.signedPreKeyId,
      signedPreKey: args.signedPreKey,
      signedPreKeySig: args.signedPreKeySig,
      preKeys: args.preKeys,
    };
  }

  async countRemaining(userId: string): Promise<number> {
    return this.users.users.get(userId)?.bundle.preKeys.length ?? 0;
  }
}
