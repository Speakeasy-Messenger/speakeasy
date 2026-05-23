import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VouchflowClient, VerifyResult } from '../native/vouchflow.js';
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
    requestFallback: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    submitFallbackOtp: vi.fn(async () => {
      throw new Error('not implemented');
    }),
  };
}

describe('verifyDeviceWithExplanation', () => {
  beforeEach(() => {
    useIdentity.setState({
      userId: 'alice',
      deviceToken: undefined,
      deviceTokenIssuedAt: undefined,
      hydrated: true,
    });
    useVerifySheet.setState({ pending: undefined, nonce: 0 });
  });

  it('opens the verify sheet before calling Vouchflow verify', async () => {
    const vouchflow = client();
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    // Flush microtasks so the inner async IIFE schedules its request().
    await Promise.resolve();
    const sheetState = useVerifySheet.getState();
    expect(sheetState.pending?.reason).toBe('send_message');
    expect(vouchflow.verify).not.toHaveBeenCalled();

    sheetState.confirm();
    await expect(pending).resolves.toMatchObject({ deviceToken: 'dvt_new' });
    expect(vouchflow.verify).toHaveBeenCalledTimes(1);
    expect(useIdentity.getState().deviceToken).toBe('dvt_new');
    expect(useVerifySheet.getState().pending).toBeUndefined();
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
    useVerifySheet.setState({ pending: undefined, nonce: 0 });
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
