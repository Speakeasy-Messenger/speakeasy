import { fallbackReasonFor } from './claim-handle.js';
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

  promptInFlight = (async () => {
    await useVerifySheet.getState().request(reason);
    let deviceToken: string;
    try {
      const result = await vouchflow.verify({ context: 'login', minimumConfidence: 'low' });
      deviceToken = result.deviceToken;
      useVerifySheet.getState().finish();
    } catch (err) {
      const fallbackReason =
        err instanceof VouchflowClientError ? fallbackReasonFor(err.reason) : 'sdk_error';
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
