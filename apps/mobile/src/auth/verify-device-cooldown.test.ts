import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifyResult, VouchflowClient } from '../native/vouchflow.js';

/**
 * The re-prompt brake.
 *
 * Nothing used to bound how often the app could re-open the verify
 * sheet by itself: the cooldown armed on user cancel only, so a device
 * whose re-verification kept "succeeding" without satisfying the server
 * was re-prompted on every WS reconnect — at most 30s apart, forever
 * (`ws/client.ts` caps its backoff at 30s). That is the modal loop
 * `lake-late-trout` reported.
 *
 * `verify-device.ts` keeps the brake in module-level state, so each
 * test here loads a fresh copy of it (and of the stores it talks to)
 * rather than inheriting the previous test's cooldown.
 */

let minted = 0;

function client(): VouchflowClient {
  return {
    verify: vi.fn(async (): Promise<VerifyResult> => {
      minted++;
      return {
        verified: true,
        confidence: 'low',
        deviceToken: `dvt_${minted}`,
        deviceAgeDays: 1,
        networkVerifications: minted,
        firstSeen: null,
        context: 'login',
        fallbackUsed: false,
        signals: {
          biometricUsed: true,
          attestationVerified: true,
          persistentToken: true,
          crossAppHistory: false,
          anomalyFlags: [],
        },
      };
    }),
    getCachedDeviceToken: vi.fn(async () => null),
    requestFallback: vi.fn(async () => {
      throw new Error('not reached');
    }),
    submitFallbackOtp: vi.fn(async () => {
      throw new Error('not reached');
    }),
  };
}

interface Harness {
  verifyDeviceWithExplanation: typeof import('./verify-device.js').verifyDeviceWithExplanation;
  cancelledError: typeof import('./verify-device-types.js').DeviceVerificationCancelledError;
  stopTapping: () => void;
}

/**
 * Fresh `verify-device.ts` (and the store it drives) plus a stand-in
 * user who taps Continue as soon as the sheet appears.
 */
async function harness(): Promise<Harness> {
  vi.resetModules();
  const { useIdentity } = await import('../store/identity.js');
  const { useVerifySheet } = await import('../store/verify-sheet.js');
  const { DeviceVerificationCancelledError } = await import('./verify-device-types.js');
  const { verifyDeviceWithExplanation } = await import('./verify-device.js');

  useIdentity.setState({
    userId: 'lake-late-trout',
    deviceToken: undefined,
    deviceTokenIssuedAt: undefined,
    hydrated: true,
  });
  const stopTapping = useVerifySheet.subscribe((s) => {
    if (s.pending && !s.verificationInFlight && !s.fallback) {
      void Promise.resolve().then(() => useVerifySheet.getState().confirm());
    }
  });
  return {
    verifyDeviceWithExplanation,
    cancelledError: DeviceVerificationCancelledError,
    stopTapping,
  };
}

beforeEach(() => {
  minted = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('automatic re-verification brake', () => {
  it('refuses back-to-back automatic prompts and escalates the wait', async () => {
    const { verifyDeviceWithExplanation, cancelledError, stopTapping } = await harness();
    const vouchflow = client();

    // First WS-triggered re-attestation: allowed, prompts, succeeds.
    await expect(
      verifyDeviceWithExplanation(vouchflow, 'websocket_auth_failed'),
    ).resolves.toMatchObject({ deviceToken: 'dvt_1' });

    // The server still rejects the fresh credential, so the reconnect
    // ladder asks again 30s later. Re-attesting a 30-second-old
    // attestation cannot help — refuse without opening the sheet.
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(
      verifyDeviceWithExplanation(vouchflow, 'websocket_auth_failed'),
    ).rejects.toBeInstanceOf(cancelledError);
    expect(vouchflow.verify).toHaveBeenCalledTimes(1);

    // Past the first cooldown the user gets one more attempt...
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(verifyDeviceWithExplanation(vouchflow, 'launch_refresh')).resolves.toMatchObject({
      deviceToken: 'dvt_2',
    });

    // ...and the next wait is longer, so a device that never recovers
    // degrades to an occasional prompt instead of one every 30s.
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(
      verifyDeviceWithExplanation(vouchflow, 'websocket_auth_failed'),
    ).rejects.toBeInstanceOf(cancelledError);
    expect(vouchflow.verify).toHaveBeenCalledTimes(2);

    stopTapping();
  });

  it('never throttles a verification the user asked for', async () => {
    const { verifyDeviceWithExplanation, stopTapping } = await harness();
    const vouchflow = client();

    await expect(
      verifyDeviceWithExplanation(vouchflow, 'websocket_auth_failed'),
    ).resolves.toMatchObject({ deviceToken: 'dvt_1' });

    // Still inside the automatic cooldown — but the user just tapped
    // send. Their retry is always honoured; it cannot loop on its own.
    await expect(verifyDeviceWithExplanation(vouchflow, 'send_message')).resolves.toMatchObject({
      deviceToken: 'dvt_2',
    });

    stopTapping();
  });

  it('starts the escalation over once the loop has stopped', async () => {
    const { verifyDeviceWithExplanation, cancelledError, stopTapping } = await harness();
    const vouchflow = client();

    await expect(verifyDeviceWithExplanation(vouchflow, 'launch_refresh')).resolves.toMatchObject({
      deviceToken: 'dvt_1',
    });

    // A quiet day later this is a new incident, not a continuing loop:
    // the first retry must not inherit yesterday's escalation.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await expect(verifyDeviceWithExplanation(vouchflow, 'launch_refresh')).resolves.toMatchObject({
      deviceToken: 'dvt_2',
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(verifyDeviceWithExplanation(vouchflow, 'launch_refresh')).rejects.toBeInstanceOf(
      cancelledError,
    );
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(verifyDeviceWithExplanation(vouchflow, 'launch_refresh')).resolves.toMatchObject({
      deviceToken: 'dvt_3',
    });

    stopTapping();
  });
});
