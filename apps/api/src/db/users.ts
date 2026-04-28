export interface PreKey {
  id: number;
  key: string; // base64
}

export interface PreKeyBundleInput {
  registrationId: number;
  signedPreKeyId: number;
  /** base64 */
  signedPreKey: string;
  /** base64 */
  signedPreKeySig: string;
  preKeys: PreKey[];
}

export interface UserSummary {
  id: string;
  publicKey: Buffer;
  createdAt: Date;
}

export interface UserRepo {
  /**
   * Atomically create the user and their PreKey bundle.
   * Returns `false` if `userId` already exists (caller retries with a new id).
   */
  tryCreate(args: {
    userId: string;
    publicKey: Buffer;
    bundle: PreKeyBundleInput;
  }): Promise<boolean>;

  /** Look up a user. Returns undefined if not enrolled. */
  findById(userId: string): Promise<UserSummary | undefined>;
}
