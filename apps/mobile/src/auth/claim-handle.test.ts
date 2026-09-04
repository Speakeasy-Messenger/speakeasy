import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { VouchflowClientError, type VerifyResult } from '../native/vouchflow.js';
import {
  claimWithDeviceAttestation,
  completeEmailFallbackClaim,
  EmailFallbackError,
  isLikelyEmail,
  startEmailFallback,
  type ClaimDeps,
} from './claim-handle.js';

function verifyResult(token = 'dvt_new', confidence: VerifyResult['confidence'] = 'low'): VerifyResult {
  return {
    verified: true,
    confidence,
    deviceToken: token,
    deviceAgeDays: 0,
    networkVerifications: 0,
    firstSeen: null,
    context: 'signup',
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

function makeDeps(overrides: Partial<ClaimDeps> = {}): ClaimDeps {
  return {
    api: { enroll: vi.fn(async () => ({ user_id: 'reviewer' })) },
    signalProtocol: {
      generateIdentityKey: vi.fn(async () => 'pk-base64'),
      generatePreKeyBundle: vi.fn(async () => ({
        registrationId: 12345,
        signedPreKeyId: 1,
        signedPreKey: 'spk',
        signedPreKeySig: 'sig',
        preKeys: [{ id: 1, key: 'opk' }],
      })),
    },
    vouchflow: {
      verify: vi.fn(async () => verifyResult()),
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
      getCachedDeviceToken: vi.fn(async () => null),
    },
    isDeviceSecure: vi.fn(async () => true),
    ...overrides,
  } as ClaimDeps;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('claimWithDeviceAttestation', () => {
  it('asks Vouchflow for the `low` confidence floor and enrolls', async () => {
    const deps = makeDeps();
    const result = await claimWithDeviceAttestation(deps, 'reviewer');

    expect(deps.vouchflow.verify).toHaveBeenCalledWith({
      context: 'signup',
      minimumConfidence: 'low',
    });
    expect(result).toEqual({ kind: 'claimed', userId: 'reviewer', deviceToken: 'dvt_new' });
    expect(deps.api.enroll).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'dvt_new', user_id: 'reviewer' }),
    );
  });

  it('enrolls a device that only reaches `low` confidence', async () => {
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      verifyResult('dvt_weak', 'low'),
    );
    const result = await claimWithDeviceAttestation(deps, 'reviewer');
    expect(result).toMatchObject({ kind: 'claimed', deviceToken: 'dvt_weak' });
  });

  it('offers the email fallback (and the lock deep link) when the device has no lock', async () => {
    const deps = makeDeps({ isDeviceSecure: vi.fn(async () => false) });
    const result = await claimWithDeviceAttestation(deps, 'reviewer');

    expect(result).toEqual({
      kind: 'needs_email_fallback',
      reason: 'biometric_unavailable',
      noLock: true,
    });
    // The lockless device must never reach the biometric prompt.
    expect(deps.vouchflow.verify).not.toHaveBeenCalled();
  });

  it.each([
    'biometric_unavailable',
    'minimum_confidence_unmet',
    'enrollment_failed',
    'account_store_access_denied',
  ] as const)('offers the email fallback when verify fails with %s', async (reason) => {
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError(reason),
    );
    const result = await claimWithDeviceAttestation(deps, 'reviewer');
    expect(result).toMatchObject({ kind: 'needs_email_fallback', noLock: false });
    expect(deps.api.enroll).not.toHaveBeenCalled();
  });

  it('rethrows a cancelled prompt instead of offering the fallback', async () => {
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('biometric_cancelled'),
    );
    await expect(claimWithDeviceAttestation(deps, 'reviewer')).rejects.toMatchObject({
      reason: 'biometric_cancelled',
    });
  });

  it('offers the email fallback when the server rejects the token as low confidence', async () => {
    const deps = makeDeps();
    (deps.api.enroll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(401, 'low_confidence'),
    );
    const result = await claimWithDeviceAttestation(deps, 'reviewer');
    expect(result).toMatchObject({ kind: 'needs_email_fallback' });
  });

  it('rethrows a taken handle so the caller can reset the input', async () => {
    const deps = makeDeps();
    (deps.api.enroll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(409, 'taken'),
    );
    await expect(claimWithDeviceAttestation(deps, 'reviewer')).rejects.toMatchObject({
      status: 409,
      code: 'taken',
    });
  });
});

describe('startEmailFallback', () => {
  it('forwards the address and the reason to the SDK', async () => {
    const deps = makeDeps();
    const out = await startEmailFallback(deps, {
      email: '  reviewer@example.com ',
      reason: 'biometric_unavailable',
    });
    expect(deps.vouchflow.requestFallback).toHaveBeenCalledWith(
      'reviewer@example.com',
      'biometric_unavailable',
    );
    expect(out.sessionId).toBe('fbs_1');
  });

  it('rejects an obviously malformed address without a round trip', async () => {
    const deps = makeDeps();
    await expect(
      startEmailFallback(deps, { email: 'nope', reason: 'biometric_unavailable' }),
    ).rejects.toMatchObject({ reason: 'invalid_email' });
    expect(deps.vouchflow.requestFallback).not.toHaveBeenCalled();
  });

  it('isLikelyEmail accepts ordinary addresses and rejects junk', () => {
    expect(isLikelyEmail('a@b.co')).toBe(true);
    expect(isLikelyEmail('a@b')).toBe(false);
    expect(isLikelyEmail('a b@c.co')).toBe(false);
    expect(isLikelyEmail('')).toBe(false);
  });
});

describe('completeEmailFallbackClaim', () => {
  it('enrolls with the token the verified session unlocks', async () => {
    const deps = makeDeps();
    (deps.vouchflow.getCachedDeviceToken as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      'dvt_fallback',
    );
    const claimed = await completeEmailFallbackClaim(deps, {
      handle: 'reviewer',
      sessionId: 'fbs_1',
      otp: ' 123456 ',
    });

    expect(deps.vouchflow.submitFallbackOtp).toHaveBeenCalledWith('fbs_1', '123456');
    expect(claimed).toEqual({ userId: 'reviewer', deviceToken: 'dvt_fallback' });
    expect(deps.api.enroll).toHaveBeenCalledWith(
      expect.objectContaining({ token: 'dvt_fallback', user_id: 'reviewer' }),
    );
  });

  it('falls back to verify() when the SDK has no cached token yet', async () => {
    const deps = makeDeps();
    const claimed = await completeEmailFallbackClaim(deps, {
      handle: 'reviewer',
      sessionId: 'fbs_1',
      otp: '123456',
    });
    expect(deps.vouchflow.verify).toHaveBeenCalledWith({
      context: 'signup',
      minimumConfidence: 'low',
    });
    expect(claimed).toEqual({ userId: 'reviewer', deviceToken: 'dvt_new' });
  });

  it('rejects a wrong code without enrolling', async () => {
    const deps = makeDeps();
    (deps.vouchflow.submitFallbackOtp as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      verified: false,
      confidence: 'low',
      sessionState: 'otp_pending',
      fallbackSignals: {
        ipConsistent: true,
        disposableEmailDomain: false,
        deviceHasPriorVerifications: false,
        emailDomainAgeDays: null,
        otpAttempts: 2,
        timeToCompleteSeconds: 30,
      },
    });
    await expect(
      completeEmailFallbackClaim(deps, { handle: 'reviewer', sessionId: 'fbs_1', otp: '000000' }),
    ).rejects.toBeInstanceOf(EmailFallbackError);
    expect(deps.api.enroll).not.toHaveBeenCalled();
  });

  it('surfaces `no_device_token` when neither the cache nor verify yields one', async () => {
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('biometric_unavailable'),
    );
    await expect(
      completeEmailFallbackClaim(deps, { handle: 'reviewer', sessionId: 'fbs_1', otp: '123456' }),
    ).rejects.toMatchObject({ reason: 'no_device_token' });
  });
});
