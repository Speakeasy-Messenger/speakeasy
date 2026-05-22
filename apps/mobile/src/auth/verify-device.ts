import { Alert } from 'react-native';
import type { VerifyResult, VouchflowClient } from '../native/vouchflow.js';
import { useIdentity } from '../store/identity.js';

type VerificationReason =
  | 'launch_refresh'
  | 'websocket_auth_failed'
  | 'missing_token'
  | 'send_message'
  | 'group_action';

let promptInFlight: Promise<VerifyResult> | undefined;
let lastCancelledAt = 0;

const CANCEL_COOLDOWN_MS = 60_000;

export class DeviceVerificationRequiredError extends Error {
  constructor(message = 'Device verification is required') {
    super(message);
    this.name = 'DeviceVerificationRequiredError';
  }
}

export class DeviceVerificationCancelledError extends Error {
  constructor() {
    super('Device verification was cancelled');
    this.name = 'DeviceVerificationCancelledError';
  }
}

export async function verifyDeviceWithExplanation(
  vouchflow: VouchflowClient,
  reason: VerificationReason,
): Promise<VerifyResult> {
  if (promptInFlight) return promptInFlight;
  if (Date.now() - lastCancelledAt < CANCEL_COOLDOWN_MS) {
    throw new DeviceVerificationCancelledError();
  }

  promptInFlight = (async () => {
    await confirmVerification(reason);
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

function confirmVerification(reason: VerificationReason): Promise<void> {
  const detail = detailForReason(reason);
  return new Promise((resolve, reject) => {
    Alert.alert(
      'Verify this device',
      `${detail}\n\nSpeakeasy uses Vouchflow to prove this is still your device before it can send encrypted traffic. Your passkey prompt will open only after you tap Continue.`,
      [
        {
          text: 'Not now',
          style: 'cancel',
          onPress: () => reject(new DeviceVerificationCancelledError()),
        },
        {
          text: 'Continue',
          onPress: () => resolve(),
        },
      ],
    );
  });
}

function detailForReason(reason: VerificationReason): string {
  switch (reason) {
    case 'launch_refresh':
      return 'Your device verification is old enough that Speakeasy should refresh it before background sync continues.';
    case 'websocket_auth_failed':
      return 'The server rejected the current device session, so Speakeasy needs a fresh verification before realtime messages can reconnect.';
    case 'missing_token':
      return 'Speakeasy could not find a cached device session for this install.';
    case 'send_message':
      return 'Speakeasy needs a verified device session before it can send this message.';
    case 'group_action':
      return 'Speakeasy needs a verified device session before it can update this room.';
  }
}
