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
    requestFallback: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    submitFallbackOtp: vi.fn(async () => {
      throw new Error('not implemented');
    }),
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
      fallback: undefined,
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

  it('offers the email fallback when the passkey attempt fails, and resolves once the sheet completes it', async () => {
    const vouchflow = client();
    (vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('biometric_unavailable'),
    );
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    await Promise.resolve();
    useVerifySheet.getState().confirm();
    await flush();

    const sheetState = useVerifySheet.getState();
    expect(sheetState.fallback?.reason).toBe('biometric_unavailable');
    // The sheet never flickers closed between the passkey failure and
    // the fallback step — `pending` stays set the whole time.
    expect(sheetState.pending).toBeDefined();

    sheetState.resolveFallback('dvt_fallback');
    await expect(pending).resolves.toMatchObject({ deviceToken: 'dvt_fallback' });
    expect(useIdentity.getState().deviceToken).toBe('dvt_fallback');
    expect(useVerifySheet.getState().pending).toBeUndefined();
    expect(useVerifySheet.getState().fallback).toBeUndefined();
  });

  it('maps an unmapped Vouchflow error to the sdk_error fallback reason instead of dead-ending', async () => {
    const vouchflow = client();
    (vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('unknown_error'),
    );
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    await Promise.resolve();
    useVerifySheet.getState().confirm();
    await flush();

    expect(useVerifySheet.getState().fallback?.reason).toBe('sdk_error');

    // Settle it — an unresolved fallback would leave the module-level
    // `promptInFlight` singleton stuck for every test that follows.
    useVerifySheet.getState().resolveFallback('dvt_fallback');
    await pending;
  });

  it('keeps the sheet open through a stalled passkey attempt and offers the timeout fallback', async () => {
    vi.useFakeTimers();
    try {
      const vouchflow = client();
      (vouchflow.verify as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise<VerifyResult>(() => {}),
      );
      const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

      await Promise.resolve();
      useVerifySheet.getState().confirm();
      await flush();
      expect(useVerifySheet.getState().verificationInFlight).toBe(true);

      useVerifySheet.getState().cancel();
      expect(useVerifySheet.getState().pending).toBeDefined();

      await vi.advanceTimersByTimeAsync(60_000);
      await flush();
      expect(useVerifySheet.getState().fallback?.reason).toBe('attestation_timeout');
      expect(useVerifySheet.getState().verificationInFlight).toBe(false);

      useVerifySheet.getState().resolveFallback('dvt_fallback');
      await expect(pending).resolves.toMatchObject({ deviceToken: 'dvt_fallback' });
    } finally {
      vi.useRealTimers();
    }
  });

  // The two cancel-triggering tests below run last: `verify-device.ts`
  // tracks `lastCancelledAt` at module scope (a real 60s cooldown so a
  // "Not now" tap can't be immediately re-prompted), so any test after
  // one of these within the same file would otherwise see every
  // `request()` short-circuit into an immediate cancellation.

  it('does not call verify when the user cancels the sheet', async () => {
    const vouchflow = client();
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    await Promise.resolve();
    useVerifySheet.getState().cancel();
    await expect(pending).rejects.toBeInstanceOf(DeviceVerificationCancelledError);
    expect(vouchflow.verify).not.toHaveBeenCalled();
    expect(useVerifySheet.getState().pending).toBeUndefined();
  });

  it('rejects the caller if the user cancels during the fallback step', async () => {
    // Jump past the previous test's cancel cooldown — see the comment
    // above these two tests.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    try {
      const vouchflow = client();
      (vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new VouchflowClientError('biometric_unavailable'),
      );
      const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

      await Promise.resolve();
      useVerifySheet.getState().confirm();
      await flush();
      expect(useVerifySheet.getState().fallback).toBeDefined();

      useVerifySheet.getState().cancel();
      await expect(pending).rejects.toBeInstanceOf(DeviceVerificationCancelledError);
      expect(useVerifySheet.getState().pending).toBeUndefined();
      expect(useVerifySheet.getState().fallback).toBeUndefined();
      expect(useIdentity.getState().deviceToken).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('getDeviceTokenOrVerify', () => {
  beforeEach(() => {
    useVerifySheet.setState({
      pending: undefined,
      fallback: undefined,
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
