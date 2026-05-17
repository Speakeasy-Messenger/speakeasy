import type { PreKeyBundleInput, UserRepo, UserSummary } from './users.js';

interface Stored {
  publicKey: Buffer;
  bundle: PreKeyBundleInput;
  createdAt: Date;
  deviceToken: string;
  selectedAvatarId?: string;
}

/** In-memory repo for tests. Not safe for concurrent use across processes. */
export class InMemoryUserRepo implements UserRepo {
  readonly users = new Map<string, Stored>();
  /** Reverse index: deviceToken → userId. */
  private readonly byDeviceToken = new Map<string, string>();

  async tryCreate(args: {
    userId: string;
    deviceToken: string;
    publicKey: Buffer;
    bundle: PreKeyBundleInput;
  }): Promise<boolean> {
    if (this.users.has(args.userId)) return false;
    this.users.set(args.userId, {
      publicKey: args.publicKey,
      bundle: args.bundle,
      createdAt: new Date(),
      deviceToken: args.deviceToken,
    });
    this.byDeviceToken.set(args.deviceToken, args.userId);
    return true;
  }

  async findById(userId: string): Promise<UserSummary | undefined> {
    const u = this.users.get(userId);
    if (!u) return undefined;
    return {
      id: userId,
      publicKey: u.publicKey,
      createdAt: u.createdAt,
      selectedAvatarId: u.selectedAvatarId,
    };
  }

  async findUserIdByDeviceToken(deviceToken: string): Promise<string | undefined> {
    return this.byDeviceToken.get(deviceToken);
  }

  async setSelectedAvatar(userId: string, animalId: string | undefined): Promise<void> {
    const u = this.users.get(userId);
    if (!u) return; // caller's `requireAuth` already proved enrollment
    u.selectedAvatarId = animalId;
  }
}
