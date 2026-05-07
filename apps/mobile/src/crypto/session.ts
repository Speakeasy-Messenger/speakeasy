import type { ApiClient } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';

/**
 * Per-process cache of "we have already called initiateSession for this
 * peer." The native libsignal store actually persists session state
 * (Phase 5c, SQLCipher-backed), but `initiateSession` consumes a
 * one-time prekey server-side every time it's called — so even though
 * the native store *would* tolerate a redundant init, we'd burn a fresh
 * OTPK from the peer's bundle on every send. This cache prevents that.
 *
 * Cleared by `clearSessionCache` (re-enrollment, sign-out, identity
 * rotation). Not persisted across cold starts: on reboot we ask the
 * native store via a probe-and-skip path inside [ensureSessionWithPeer]
 * — the native bridge is idempotent enough that a stale "no session"
 * belief just costs one extra OTPK on the next send.
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
