import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VouchflowClient, VerifyResult } from '../native/vouchflow.js';
import { VouchflowClientError } from '../native/vouchflow.js';
import {
  completeEmailFallbackVerification,
  fallbackReasonFor,
  startEmailFallback,
} from '../auth/claim-handle.js';
import { useIdentity } from '../store/identity.js';

/**
 * `VerifyGateScreen.tsx` is a thin React wrapper (this repo tests logic,
 * not RN renders — see `vitest.config.ts`) around exactly this
 * sequence: attempt the passkey `vouchflow.verify()` at the `low`
 * floor, and on failure — a passkey-less device is the "no-passkey"
 * case this fix closes — offer the email fallback via the same
 * `claim-handle.ts` functions onboarding uses, then set the device
 * token the same way the passkey path does. Setting that token is what
 * flips the router condition and unmounts the gate.
 */
function verifyResult(token: string): VerifyResult {
  return {
    verified: true,
    confidence: 'low',
    deviceToken: token,
    deviceAgeDays: 0,
    networkVerifications: 0,
    firstSeen: null,
    context: 'login',
    fallbackUsed: token !== 'dvt_passkey',
    signals: {
      biometricUsed: token === 'dvt_passkey',
      attestationVerified: token === 'dvt_passkey',
      persistentToken: true,
      crossAppHistory: false,
      anomalyFlags: [],
    },
  };
}

function client(): VouchflowClient {
  return {
    verify: vi.fn(async () => verifyResult('dvt_passkey')),
    requestFallback: vi.fn(async () => ({
      fallbackSessionId: 'fbs_1',
      expiresAt: '2026-09-03T12:00:00Z',
    })),
    submitFallbackOtp: vi.fn(async () => ({
      verified: true,
      confidence: 'low' as const,
      sessionState: 'verified',
      fallbackSignals: {
        ipConsistent: true,
        disposableEmailDomain: false,
        deviceHasPriorVerifications: false,
        emailDomainAgeDays: 4000,
        otpAttempts: 1,
        timeToCompleteSeconds: 12,
      },
    })),
    getCachedDeviceToken: vi.fn(async () => 'dvt_email_fallback'),
  };
}

describe('verify-gate: no-passkey device completes via the email fallback', () => {
  beforeEach(() => {
    useIdentity.setState({
      userId: 'reviewer',
      deviceToken: undefined,
      deviceTokenIssuedAt: undefined,
      hydrated: true,
    });
  });

  it('offers the email fallback when the passkey attempt fails, then sets the device token on completion', async () => {
    const vouchflow = client();
    (vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('biometric_unavailable'),
    );

    // 1. The passkey attempt fails — no-passkey device.
    let fallbackReason;
    try {
      await vouchflow.verify({ context: 'login', minimumConfidence: 'low' });
      throw new Error('expected verify() to reject');
    } catch (err) {
      fallbackReason =
        err instanceof VouchflowClientError ? fallbackReasonFor(err.reason) : 'sdk_error';
    }
    expect(fallbackReason).toBe('biometric_unavailable');

    // 2. Email path offered instead of a retry-only dead end.
    const { sessionId } = await startEmailFallback(
      { vouchflow },
      { email: 'reviewer@example.com', reason: fallbackReason },
    );
    expect(vouchflow.requestFallback).toHaveBeenCalledWith(
      'reviewer@example.com',
      'biometric_unavailable',
    );

    // 3. Completing it resolves the token at the `login` context — no
    // `enroll`, the account already exists — and sets it exactly as
    // the passkey path would.
    const { deviceToken } = await completeEmailFallbackVerification(
      { vouchflow },
      { sessionId, otp: '123456', context: 'login' },
    );
    expect(deviceToken).toBe('dvt_email_fallback');

    useIdentity.getState().setDeviceToken(deviceToken);

    // 4. This is what flips the router condition and unmounts the gate.
    expect(useIdentity.getState().deviceToken).toBe('dvt_email_fallback');
  });
});
