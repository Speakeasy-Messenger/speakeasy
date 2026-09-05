import { fallbackReasonFor, VerificationTimeoutError, verifyWithTimeout } from './claim-handle.js';
import { VouchflowClientError, type VouchflowClient } from '../native/vouchflow.js';
import { useIdentity } from '../store/identity.js';
import { useVerifySheet } from '../store/verify-sheet.js';
import { diag } from '../diag/log.js';
import {
  DeviceVerificationCancelledError,
  DeviceVerificationRequiredError,
  type VerificationReason,
} from './verify-device-types.js';

export {
  DeviceVerificationCancelledError,
  DeviceVerificationRequiredError,
} from './verify-device-types.js';
export type { VerificationReason } from './verify-device-types.js';

let promptInFlight: Promise<{ deviceToken: string }> | undefined;
let lastCancelledAt = 0;

const CANCEL_COOLDOWN_MS = 60_000;

/**
 * Reasons the app raises by itself, with no user gesture behind them.
 * Only these are throttled: they are the ones that can re-fire on a
 * timer (the WS reconnect ladder caps its backoff at 30s), so without a
 * brake a device that remains rejected is re-prompted indefinitely. A
 * verification the user asked for (sending a message, a group action)
 * cannot loop without them and is always honoured, preserving a usable
 * retry path.
 */
const AUTOMATIC_REASONS: ReadonlySet<VerificationReason> = new Set([
  'launch_refresh',
  'websocket_auth_failed',
  'missing_token',
]);

const AUTO_COOLDOWN_BASE_MS = 60_000;
const AUTO_COOLDOWN_MAX_MS = 15 * 60_000;

let autoCooldownUntil = 0;
let autoStreak = 0;

/**
 * Opens the branded verify sheet, attempts the passkey verify at the
 * `low` floor, and — never dead-ending a passkey-less device — falls
 * back to Vouchflow's email OTP path when that attempt fails. The sheet
 * stays open across both steps (see `store/verify-sheet.ts`); this
 * function is what drives the actual Vouchflow calls, exactly as it did
 * before the fallback existed, so it stays testable without a renderer.
 */
export async function verifyDeviceWithExplanation(
  vouchflow: VouchflowClient,
  reason: VerificationReason,
): Promise<{ deviceToken: string }> {
  if (promptInFlight) return promptInFlight;
  if (Date.now() - lastCancelledAt < CANCEL_COOLDOWN_MS) {
    throw new DeviceVerificationCancelledError();
  }
  const automatic = AUTOMATIC_REASONS.has(reason);
  if (automatic) {
    const now = Date.now();
    if (now < autoCooldownUntil) {
      diag('auth', 'automatic re-verification throttled', {
        reason,
        retryInMs: autoCooldownUntil - now,
      });
      throw new DeviceVerificationCancelledError();
    }
    // A gap longer than the longest cooldown means the previous loop
    // ended on its own — this is a new incident, not a continuation.
    if (now - autoCooldownUntil > AUTO_COOLDOWN_MAX_MS) autoStreak = 0;
  }

  promptInFlight = (async () => {
    await useVerifySheet.getState().request(reason);
    let deviceToken: string;
    try {
      const result = await verifyWithTimeout(vouchflow, {
        context: 'login',
        minimumConfidence: 'low',
      });
      deviceToken = result.deviceToken;
      useVerifySheet.getState().finish();
    } catch (err) {
      const fallbackReason =
        err instanceof VerificationTimeoutError
          ? 'attestation_timeout'
          : err instanceof VouchflowClientError
            ? fallbackReasonFor(err.reason)
            : 'sdk_error';
      diag('auth', 'monthly verify failed — offering email fallback', { reason: fallbackReason });
      // The sheet component drives the email round trip from here and
      // resolves this once it has a token — see `VerifyDeviceSheet.tsx`.
      deviceToken = await useVerifySheet.getState().requestFallback(fallbackReason);
    }
    useIdentity.getState().setDeviceToken(deviceToken);
    return { deviceToken };
  })();

  try {
    return await promptInFlight;
  } catch (err) {
    if (err instanceof DeviceVerificationCancelledError) {
      lastCancelledAt = Date.now();
    }
    throw err;
  } finally {
    promptInFlight = undefined;
    // Arm on every completed automatic attempt, success included: a
    // re-verification that "succeeds" and is then rejected again is
    // exactly what looped. Re-attesting a seconds-old attestation
    // cannot help either way, so back off before prompting again.
    if (automatic) {
      autoStreak++;
      autoCooldownUntil =
        Date.now() + Math.min(AUTO_COOLDOWN_MAX_MS, AUTO_COOLDOWN_BASE_MS * 2 ** (autoStreak - 1));
    }
  }
}

export async function getDeviceTokenOrVerify(
  vouchflow: VouchflowClient,
  reason: VerificationReason,
): Promise<string> {
  const cached = useIdentity.getState().deviceToken;
  if (cached) return cached;
  const result = await verifyDeviceWithExplanation(vouchflow, reason);
  return result.deviceToken;
}

export function getCachedDeviceTokenOrThrow(): string {
  const cached = useIdentity.getState().deviceToken;
  if (!cached) throw new DeviceVerificationRequiredError();
  return cached;
}
