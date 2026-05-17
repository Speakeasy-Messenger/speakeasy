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
  /**
   * The animal id the user picked in the avatar picker (post-Phase-2:
   * fox / owl / raven / hare / stag / whale / moth / octopus / heron /
   * bear / cat / bat). The mobile client renders the corresponding SVG
   * via `<PortraitTile kind="animal" id={...}>`.
   *
   * Undefined for users enrolled before Phase 2 OR users who haven't
   * yet reached onboarding's "Choose your face" screen — clients
   * fall back to a deterministic-from-userId default so the UI never
   * has to render an empty tile.
   *
   * AVATAR-SYSTEM.md §8: replaces the previous `avatarB64` JPEG-blob
   * field. Server doesn't store JPEG photos at all.
   */
  selectedAvatarId?: string;
}

export interface UserRepo {
  /**
   * Atomically create the user and their PreKey bundle.
   * Returns `false` if `userId` already exists (caller retries with a new id).
   * `deviceToken` is the Vouchflow-issued token; we persist it so
   * `findByDeviceToken` can resolve auth requests.
   */
  tryCreate(args: {
    userId: string;
    deviceToken: string;
    publicKey: Buffer;
    bundle: PreKeyBundleInput;
  }): Promise<boolean>;

  /** Look up a user. Returns undefined if not enrolled. */
  findById(userId: string): Promise<UserSummary | undefined>;

  /**
   * Resolve `deviceToken → userId`. Used by `requireAuth` when the
   * Vouchflow validator's `ValidatedAttestation.userId` is undefined
   * (real Vouchflow doesn't track our internal Speakeasy id; we own
   * that binding here). Returns undefined if no user has this token.
   */
  findUserIdByDeviceToken(deviceToken: string): Promise<string | undefined>;

  /**
   * Set the user's selected animal avatar. The route validates the id
   * against the known launch set; this method just upserts. Pass
   * `undefined` to clear (resetting back to the deterministic default
   * the client computes from userId).
   */
  setSelectedAvatar(userId: string, animalId: string | undefined): Promise<void>;
}
