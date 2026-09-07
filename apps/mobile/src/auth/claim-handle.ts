import type { ApiClient } from '../api/client.js';
import { ApiError } from '../api/client.js';
import type { SignalProtocolModule } from '@speakeasy/crypto';
import type { VouchflowClient, VouchflowErrorReason } from '../native/vouchflow.js';
import { VouchflowClientError } from '../native/vouchflow.js';
import { diag } from '../diag/log.js';

const PREKEY_BATCH_SIZE = 100;

export const VERIFY_TIMEOUT_MS = 60_000;

export class VerificationTimeoutError extends Error {
  constructor() {
    super(`Timeout: verify did not complete in ${VERIFY_TIMEOUT_MS / 1000}s`);
    this.name = 'VerificationTimeoutError';
  }
}

export async function verifyWithTimeout(
  vouchflow: VouchflowClient,
  options: Parameters<VouchflowClient['verify']>[0],
): Promise<Awaited<ReturnType<VouchflowClient['verify']>>> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new VerificationTimeoutError()), VERIFY_TIMEOUT_MS);
  });

  try {
    return await Promise.race([vouchflow.verify(options), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function randomRegistrationId(): number {
  return 1 + Math.floor(Math.random() * 16380);
}

export interface ClaimDeps {
  api: Pick<ApiClient, 'enroll'>;
  signalProtocol: Pick<SignalProtocolModule, 'generateIdentityKey' | 'generatePreKeyBundle'>;
  vouchflow: VouchflowClient;
  isDeviceSecure: () => Promise<boolean>;
}

export interface ClaimedIdentity {
  userId: string;
  deviceToken: string;
}

export type ClaimResult = ({ kind: 'claimed' } & ClaimedIdentity) | { kind: 'unsupported_device' };

const RETRY_ONLY: ReadonlySet<VouchflowErrorReason> = new Set([
  'biometric_cancelled',
  'biometric_failed',
  'network_unavailable',
]);

export function isUnsupportedDeviceError(error: unknown): boolean {
  return (
    error instanceof VerificationTimeoutError ||
    (error instanceof VouchflowClientError && !RETRY_ONLY.has(error.reason))
  );
}

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

export async function claimWithDeviceAttestation(
  deps: ClaimDeps,
  handle: string,
): Promise<ClaimResult> {
  if (!(await deps.isDeviceSecure())) {
    return { kind: 'unsupported_device' };
  }

  let deviceToken: string;
  try {
    const verifyResult = await verifyWithTimeout(deps.vouchflow, {
      context: 'signup',
      minimumConfidence: 'low',
    });
    deviceToken = verifyResult.deviceToken;
  } catch (err) {
    if (isUnsupportedDeviceError(err)) return { kind: 'unsupported_device' };
    throw err;
  }

  try {
    const claimed = await enrollHandle(deps, { handle, deviceToken });
    return { kind: 'claimed', ...claimed };
  } catch (err) {
    if (
      err instanceof ApiError &&
      err.status === 409 &&
      (err.code === 'taken' || err.code === 'reserved')
    ) {
      throw err;
    }
    if (err instanceof ApiError) {
      diag('onboarding', 'enroll failed — device verification unavailable', {
        status: err.status,
        code: err.code,
      });
      return { kind: 'unsupported_device' };
    }
    throw err;
  }
}
