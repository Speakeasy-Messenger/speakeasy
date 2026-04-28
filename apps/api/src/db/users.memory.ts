import type { PreKeyBundleInput, UserRepo, UserSummary } from './users.js';

interface Stored {
  publicKey: Buffer;
  bundle: PreKeyBundleInput;
  createdAt: Date;
}

/** In-memory repo for tests. Not safe for concurrent use across processes. */
export class InMemoryUserRepo implements UserRepo {
  readonly users = new Map<string, Stored>();

  async tryCreate(args: {
    userId: string;
    publicKey: Buffer;
    bundle: PreKeyBundleInput;
  }): Promise<boolean> {
    if (this.users.has(args.userId)) return false;
    this.users.set(args.userId, {
      publicKey: args.publicKey,
      bundle: args.bundle,
      createdAt: new Date(),
    });
    return true;
  }

  async findById(userId: string): Promise<UserSummary | undefined> {
    const u = this.users.get(userId);
    if (!u) return undefined;
    return { id: userId, publicKey: u.publicKey, createdAt: u.createdAt };
  }
}
