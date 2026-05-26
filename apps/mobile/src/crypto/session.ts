import type { ApiClient } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';

/**
 * Per-process cache of "we have a usable Signal session with this peer
 * — no need to call initiateSession again." Three ways an entry lands:
 *
 *   1. We initiated a session ourselves (via [ensureSessionWithPeer]).
 *   2. We decrypted an incoming message from the peer, which means
 *      their libsignal session has been established in our native
 *      store (PreKey message processing creates a session; subsequent
 *      Signal messages refresh it). The decrypt call site then calls
 *      [noteSessionEstablishedWith] to populate the cache.
 *   3. On cold-start-send-first, [ensureSessionWithPeer] asks the
 *      native module via `hasSession` whether a session row already
 *      exists on disk from a prior process. If yes, the cache is
 *      populated and the destructive re-init is skipped.
 *
 * Why the third branch matters: without it, a cold-started sender
 * whose first action is encrypting a message ends up calling
 * [ensureSessionWithPeer] with an empty in-process cache. The
 * fallback was to re-fetch the peer's PreKey bundle and call
 * `initiateSession` — which burns a fresh OTPK and produces a
 * PreKey-style ciphertext even though the on-disk session is already
 * past the handshake. The peer's libsignal store then rejects with
 * "invalid PreKey message: decryption failed". (The receive-side
 * branch — rc.58 — fixed the same failure for the receive-then-send
 * pattern; this fix closes the send-first gap.)
 *
 * Cleared by `clearSessionCache` (re-enrollment, sign-out, identity
 * rotation). Not persisted across cold starts — the `hasSession`
 * native check repopulates it on demand.
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
  // Cold-start-send-first guard: if the native store already has a
  // session row for this peer (from a prior process), don't re-init —
  // doing so would burn an OTPK and emit a PreKeySignalMessage the
  // peer can't decrypt. See the [initiatedPeers] docstring.
  if (await deps.signalProtocol.hasSession(deps.peerUserId)) {
    initiatedPeers.add(deps.peerUserId);
    return;
  }
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
