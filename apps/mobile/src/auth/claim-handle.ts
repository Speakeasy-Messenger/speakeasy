import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';
import type {
  FallbackReason,
  VouchflowClient,
  VouchflowErrorReason,
} from '../native/vouchflow.js';
import { VouchflowClientError } from '../native/vouchflow.js';
import { diag } from '../diag/log.js';

/**
 * Onboarding claim orchestration, split out of `HandleStep.tsx` so the
 * attestation path, the email fallback, and the enroll they share are
 * unit-testable without a React renderer.
 *
 * Two ways to reach `api.enroll`:
 *
 *   1. Device attestation — the default. `vouchflow.verify()` at the
 *      `low` confidence floor (matching the vouchflow.dev dashboard
 *      floor and the server's validator) mints the deviceToken.
 *   2. Email OTP fallback — Vouchflow SDK 2.0.0's own fallback tier
 *      (`requestFallback` / `submitFallbackOtp`). Only offered when the
 *      device cannot attest at all: no secure lock, or a verify() that
 *      failed even at `low` (the un-attestable review iPad). Email is
 *      never required for a device that can attest — Speakeasy stays
 *      anonymous by default.
 */

const PREKEY_BATCH_SIZE = 100;

/** verify() has no timeout of its own; a wedged biometric sheet would hang forever. */
const VERIFY_TIMEOUT_MS = 60_000;

function randomRegistrationId(): number {
  return 1 + Math.floor(Math.random() * 16380);
}

export interface ClaimDeps {
  api: Pick<ApiClient, 'enroll'>;
  signalProtocol: Pick<SignalProtocolModule, 'generateIdentityKey' | 'generatePreKeyBundle'>;
  vouchflow: VouchflowClient;
  /** `isDeviceSecure` from `native/lock-screen.js` — injected for tests. */
  isDeviceSecure: () => Promise<boolean>;
}

export interface ClaimedIdentity {
  userId: string;
  deviceToken: string;
}

export type ClaimResult =
  | ({ kind: 'claimed' } & ClaimedIdentity)
  /**
   * This device can't attest. The caller offers the email fallback
   * instead of dead-ending; `reason` is forwarded to `requestFallback`
   * so Vouchflow records why the fallback was used, and `noLock` says
   * whether a "Set up screen lock" affordance is also worth showing.
   */
  | { kind: 'needs_email_fallback'; reason: FallbackReason; noLock: boolean };

/**
 * Vouchflow failures that mean "this device cannot produce an
 * attestation" — the email fallback is the only way forward.
 *
 * `biometric_failed`, `biometric_cancelled`, and `network_unavailable`
 * are deliberately absent: a failed or cancelled biometric prompt can
 * be retried on a capable device, and a flaky network is also a retry,
 * not an un-attestable device.
 */
const FALLBACK_ELIGIBLE: Partial<Record<VouchflowErrorReason, FallbackReason>> = {
  biometric_unavailable: 'biometric_unavailable',
  minimum_confidence_unmet: 'attestation_unavailable',
  enrollment_failed: 'attestation_unavailable',
  account_store_access_denied: 'attestation_unavailable',
};

/**
 * Generate the Signal identity + prekey bundle and enroll `handle`
 * against `deviceToken`. Shared by both claim paths.
 *
 * Identity-key generation is kicked off in step 02; calling
 * `generateIdentityKey()` again is cheap — the native module is
 * idempotent and returns the same SQLCipher-backed key.
 */
export async function enrollHandle(
  deps: ClaimDeps,
  args: { handle: string; deviceToken: string },
): Promise<ClaimedIdentity> {
  const identityPublicKey = await deps.signalProtocol.generateIdentityKey();
  const registrationId = randomRegistrationId();
  const ownBundle = await deps.signalProtocol.generatePreKeyBundle({
    registrationId,
    signedPreKeyId: 1,
    oneTimePreKeyCount: PREKEY_BATCH_SIZE,
  });
  const { user_id } = await deps.api.enroll({
    token: args.deviceToken,
    user_id: args.handle,
    publicKey: identityPublicKey,
    preKeyBundle: {
      registrationId: ownBundle.registrationId,
      signedPreKeyId: ownBundle.signedPreKeyId,
      signedPreKey: ownBundle.signedPreKey,
      signedPreKeySig: ownBundle.signedPreKeySig,
      preKeys: ownBundle.preKeys,
    },
  });
  return { userId: user_id, deviceToken: args.deviceToken };
}

/**
 * The default path: attest the device, then enroll.
 *
 * Returns `needs_email_fallback` — never throws — for the two ways a
 * device can turn out to be un-attestable: no secure lock at all, or a
 * verify()/enroll that failed even at the `low` floor. Every other
 * failure (taken handle, cancelled prompt, network, identity-key gen)
 * throws so the caller can keep its existing error mapping.
 */
export async function claimWithDeviceAttestation(
  deps: ClaimDeps,
  handle: string,
): Promise<ClaimResult> {
  // Checked before the biometric prompt: with no secure lock the SDK
  // has no key material to attest with, so verify() would only dead-end.
  // The user can either set a lock up (the better fix, offered
  // alongside) or verify by email.
  if (!(await deps.isDeviceSecure())) {
    return { kind: 'needs_email_fallback', reason: 'biometric_unavailable', noLock: true };
  }

  let deviceToken: string;
  try {
    const verifyResult = await Promise.race([
      deps.vouchflow.verify({ context: 'signup', minimumConfidence: 'low' }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new VouchflowClientError(
                'biometric_unavailable',
                `Timeout: verify did not complete in ${VERIFY_TIMEOUT_MS / 1000}s`,
              ),
            ),
          VERIFY_TIMEOUT_MS,
        ),
      ),
    ]);
    deviceToken = verifyResult.deviceToken;
  } catch (err) {
    if (err instanceof VouchflowClientError) {
      const reason = FALLBACK_ELIGIBLE[err.reason];
      if (reason) {
        diag('onboarding', 'attestation unavailable — offering email fallback', {
          reason: err.reason,
        });
        return { kind: 'needs_email_fallback', reason, noLock: false };
      }
    }
    throw err;
  }

  try {
    const claimed = await enrollHandle(deps, { handle, deviceToken });
    return { kind: 'claimed', ...claimed };
  } catch (err) {
    // The server validates the deviceToken itself. `low_confidence`
    // should no longer fire (the floor is `low` on both sides), but a
    // device the server can't resolve at all is un-attestable in exactly
    // the same way — offer the fallback rather than dead-ending.
    if (
      err instanceof ApiError &&
      err.status === 401 &&
      (err.code === 'low_confidence' || err.code === 'device_not_found')
    ) {
      diag('onboarding', 'server rejected attestation — offering email fallback', {
        code: err.code,
      });
      return {
        kind: 'needs_email_fallback',
        reason: 'attestation_unavailable',
        noLock: !(await deps.isDeviceSecure()),
      };
    }
    throw err;
  }
}

export type EmailFallbackFailure = 'invalid_email' | 'otp_rejected' | 'no_device_token';

export class EmailFallbackError extends Error {
  constructor(
    public readonly reason: EmailFallbackFailure,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'EmailFallbackError';
  }
}

/**
 * Deliberately loose — Vouchflow is the authority on whether an address
 * can receive a code. This only catches obvious typos before we spend a
 * round trip on them.
 */
export function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/** Ask Vouchflow to email a one-time code. Returns the session to submit it against. */
export async function startEmailFallback(
  deps: Pick<ClaimDeps, 'vouchflow'>,
  args: { email: string; reason: FallbackReason },
): Promise<{ sessionId: string; expiresAt: string }> {
  const email = args.email.trim();
  if (!isLikelyEmail(email)) {
    throw new EmailFallbackError('invalid_email');
  }
  const result = await deps.vouchflow.requestFallback(email, args.reason);
  return { sessionId: result.fallbackSessionId, expiresAt: result.expiresAt };
}

/**
 * Submit the emailed code and enroll `handle` with the device token the
 * verified fallback session unlocks.
 *
 * `FallbackVerificationResult` carries no deviceToken — the session it
 * verifies is what mints one. Read the SDK's cached token first (no
 * biometric, no attestation, which is the whole point of the fallback);
 * if the SDK hasn't cached one yet, ask verify() for it now that the
 * session is fallback-verified.
 */
export async function completeEmailFallbackClaim(
  deps: ClaimDeps,
  args: { handle: string; sessionId: string; otp: string },
): Promise<ClaimedIdentity> {
  const result = await deps.vouchflow.submitFallbackOtp(args.sessionId, args.otp.trim());
  if (!result.verified) {
    throw new EmailFallbackError('otp_rejected');
  }

  let deviceToken = await deps.vouchflow.getCachedDeviceToken();
  if (!deviceToken) {
    try {
      const verified = await deps.vouchflow.verify({
        context: 'signup',
        minimumConfidence: 'low',
      });
      deviceToken = verified.deviceToken;
    } catch (err) {
      diag('onboarding', 'fallback verified but no device token', {
        msg: err instanceof Error ? err.message : String(err),
      });
      throw new EmailFallbackError(
        'no_device_token',
        err instanceof Error ? err.message : undefined,
      );
    }
  }

  return enrollHandle(deps, { handle: args.handle, deviceToken });
}
