import { UNSUPPORTED_DEVICE_MESSAGE } from './unsupported-device.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VouchflowClient, VerifyResult } from '../native/vouchflow.js';
import { VouchflowClientError } from '../native/vouchflow.js';
import { useIdentity } from '../store/identity.js';
import { useVerifySheet } from '../store/verify-sheet.js';

import {
  DeviceVerificationCancelledError,
  getDeviceTokenOrVerify,
  verifyDeviceWithExplanation,
} from './verify-device.js';

function result(token = 'dvt_new'): VerifyResult {
  return {
    verified: true,
    confidence: 'medium',
    deviceToken: token,
    deviceAgeDays: 1,
    networkVerifications: 1,
    firstSeen: '2026-01-01T00:00:00Z',
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
}

function client(): VouchflowClient {
  return {
    verify: vi.fn(async () => result()),
    getCachedDeviceToken: vi.fn(async () => null),
  };
}

/** Flushes a handful of microtask turns — enough for the chained
 * `.then()`s in `verifyDeviceWithExplanation`'s IIFE and the store
 * promises it awaits to settle. */
async function flush(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('verifyDeviceWithExplanation', () => {
  beforeEach(() => {
    useIdentity.setState({
      userId: 'alice',
      deviceToken: undefined,
      deviceTokenIssuedAt: undefined,
      hydrated: true,
    });
    useVerifySheet.setState({
      pending: undefined,
      error: undefined,
      verificationInFlight: false,
      nonce: 0,
    });
  });

  it('opens the verify sheet, calls Vouchflow verify at the `low` floor, and dismisses on success', async () => {
    const vouchflow = client();
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    // Flush microtasks so the inner async IIFE schedules its request().
    await Promise.resolve();
    const sheetState = useVerifySheet.getState();
    expect(sheetState.pending?.reason).toBe('send_message');
    expect(vouchflow.verify).not.toHaveBeenCalled();

    sheetState.confirm();
    await expect(pending).resolves.toMatchObject({ deviceToken: 'dvt_new' });
    expect(vouchflow.verify).toHaveBeenCalledWith({ context: 'login', minimumConfidence: 'low' });
    expect(useIdentity.getState().deviceToken).toBe('dvt_new');
    expect(useVerifySheet.getState().pending).toBeUndefined();
  });

  it.each(['biometric_unavailable', 'attestation_unavailable', 'unknown_error'] as const)(
    'rejects %s, preserves the enrolled identity, and leaves the requirement visible',
    async (reason) => {
      const vouchflow = client();
      useIdentity.setState({ deviceToken: 'dvt_existing' });
      const failure = new VouchflowClientError(reason);
      vi.mocked(vouchflow.verify).mockRejectedValueOnce(failure);
      const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');
      const rejected = expect(pending).rejects.toBe(failure);
      useVerifySheet.getState().confirm();
      await rejected;
      expect(useVerifySheet.getState().error).toBe(UNSUPPORTED_DEVICE_MESSAGE);
      expect(useIdentity.getState().deviceToken).toBe('dvt_existing');
      expect(useIdentity.getState().userId).toBe('alice');
      useVerifySheet.getState().cancel();
      expect(useVerifySheet.getState().pending).toBeUndefined();
    },
  );

  it('settles a stalled verification after timeout and keeps the message dismissible', async () => {
    vi.useFakeTimers();
    try {
      const vouchflow = client();
      vi.mocked(vouchflow.verify).mockImplementation(() => new Promise(() => {}));
      const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');
      const rejected = expect(pending).rejects.toThrow('Timeout');
      useVerifySheet.getState().confirm();
      await flush();
      useVerifySheet.getState().cancel();
      expect(useVerifySheet.getState().pending).toBeDefined();
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(useVerifySheet.getState().error).toBe(UNSUPPORTED_DEVICE_MESSAGE);
      useVerifySheet.getState().cancel();
      expect(useVerifySheet.getState().pending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call verify when the user cancels the sheet', async () => {
    const vouchflow = client();
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    await Promise.resolve();
    useVerifySheet.getState().cancel();
    await expect(pending).rejects.toBeInstanceOf(DeviceVerificationCancelledError);
    expect(vouchflow.verify).not.toHaveBeenCalled();
    expect(useVerifySheet.getState().pending).toBeUndefined();
  });
});

describe('getDeviceTokenOrVerify', () => {
  beforeEach(() => {
    useVerifySheet.setState({
      pending: undefined,
      error: undefined,
      verificationInFlight: false,
      nonce: 0,
    });
  });

  it('returns the cached token without prompting', async () => {
    useIdentity.setState({
      userId: 'alice',
      deviceToken: 'dvt_cached',
      deviceTokenIssuedAt: Date.now(),
      hydrated: true,
    });
    const vouchflow = client();

    await expect(getDeviceTokenOrVerify(vouchflow, 'send_message')).resolves.toBe('dvt_cached');
    expect(useVerifySheet.getState().pending).toBeUndefined();
    expect(vouchflow.verify).not.toHaveBeenCalled();
  });
});
