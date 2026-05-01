import type { PreKey, PreKeyBundleInput } from '../crypto/types.js';

export interface EnrollRequest {
  /** Vouchflow deviceToken from the SDK's verify() result. */
  token: string;
  /** base64 */
  publicKey: string;
  preKeyBundle: PreKeyBundleInput;
}

export interface EnrollResponse {
  user_id: string;
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
   * Phase 4: replace this user's one-time prekeys. The bundle must be
   * generated by the device's Signal Protocol native module — we don't
   * touch the secret material here. Caller's identity comes from the
   * `Authorization: Bearer <deviceToken>` header.
   */
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
