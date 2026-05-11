import type { ApiClient } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';

/**
 * Per-process cache of "we have a usable Signal session with this peer
 * — no need to call initiateSession again." Two ways an entry lands:
 *
 *   1. We initiated a session ourselves (via [ensureSessionWithPeer]).
 *   2. We decrypted an incoming message from the peer, which means
 *      their libsignal session has been established in our native
 *      store (PreKey message processing creates a session; subsequent
 *      Signal messages refresh it). The decrypt call site then calls
 *      [noteSessionEstablishedWith] to populate the cache.
 *
 * Why the receive-side branch matters (rc.58 bug fix): without it, a
 * cold-started callee who decrypts a call_offer ends up calling
 * [ensureSessionWithPeer] to encrypt the call_answer. With an empty
 * cache, ensureSessionWithPeer re-initiates from the caller's PreKey
 * bundle even though a session already exists in libsignal — burns a
 * fresh OTPK and produces a PreKey-style ciphertext. The caller's
 * libsignal store then rejects it ("invalid PreKey message:
 * decryption failed") because their session is already advanced past
 * the PreKey handshake. Marking the peer after decrypt closes that
 * gap for any receive-then-send pattern within the same process.
 *
 * Cleared by `clearSessionCache` (re-enrollment, sign-out, identity
 * rotation). Not persisted across cold starts: on the next reboot,
 * the first inbound decrypt repopulates. The cold-start-send-first
 * case (no prior decrypt this process) still re-initiates — covered
 * by a future `hasSession` native bridge.
 */
const initiatedPeers = new Set<string>();

export function clearSessionCache(): void {
  initiatedPeers.clear();
}

/** Drop the in-process "session initiated" mark for a single peer.
 * Called by the identity-reset recovery path so the next call to
 * [ensureSessionWithPeer] re-fetches the peer's PreKey bundle and
 * re-initiates against their freshly-rotated identity. */
export function clearSessionCacheFor(peerUserId: string): void {
  initiatedPeers.delete(peerUserId);
}

/**
 * Mark `peerUserId` as having an established Signal session in this
 * process. Call this after any successful `signalProtocol.decrypt`
 * for the peer — it suppresses the next [ensureSessionWithPeer] from
 * destructively re-initiating against the peer's PreKey bundle.
 *
 * Idempotent. Safe to call from every decrypt site.
 */
export function noteSessionEstablishedWith(peerUserId: string): void {
  initiatedPeers.add(peerUserId);
}

/**
 * Make sure a Signal session exists with `peerUserId`. If we have not
 * yet initiated this process-lifetime, fetch the peer's PreKey bundle
 * from the server (`POST /v1/prekeys/bundle`) and call
 * `signalProtocol.initiateSession`. No-op on subsequent calls.
 *
 * Throws:
 *   - `ApiError` for 404 (peer not enrolled) or rate-limit failures.
 *   - `SignalClientError` for `untrusted_identity` (peer's identity key
 *     changed) — UI should surface a key-change warning before retrying.
 */
export async function ensureSessionWithPeer(deps: {
  api: ApiClient;
  signalProtocol: SignalProtocolModule;
  deviceToken: string;
  peerUserId: string;
}): Promise<void> {
  if (initiatedPeers.has(deps.peerUserId)) return;
  const bundle = await deps.api.fetchPreKeyBundle(deps.deviceToken, deps.peerUserId);
  await deps.signalProtocol.initiateSession(deps.peerUserId, {
    identityPublicKey: bundle.identity_public_key,
    registrationId: bundle.registration_id,
    signedPreKeyId: bundle.signed_prekey_id,
    signedPreKey: bundle.signed_prekey,
    signedPreKeySig: bundle.signed_prekey_sig,
    preKeys: bundle.one_time_prekey ? [bundle.one_time_prekey] : [],
  });
  initiatedPeers.add(deps.peerUserId);
}
