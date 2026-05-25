import { api } from '../services.js';
import { ApiError } from '../api/client.js';
import { useIdentity } from '../store/identity.js';
import { diag } from '../diag/log.js';
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
  // Hoisted outside the try so the 409-rebind path in the catch can
  // reuse the freshly-generated identity key + bundle. The catch
  // arm calls `api.rebindDevice` with these values to reclaim the
  // existing handle without regenerating keys (regenerating would
  // race the rebind's identity-match check).
  const identityPublicKey = await deps.signalProtocol.generateIdentityKey();
  const registrationId = randomRegistrationId();
  const ownBundle = await deps.signalProtocol.generatePreKeyBundle({
    registrationId,
    signedPreKeyId: 1,
    oneTimePreKeyCount: PREKEY_BATCH_SIZE,
  });

  try {
    await api.enroll({
      token: deviceToken,
      user_id: userId,
      publicKey: identityPublicKey,
      preKeyBundle: {
        registrationId: ownBundle.registrationId,
        signedPreKeyId: ownBundle.signedPreKeyId,
        signedPreKey: ownBundle.signedPreKey,
        signedPreKeySig: ownBundle.signedPreKeySig,
        preKeys: ownBundle.preKeys,
      },
    });
    diag('auth', 'silent re-enroll OK', { userId });
    return 'reenrolled';
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.code === 'taken') {
      // The handle exists server-side but the device-token binding
      // is stale (typical after a reinstall / Vouchflow rotation).
      // Try the rebind path: server verifies our identity publicKey
      // still matches what's on file, and if so, atomically swaps
      // the token. If our local Signal identity DIFFERS (a wiped
      // SQLCipher store) the server returns 401 identity_mismatch
      // and we surface the same `noop` keep-identity behavior the
      // prior code path used.
      diag('auth', 're-enroll hit 409 taken — trying device rebind', {
        userId,
      });
      try {
        // Use the same identityPublicKey we just generated for the
        // failed enroll attempt above; if we got here the local
        // Signal store opened successfully so this key matches the
        // one persisted on the original enrollment.
        await api.rebindDevice({
          token: deviceToken,
          user_id: userId,
          publicKey: identityPublicKey,
          preKeyBundle: {
            registrationId: ownBundle.registrationId,
            signedPreKeyId: ownBundle.signedPreKeyId,
            signedPreKey: ownBundle.signedPreKey,
            signedPreKeySig: ownBundle.signedPreKeySig,
            preKeys: ownBundle.preKeys,
          },
        });
        diag('auth', 'device rebind OK after 409 taken', { userId });
        return 'reenrolled';
      } catch (rebindErr) {
        if (rebindErr instanceof ApiError && rebindErr.status === 401
            && rebindErr.code === 'identity_mismatch') {
          // The local Signal identity does NOT match what the server
          // has for this handle. Either the user wiped data and is
          // trying to recover (handle isn't recoverable without the
          // original key), or someone else briefly held this handle.
          // Keep the local identity intact — destroying it wouldn't
          // help — and surface the original "keep identity intact"
          // behavior so the UI doesn't loop.
          diag('auth', 'device rebind rejected — identity_mismatch (handle unrecoverable on this device)', {
            userId,
          });
          return 'noop';
        }
        diag('auth', 'device rebind FAILED (non-fatal)', {
          err: String(rebindErr),
          status: (rebindErr as ApiError | undefined)?.status,
          code: (rebindErr as ApiError | undefined)?.code,
        });
        return 'noop';
      }
    }
    diag('auth', 'silent re-enroll FAILED (non-fatal)', {
      err: String(err),
      status: (err as ApiError | undefined)?.status,
      code: (err as ApiError | undefined)?.code,
    });
    return 'noop';
  }
}
