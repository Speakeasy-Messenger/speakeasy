import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';
import type { VerificationContext } from '@speakeasy/vouchflow';
import type { FallbackReason, VouchflowClient, VouchflowErrorReason } from '../native/vouchflow.js';
import { VouchflowClientError } from '../native/vouchflow.js';
import { diag } from '../diag/log.js';

/**
 * Onboarding claim orchestration, split out of `HandleStep.tsx` so the
 * attestation path, the email fallback, and the enroll they share are
 * unit-testable without a React renderer. `fallbackReasonFor` and
 * `completeEmailFallbackVerification` are also reused by the returning-
 * user surfaces (`VerifyGateScreen`, `VerifyDeviceSheet` via
 * `auth/verify-device.ts`) — every device-verification surface offers
 * the same email path rather than dead-ending.
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

export class VerificationTimeoutError extends Error {
  constructor() {
    super(`Timeout: verify did not complete in ${VERIFY_TIMEOUT_MS / 1000}s`);
    this.name = 'VerificationTimeoutError';
  }
}

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
  attestation_unavailable: 'attestation_unavailable',
  minimum_confidence_unmet: 'attestation_unavailable',
  enrollment_failed: 'attestation_unavailable',
  account_store_access_denied: 'attestation_unavailable',
};

/**
 * Retryable on the same device — never routes to the email fallback.
 * A cancelled or failed biometric prompt can be re-shown, and a flaky
 * network is a retry, not an un-attestable device. Every OTHER
 * `VouchflowErrorReason` (including ones Vouchflow adds later) is
 * "unmapped" and falls through to the email fallback via
 * `fallbackReasonFor` rather than dead-ending.
 */
const RETRY_ONLY: ReadonlySet<VouchflowErrorReason> = new Set([
  'biometric_cancelled',
  'biometric_failed',
  'network_unavailable',
]);

/**
 * Maps any Vouchflow SDK failure reason to the `FallbackReason`
 * forwarded to `requestFallback()`. Total (unlike `FALLBACK_ELIGIBLE`):
 * reasons with no dedicated mapping still resolve to `'sdk_error'` so
 * an unrecognized/unmapped SDK error can still offer the email path
 * instead of a retry-only dead end.
 */
export function fallbackReasonFor(reason: VouchflowErrorReason): FallbackReason {
  return FALLBACK_ELIGIBLE[reason] ?? 'sdk_error';
}

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
        setTimeout(() => reject(new VerificationTimeoutError()), VERIFY_TIMEOUT_MS),
      ),
    ]);
    deviceToken = verifyResult.deviceToken;
  } catch (err) {
    if (err instanceof VerificationTimeoutError) {
      // A wedged biometric sheet is exactly as un-attestable as an
      // explicit SDK error from the device's perspective — offer the
      // fallback instead of a retry-only dead end (the likely App
      // Store reviewer failure on a lock-less test device).
      diag('onboarding', 'attestation timed out — offering email fallback', {
        timeoutMs: VERIFY_TIMEOUT_MS,
      });
      return { kind: 'needs_email_fallback', reason: 'attestation_timeout', noLock: false };
    }
    if (err instanceof VouchflowClientError) {
      const reason = FALLBACK_ELIGIBLE[err.reason];
      if (reason) {
        diag('onboarding', 'attestation unavailable — offering email fallback', {
          reason: err.reason,
        });
        return { kind: 'needs_email_fallback', reason, noLock: false };
      }
      if (!RETRY_ONLY.has(err.reason)) {
        diag('onboarding', 'unmapped attestation error — offering email fallback', {
          reason: err.reason,
        });
        return { kind: 'needs_email_fallback', reason: fallbackReasonFor(err.reason), noLock: false };
      }
    }
    throw err;
  }

  try {
    const claimed = await enrollHandle(deps, { handle, deviceToken });
    return { kind: 'claimed', ...claimed };
  } catch (err) {
    // Handle conflicts are the one enroll failure the user can fix
    // themselves (pick another handle) — never switch to email for
    // those. Everything else — the server rejecting the token as
    // `low_confidence`/`device_not_found`, or any other unmapped
    // enroll failure — means this device+token pair can't complete
    // enrollment, so offer the fallback rather than a retry-only dead
    // end.
    if (err instanceof ApiError && err.status === 409 && (err.code === 'taken' || err.code === 'reserved')) {
      throw err;
    }
    if (err instanceof ApiError) {
      diag('onboarding', 'enroll failed — offering email fallback', {
        status: err.status,
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
 * Submit the emailed code and resolve the device token the verified
 * fallback session unlocks — the piece shared by every surface that
 * offers the email path (onboarding claims a handle with it; the
 * returning-user verify-gate and monthly re-verify sheet just need the
 * token itself).
 *
 * `FallbackVerificationResult` carries no deviceToken — the session it
 * verifies is what mints one. Read the SDK's cached token first (no
 * biometric, no attestation, which is the whole point of the fallback);
 * if the SDK hasn't cached one yet, ask verify() for it now that the
 * session is fallback-verified, at the same `low` floor the fallback
 * itself satisfies.
 */
export async function completeEmailFallbackVerification(
  deps: Pick<ClaimDeps, 'vouchflow'>,
  args: { sessionId: string; otp: string; context: VerificationContext },
): Promise<{ deviceToken: string }> {
  const result = await deps.vouchflow.submitFallbackOtp(args.sessionId, args.otp.trim());
  if (!result.verified) {
    throw new EmailFallbackError('otp_rejected');
  }

  let deviceToken = await deps.vouchflow.getCachedDeviceToken();
  if (!deviceToken) {
    try {
      const verified = await deps.vouchflow.verify({
        context: args.context,
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

  return { deviceToken };
}

/**
 * Onboarding's flavor of the above: also enrolls `handle` with the
 * resolved token, exactly as the attestation path does.
 */
export async function completeEmailFallbackClaim(
  deps: ClaimDeps,
  args: { handle: string; sessionId: string; otp: string },
): Promise<ClaimedIdentity> {
  const { deviceToken } = await completeEmailFallbackVerification(deps, {
    sessionId: args.sessionId,
    otp: args.otp,
    context: 'signup',
  });
  return enrollHandle(deps, { handle: args.handle, deviceToken });
}
