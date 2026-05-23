import type { VerifyResult, VouchflowClient } from '../native/vouchflow.js';
import { useIdentity } from '../store/identity.js';
import { useVerifySheet } from '../store/verify-sheet.js';
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

let promptInFlight: Promise<VerifyResult> | undefined;
let lastCancelledAt = 0;

const CANCEL_COOLDOWN_MS = 60_000;

export async function verifyDeviceWithExplanation(
  vouchflow: VouchflowClient,
  reason: VerificationReason,
): Promise<VerifyResult> {
  if (promptInFlight) return promptInFlight;
  if (Date.now() - lastCancelledAt < CANCEL_COOLDOWN_MS) {
    throw new DeviceVerificationCancelledError();
  }

  promptInFlight = (async () => {
    await useVerifySheet.getState().request(reason);
    const result = await vouchflow.verify({ context: 'login' });
    useIdentity.getState().setDeviceToken(result.deviceToken);
    return result;
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
