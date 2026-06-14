import { api } from '../services.js';
import { ApiError } from '../api/client.js';
import { useIdentity } from '../store/identity.js';
import { diag } from '../diag/log.js';
import { verifyDeviceWithExplanation } from './verify-device.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';
import type { VouchflowClient } from '../native/vouchflow.js';

const PREKEY_BATCH_SIZE = 100;

function randomRegistrationId(): number {
  return 1 + Math.floor(Math.random() * 16380);
}

/**
 * Ensure the server knows this device's `(deviceToken, userId)`
 * binding. The alpha sandbox runs in-memory and forgets every
 * enrollment on restart; without this, a user with a cached local
 * handle hits 401 `not_enrolled` on every authed request and the WS
 * loops forever in `reconnecting`.
 *
 * Strategy:
 *   1. Unless `forceReenroll`, probe with `GET /v1/users/:id`. If 200,
 *      we *might* be bound. Note that the REST endpoint validates the
 *      attestation + checks the user exists, but does NOT verify the
 *      `token → userId` binding the WS auth requires (see #2). So this
 *      probe is a cheap optimistic check, not a guarantee.
 *   2. On 401 `not_enrolled` (or `forceReenroll`), silently re-enroll
 *      with the SAME handle + a fresh prekey bundle (same identity key
 *      — the native module persists it). This rebuilds the server-side
 *      row. We always force when called from the WS's 4003
 *      not_enrolled close handler: by definition the WS just told us
 *      the binding is broken, so probing the REST endpoint (which is
 *      a false-positive sensor) would just leave the WS spinning.
 *   3. On 409 `taken` during re-enroll, leave the identity ALONE. The
 *      handle existing server-side is almost always the user's own row
 *      (a transient probe 401 sent us down the re-enroll path
 *      needlessly) — never destroy the account over it.
 *   4. On any other error (network, validator), bail silently — the
 *      user can retry by relaunching.
 *
 * Never wipes the local identity — that is reserved for explicit user
 * action (DeleteAccountScreen). Idempotent. Safe to call once on every
 * app boot before the WS connect.
 */
export interface EnsureServerBindingDeps {
  signalProtocol: SignalProtocolModule;
  vouchflow: VouchflowClient;
  /**
   * Skip the REST probe and go straight to the re-enroll path. Used
   * by the WS `onAuthRejected` callback: when the server closes the
   * socket with 4003 `not_enrolled` the binding is definitively
   * missing, and the probe would just return a false-positive 200.
   */
  forceReenroll?: boolean;
}

export async function ensureServerBinding(
  deps: EnsureServerBindingDeps,
): Promise<'ok' | 'reenrolled' | 'noop'> {
  const { userId, deviceToken } = useIdentity.getState();
  if (!userId || !deviceToken) return 'noop';

  if (!deps.forceReenroll) {
    // Quick optimistic probe. The endpoint doesn't actually verify
    // the WS-side binding (see strategy note above), so a 200 only
    // means "no obvious problem" — not "definitely bound."
    try {
      await api.fetchUser(deviceToken, userId);
      diag('auth', 'server-binding probe OK', { userId });
      return 'ok';
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) {
        // Network / 5xx / 404 — leave alone. 404 specifically means
        // the user record is missing too; silent re-enroll will
        // recreate it via the same path we'd take on a 401, so fall
        // through.
        if (!(err instanceof ApiError) || err.status !== 404) {
          diag('auth', 'server-binding probe error (skipping reenroll)', {
            status: (err as ApiError).status,
            code: (err as ApiError).code,
          });
          return 'noop';
        }
      }
    }
  }

  diag('auth', 'server has forgotten this device — silent re-enroll', {
    userId,
    forced: deps.forceReenroll === true,
  });
  // Hoisted outside the attempts so the 409-rebind path can reuse the
  // freshly-generated identity key + bundle. The rebind call uses these
  // values to reclaim the existing handle without regenerating keys
  // (regenerating would race the rebind's identity-match check).
  const identityPublicKey = await deps.signalProtocol.generateIdentityKey();
  const registrationId = randomRegistrationId();
  const ownBundle = await deps.signalProtocol.generatePreKeyBundle({
    registrationId,
    signedPreKeyId: 1,
    oneTimePreKeyCount: PREKEY_BATCH_SIZE,
  });
  const bundleInput = {
    registrationId: ownBundle.registrationId,
    signedPreKeyId: ownBundle.signedPreKeyId,
    signedPreKey: ownBundle.signedPreKey,
    signedPreKeySig: ownBundle.signedPreKeySig,
    preKeys: ownBundle.preKeys,
  };

  // One enroll → (on 409) rebind attempt with a given device token.
  //   'reenrolled'      — server-side binding rebuilt.
  //   'token_rejected'  — Vouchflow refused the TOKEN itself (enroll/rebind
  //                       401 with a non-identity reason, e.g.
  //                       `device_not_found`). The caller re-attests for a
  //                       fresh token and retries.
  //   'fail'            — terminal (identity_mismatch, network, 5xx). Keep
  //                       the local identity intact; never loop.
  const attempt = async (
    token: string,
  ): Promise<'reenrolled' | 'token_rejected' | 'fail'> => {
    try {
      await api.enroll({ token, user_id: userId, publicKey: identityPublicKey, preKeyBundle: bundleInput });
      diag('auth', 'silent re-enroll OK', { userId });
      return 'reenrolled';
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === 'taken') {
        // The handle exists server-side but the device-token binding is
        // stale (reinstall / Vouchflow rotation). Rebind: the server
        // verifies our identity publicKey still matches what's on file and
        // atomically swaps the token.
        diag('auth', 're-enroll hit 409 taken — trying device rebind', { userId });
        try {
          await api.rebindDevice({ token, user_id: userId, publicKey: identityPublicKey, preKeyBundle: bundleInput });
          diag('auth', 'device rebind OK after 409 taken', { userId });
          return 'reenrolled';
        } catch (rebindErr) {
          if (rebindErr instanceof ApiError && rebindErr.status === 401
              && rebindErr.code === 'identity_mismatch') {
            // Local Signal identity doesn't match the server's record for
            // this handle (wiped store, or someone else briefly held it).
            // Re-attesting can't fix this — keep identity intact, don't loop.
            diag('auth', 'device rebind rejected — identity_mismatch (handle unrecoverable on this device)', { userId });
            return 'fail';
          }
          if (rebindErr instanceof ApiError && rebindErr.status === 401) {
            // 401 with a different reason = the TOKEN was refused, not the
            // identity. Re-attest for a fresh one.
            diag('auth', 'device rebind: token refused', { code: rebindErr.code });
            return 'token_rejected';
          }
          diag('auth', 'device rebind FAILED (non-fatal)', {
            err: String(rebindErr),
            status: (rebindErr as ApiError | undefined)?.status,
            code: (rebindErr as ApiError | undefined)?.code,
          });
          return 'fail';
        }
      }
      // The enroll route only 401s from vouchflow.validate(), so any enroll
      // 401 means the device token was refused → re-attest.
      if (err instanceof ApiError && err.status === 401) {
        diag('auth', 'silent re-enroll: token refused', { code: err.code });
        return 'token_rejected';
      }
      diag('auth', 'silent re-enroll FAILED (non-fatal)', {
        err: String(err),
        status: (err as ApiError | undefined)?.status,
        code: (err as ApiError | undefined)?.code,
      });
      return 'fail';
    }
  };

  let outcome = await attempt(deviceToken);

  if (outcome === 'token_rejected') {
    // The stored device token is no longer valid against the server's
    // Vouchflow environment. The classic case is an alpha SANDBOX token
    // after the production cutover: the production endpoint never issued it,
    // so the server returns `device_not_found` forever. Nothing re-attests
    // the stored token on its own, so the account is stuck. Mint a FRESH
    // attestation (this prompts biometric, via the same explanation sheet
    // the WS-auth-failed path uses) and retry once. Capped at a single
    // re-attest so a genuinely failing attestation — e.g. a TLS
    // PinningFailure — can't turn into a biometric prompt loop.
    diag('auth', 'device token rejected — re-attesting for a fresh token', { userId });
    try {
      const fresh = await verifyDeviceWithExplanation(deps.vouchflow, 'websocket_auth_failed');
      // verifyDeviceWithExplanation already persists the new token via
      // useIdentity.setDeviceToken; pass it straight into the retry.
      outcome = await attempt(fresh.deviceToken);
    } catch (verifyErr) {
      diag('auth', 're-attestation FAILED (non-fatal)', { err: String(verifyErr) });
      return 'noop';
    }
  }

  return outcome === 'reenrolled' ? 'reenrolled' : 'noop';
}
