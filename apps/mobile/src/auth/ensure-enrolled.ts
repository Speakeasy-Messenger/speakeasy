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
 *   1. Probe with `GET /v1/users/:id`. If 200, the binding is good.
 *   2. On 401 `not_enrolled`, silently re-enroll with the SAME handle
 *      + a fresh prekey bundle (same identity key — the native module
 *      persists it). This rebuilds the server-side row.
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
export async function ensureServerBinding(deps: {
  signalProtocol: SignalProtocolModule;
  vouchflow: VouchflowClient;
}): Promise<'ok' | 'reenrolled' | 'noop'> {
  const { userId, deviceToken } = useIdentity.getState();
  if (!userId || !deviceToken) return 'noop';

  // Quick auth probe. Any successful 2xx tells us the server knows us.
  try {
    await api.fetchUser(deviceToken, userId);
    diag('auth', 'server-binding probe OK', { userId });
    return 'ok';
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) {
      // Network / 5xx / 404 — leave alone. 404 specifically means the
      // user record is missing too; silent re-enroll will recreate it
      // via the same path we'd take on a 401, so fall through.
      if (!(err instanceof ApiError) || err.status !== 404) {
        diag('auth', 'server-binding probe error (skipping reenroll)', {
          status: (err as ApiError).status,
          code: (err as ApiError).code,
        });
        return 'noop';
      }
    }
  }

  diag('auth', 'server has forgotten this device — silent re-enroll', { userId });
  try {
    const identityPublicKey = await deps.signalProtocol.generateIdentityKey();
    const registrationId = randomRegistrationId();
    const ownBundle = await deps.signalProtocol.generatePreKeyBundle({
      registrationId,
      signedPreKeyId: 1,
      oneTimePreKeyCount: PREKEY_BATCH_SIZE,
    });

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
      // The handle already exists server-side — almost always the
      // user's OWN row (a transient probe 401 sent us down the
      // re-enroll path needlessly). NEVER destroy the identity over
      // this: keep it; the next probe / WS auth succeeds once the
      // token is fresh again.
      diag('auth', 're-enroll hit 409 taken — keeping identity intact', {
        userId,
      });
      return 'noop';
    }
    diag('auth', 'silent re-enroll FAILED (non-fatal)', {
      err: String(err),
      status: (err as ApiError | undefined)?.status,
      code: (err as ApiError | undefined)?.code,
    });
    return 'noop';
  }
}
