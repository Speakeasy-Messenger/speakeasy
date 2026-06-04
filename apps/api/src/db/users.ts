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
  /**
   * "Refuse video calls" — per-user privacy setting (#13). When true the
   * call-router rejects inbound video offers before ringing, and the
   * capability aggregation drops 'video' from `supported_call_kinds`.
   * Defaults to false (video accepted) for users enrolled before #13.
   */
  refuseVideo?: boolean;
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
   * Rotate the device-token binding for an existing user. Used by
   * `POST /v1/devices/rebind` when a re-installed device needs to
   * reclaim its account: enroll's tryCreate returns false (409
   * taken), but the user still owns the handle because their Signal
   * identity key matches the one persisted on enrollment.
   *
   * Outcomes:
   *   - `no_such_user` — userId isn't enrolled (404).
   *   - `identity_mismatch` — the `expectedPublicKey` the caller
   *     proves they have doesn't match what we persisted. Refuse
   *     the rebind: the caller doesn't own this account (401).
   *   - `ok` — atomically swap the device-token and replace the
   *     prekey bundle. The next WS auth from the new token resolves
   *     to this userId.
   *
   * The prekey bundle is rewritten because the local Signal store
   * regenerates the pre-keys on reinstall — sending the old bundle
   * after a rebind would route every fresh DM through a prekey the
   * client no longer has a private half for.
   *
   * Safety: this method ONLY trusts `expectedPublicKey` matching
   * the stored identity key. Vouchflow's biometric proof gates the
   * route, not this method.
   */
  rebindDevice(args: {
    userId: string;
    newDeviceToken: string;
    expectedPublicKey: Buffer;
    bundle: PreKeyBundleInput;
  }): Promise<'ok' | 'no_such_user' | 'identity_mismatch'>;

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

  /** Set the per-user "Refuse video calls" flag (#13). Upsert-style; the
   * route gates auth. */
  setRefuseVideo(userId: string, refuse: boolean): Promise<void>;

  /**
   * Permanently delete a user and everything tied to them — devices,
   * prekey bundle, group/community memberships, key envelopes, and
   * buffered messages to/from them. Groups and communities the user
   * created are deleted too (their members lose them). Frees the
   * handle for reuse. Backs `DELETE /v1/users/me`.
   */
  deleteUser(userId: string): Promise<void>;
}
