import type { PreKey, PreKeyBundleInput } from '../crypto/types.js';

export interface EnrollRequest {
  /** Vouchflow deviceToken from the SDK's verify() result. */
  token: string;
  /** Caller-chosen handle (no `@` prefix). The server re-validates
   * format + reserved + uniqueness; on conflict you get
   * `ApiError(409, 'taken')` and should prompt the user for another. */
  user_id: string;
  /** base64 */
  publicKey: string;
  preKeyBundle: PreKeyBundleInput;
}

export interface EnrollResponse {
  user_id: string;
}

export type AvailabilityReason = 'invalid' | 'reserved' | 'taken';

export interface AvailabilityResponse {
  available: boolean;
  reason?: AvailabilityReason;
}

/** Phase 4 — server returns this from prekey endpoints when caller is low. */
export interface PreKeyReplenishRequest {
  signedPreKeyId: number;
  /** base64 */
  signedPreKey: string;
  /** base64 */
  signedPreKeySig: string;
  preKeys: PreKey[];
}

export interface PreKeyReplenishResponse {
  remaining_prekeys: number;
  low_water: boolean;
}

/**
 * Server response from `POST /v1/prekeys/bundle`. The server already
 * consumed exactly one one-time prekey, so `one_time_prekey` is either
 * `{id, key}` or absent. Wire shape mirrors the route in
 * `apps/api/src/routes/prekeys.ts`.
 */
export interface PreKeyBundleResponse {
  user_id: string;
  identity_public_key: string;
  registration_id: number;
  signed_prekey_id: number;
  signed_prekey: string;
  signed_prekey_sig: string;
  one_time_prekey?: { id: number; key: string };
  remaining_prekeys: number;
  low_water: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`API error ${status}${code ? `: ${code}` : ''}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Override fetch (for tests). Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const f = opts.fetchImpl ?? globalThis.fetch;
    if (!f) throw new Error('No fetch implementation available');
    this.doFetch = f.bind(globalThis);
  }

  async enroll(body: EnrollRequest): Promise<EnrollResponse> {
    const res = await this.doFetch(`${this.baseUrl}/v1/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 201) {
      return (await res.json()) as EnrollResponse;
    }
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /**
   * Fetch group metadata (creator). Member-only; outsiders get 403.
   *
   * Phase 2 brand overhaul: dropped the `avatar_b64` field. Groups
   * don't have photos OR custom marks — the mobile client renders the
   * deterministic geometric room mark from `groupId` on the fly.
   */
  async fetchGroup(
    deviceToken: string,
    groupId: string,
  ): Promise<{ id: string; created_by: string; name: string | null }> {
    const res = await this.doFetch(
      `${this.baseUrl}/v1/groups/${encodeURIComponent(groupId)}`,
      { headers: { authorization: `Bearer ${deviceToken}` } },
    );
    if (res.status !== 200) {
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        code = j?.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as {
      id: string;
      created_by: string;
      name: string | null;
    };
  }


  // setGroupAvatar removed in Phase 2 — groups don't have photos OR
  // custom marks. The mobile client renders the room mark from the
  // group id locally; nothing to PUT.

  /**
   * Set or clear the caller's selected animal avatar. `animalId` is
   * one of the launch-set ids (fox / owl / raven / hare / stag /
   * whale / moth / octopus / heron / bear / cat / bat). Pass `null`
   * to clear — the next render falls back to a deterministic-from-
   * userId default per `defaultAnimalForUser`.
   *
   * Phase 2 brand overhaul: replaces the previous `setAvatar(b64)`
   * JPEG-blob path. Server doesn't store JPEGs at all.
   */
  async setAvatar(deviceToken: string, animalId: string | null): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/v1/users/me/avatar`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${deviceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ animal_id: animalId }),
    });
    if (res.status !== 204) {
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        code = j?.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
  }

  /**
   * Fetch a peer's public-key + their selected animal id. The
   * profiles store calls this to lazy-populate `selectedAvatarId`
   * for rendering remote portrait tiles.
   *
   * Phase 2 brand overhaul: response shape changed —
   * `avatar_b64` (JPEG blob) → `selected_avatar_id` (string).
   */
  async fetchUser(
    deviceToken: string,
    userId: string,
  ): Promise<{
    id: string;
    public_key: string;
    created_at: string;
    selected_avatar_id: string | null;
  }> {
    const res = await this.doFetch(`${this.baseUrl}/v1/users/${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    if (res.status !== 200) {
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: string };
        code = j?.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as {
      id: string;
      public_key: string;
      created_at: string;
      selected_avatar_id: string | null;
    };
  }

  /**
   * Fresh-install identity recovery. Calls `GET /v1/users/me` with the
   * Vouchflow-attested deviceToken; server returns the user_id bound
   * to that token (404 if none). Mobile uses this to skip onboarding
   * after a reinstall — the device's hardware-anchored Vouchflow
   * attestation survives the app being deleted, and the server's
   * `users.device_token` index resolves it back to the original
   * userId.
   *
   * Returns `null` on 404 (genuinely no user) or any auth/network
   * error — caller falls through to onboarding rather than blocking.
   */
  async fetchMe(
    deviceToken: string,
  ): Promise<
    | {
        id: string;
        public_key: string;
        created_at: string;
        selected_avatar_id: string | null;
      }
    | null
  > {
    try {
      const res = await this.doFetch(`${this.baseUrl}/v1/users/me`, {
        headers: { authorization: `Bearer ${deviceToken}` },
      });
      if (res.status === 200) {
        return (await res.json()) as {
          id: string;
          public_key: string;
          created_at: string;
          selected_avatar_id: string | null;
        };
      }
      if (res.status === 404) return null;
      // 401/500/etc — don't restore identity from a flaky probe;
      // let onboarding take over and the user can retry.
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Delete the current device, forcing re-enrollment.
   * Used when identity recovery fails due to missing local keys.
   */
  async deleteMyDevice(deviceToken: string): Promise<void> {
    await this.doFetch(`${this.baseUrl}/v1/devices/${deviceToken}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
  }

  /**
   * Permanently delete the caller's account server-side — frees the
   * handle and removes all server-held data. Backs Delete Account.
   * Throws `ApiError` on a non-2xx response.
   */
  async deleteAccount(deviceToken: string): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/v1/users/me`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    if (res.status !== 200) {
      throw new ApiError(res.status, 'delete_account_failed');
    }
  }

  /**
   * Check whether a candidate handle is available for enrollment.
   * Returns the same shape as the server: `{available, reason?}` where
   * `reason` is one of `'invalid' | 'reserved' | 'taken'`.
   * The race between this call and the actual enroll is closed by the
   * atomic `tryCreate` server-side, so the UI must still handle a
   * `taken` failure on enroll.
   */
  async checkAvailability(handle: string): Promise<AvailabilityResponse> {
    const res = await this.doFetch(
      `${this.baseUrl}/v1/users/availability?id=${encodeURIComponent(handle)}`,
    );
    if (res.status !== 200) {
      throw new ApiError(res.status);
    }
    return (await res.json()) as AvailabilityResponse;
  }

  /**
   * Create a new group. Caller becomes the first member; add others via
   * `addGroupMember`. Returns the assigned `group_id`.
   */
  async createGroup(
    deviceToken: string,
    name?: string,
  ): Promise<{ group_id: string }> {
    // rc.48: pass `name` through so invitees see the room's display
    // name when they receive metadata via fetchGroup. Pre-rc.48 the
    // name was a client-only field and never propagated.
    //
    // Empty/omitted name omits the body entirely so the legacy "no
    // content-type" form still parses cleanly server-side.
    const trimmed = name?.trim();
    const init: RequestInit = trimmed
      ? {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deviceToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ name: trimmed }),
        }
      : {
          method: 'POST',
          headers: {
            authorization: `Bearer ${deviceToken}`,
          },
        };
    const res = await this.doFetch(`${this.baseUrl}/v1/groups`, init);
    if (res.status === 201) return (await res.json()) as { group_id: string };
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /**
   * Add a member to an existing group. Caller must already be a member.
   * Returns the post-add member count.
   */
  async addGroupMember(
    deviceToken: string,
    groupId: string,
    userId: string,
  ): Promise<{ members: number }> {
    const res = await this.doFetch(`${this.baseUrl}/v1/groups/${groupId}/members`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ user_id: userId }),
    });
    if (res.status === 201) return (await res.json()) as { members: number };
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /**
   * List the roster of a group. Members-only. Returns the members and
   * the original creator (so the UI can show a "creator" badge on
   * their row, and so non-creators can hide the kick affordances).
   */
  async listGroupMembers(
    deviceToken: string,
    groupId: string,
  ): Promise<{ members: string[]; created_by: string }> {
    const res = await this.doFetch(
      `${this.baseUrl}/v1/groups/${encodeURIComponent(groupId)}/members`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${deviceToken}` },
      },
    );
    if (res.status === 200)
      return (await res.json()) as { members: string[]; created_by: string };
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /**
   * Remove a member from a group. Creator-only on the server. The
   * server refuses to evict the creator themselves
   * (`cannot_remove_creator` → 409). Returns the post-remove count.
   */
  async removeGroupMember(
    deviceToken: string,
    groupId: string,
    userId: string,
  ): Promise<{ members: number }> {
    const res = await this.doFetch(
      `${this.baseUrl}/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
        headers: { authorization: `Bearer ${deviceToken}` },
      },
    );
    if (res.status === 200) return (await res.json()) as { members: number };
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /** Creator-only room rename. Returns the authoritative server value. */
  async setGroupName(
    deviceToken: string,
    groupId: string,
    name: string,
  ): Promise<{ id: string; created_by: string; name: string | null }> {
    const res = await this.doFetch(
      `${this.baseUrl}/v1/groups/${encodeURIComponent(groupId)}/name`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify({ name }),
      },
    );
    if (res.status === 200) {
      return (await res.json()) as {
        id: string;
        created_by: string;
        name: string | null;
      };
    }
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /**
   * Leave a group. The server handles creator transfer or room deletion;
   * the mobile client removes the local room after this succeeds.
   */
  async leaveGroup(
    deviceToken: string,
    groupId: string,
  ): Promise<{ members: number; created_by: string | null; deleted: boolean }> {
    const res = await this.doFetch(
      `${this.baseUrl}/v1/groups/${encodeURIComponent(groupId)}/leave`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${deviceToken}` },
      },
    );
    if (res.status === 200) {
      return (await res.json()) as {
        members: number;
        created_by: string | null;
        deleted: boolean;
      };
    }
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /**
   * Fetch a peer's PreKey bundle so we can establish a Signal session.
   * Server consumes one OTPK on the way out; the response includes a
   * `low_water` flag the *peer's* device acts on next time it auths.
   */
  async fetchPreKeyBundle(
    deviceToken: string,
    peerUserId: string,
  ): Promise<PreKeyBundleResponse> {
    const res = await this.doFetch(`${this.baseUrl}/v1/prekeys/bundle`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ user_id: peerUserId }),
    });
    if (res.status === 200) {
      return (await res.json()) as PreKeyBundleResponse;
    }
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /**
   * Phase 5d: register this device's FCM/APNs push token with the server
   * so the server can send a notify-only push when the recipient has no
   * live WebSocket. Must be called after enrollment (deviceToken is
   * required in the auth header).
   */
  /**
   * Submit user-typed feedback (addressed to @feedback in the chat
   * UI). NOT end-to-end — this is the explicit non-E2E channel for
   * "send a bug report to the dev team". Server stores the row in the
   * `feedback` table; opt-in by user, surfaced as a banner in the chat.
   */
  async submitFeedback(
    deviceToken: string,
    text: string,
    appVersion?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { text };
    if (appVersion) body.app_version = appVersion;
    const res = await this.doFetch(`${this.baseUrl}/v1/feedback`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 200) return;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  async registerPushToken(
    deviceToken: string,
    pushToken: string,
    platform: 'ios' | 'android',
    notificationPrivacy?: 'rich' | 'private',
  ): Promise<void> {
    const body: Record<string, unknown> = { push_token: pushToken, platform };
    if (notificationPrivacy !== undefined) body.notification_privacy = notificationPrivacy;
    const res = await this.doFetch(`${this.baseUrl}/v1/devices/push-token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 200) return;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  /** Report a push registration failure to the server for remote diagnosis. */
  async reportPushError(
    deviceToken: string,
    error: string,
  ): Promise<void> {
    const res = await this.doFetch(`${this.baseUrl}/v1/devices/push-error`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify({ error }),
    });
    if (res.status === 200) return;
    /* best-effort — don't throw */
  }

  /**
   * Phase 4: replace this user's one-time prekeys. The bundle must be
   * generated by the device's Signal Protocol native module — we don't
   * touch the secret material here. Caller's identity comes from the
   * `Authorization: Bearer <deviceToken>` header.
   */
  /**
   * Voice-call ICE servers — short-lived TURN credentials gated by
   * Vouchflow auth. Call right before `RTCPeerConnection` setup; the
   * returned tokens typically last ~1 hour.
   */
  async fetchTurnCredentials(
    deviceToken: string,
  ): Promise<
    Array<{ urls: string | string[]; username?: string; credential?: string }>
  > {
    const res = await this.doFetch(`${this.baseUrl}/v1/turn/credentials`, {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
    });
    if (res.status === 200) {
      const j = (await res.json()) as {
        ice_servers: Array<{ urls: string | string[]; username?: string; credential?: string }>;
      };
      return j.ice_servers;
    }
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }

  async replenishPreKeys(
    deviceToken: string,
    body: PreKeyReplenishRequest,
  ): Promise<PreKeyReplenishResponse> {
    const res = await this.doFetch(`${this.baseUrl}/v1/prekeys/replenish`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deviceToken}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 200) {
      return (await res.json()) as PreKeyReplenishResponse;
    }
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string };
      code = j?.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }
}
