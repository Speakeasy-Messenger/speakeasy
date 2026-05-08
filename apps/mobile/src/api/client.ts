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
  ): Promise<{ id: string; created_by: string }> {
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
  async createGroup(deviceToken: string): Promise<{ group_id: string }> {
    // No body. We DON'T send `content-type: application/json` because
    // Fastify with that header tries to parse the (empty) body as JSON
    // and fails with 400 Bad Request. The route doesn't read a body
    // anyway — caller is identified via the auth header.
    const res = await this.doFetch(`${this.baseUrl}/v1/groups`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${deviceToken}`,
      },
    });
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
