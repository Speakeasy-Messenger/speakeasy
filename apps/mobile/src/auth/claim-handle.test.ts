import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { VouchflowClientError, type VerifyResult } from '../native/vouchflow.js';
import { claimWithDeviceAttestation, fallbackReasonFor, type ClaimDeps } from './claim-handle.js';

function verifyResult(
  token = 'dvt_new',
  confidence: VerifyResult['confidence'] = 'low',
): VerifyResult {
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

  it('reports an unsupported device (and the lock deep link) when the device has no lock', async () => {
    const deps = makeDeps({ isDeviceSecure: vi.fn(async () => false) });
    const result = await claimWithDeviceAttestation(deps, 'reviewer');

    expect(result).toEqual({
      kind: 'unsupported_device',
      reason: 'biometric_unavailable',
      noLock: true,
    });
    // The lockless device must never reach the biometric prompt.
    expect(deps.vouchflow.verify).not.toHaveBeenCalled();
  });

  it.each([
    ['biometric_unavailable', 'biometric_unavailable'],
    ['attestation_unavailable', 'attestation_unavailable'],
    ['minimum_confidence_unmet', 'attestation_unavailable'],
    ['enrollment_failed', 'attestation_unavailable'],
    ['account_store_access_denied', 'attestation_unavailable'],
  ] as const)(
    'reports an unsupported device when verify fails with %s',
    async (reason, fallbackReason) => {
      const deps = makeDeps();
      (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new VouchflowClientError(reason),
      );
      const result = await claimWithDeviceAttestation(deps, 'reviewer');
      expect(result).toEqual({
        kind: 'unsupported_device',
        reason: fallbackReason,
        noLock: false,
      });
      expect(deps.api.enroll).not.toHaveBeenCalled();
    },
  );

  it('rethrows a cancelled prompt instead of offering the fallback', async () => {
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('biometric_cancelled'),
    );
    await expect(claimWithDeviceAttestation(deps, 'reviewer')).rejects.toMatchObject({
      reason: 'biometric_cancelled',
    });
  });

  it('rethrows a failed biometric prompt instead of offering the fallback', async () => {
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('biometric_failed'),
    );
    await expect(claimWithDeviceAttestation(deps, 'reviewer')).rejects.toMatchObject({
      reason: 'biometric_failed',
    });
  });

  it('reports an unsupported device for an unmapped SDK error instead of a retry-only dead end', async () => {
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new VouchflowClientError('unknown_error'),
    );
    const result = await claimWithDeviceAttestation(deps, 'reviewer');
    expect(result).toEqual({
      kind: 'unsupported_device',
      reason: 'sdk_error',
      noLock: false,
    });
    expect(deps.api.enroll).not.toHaveBeenCalled();
  });

  it('reports an unsupported device instead of a retry-only dead end when verification stalls', async () => {
    vi.useFakeTimers();
    const deps = makeDeps();
    (deps.vouchflow.verify as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<VerifyResult>(() => {}),
    );

    const claim = claimWithDeviceAttestation(deps, 'reviewer');
    const settled = expect(claim).resolves.toEqual({
      kind: 'unsupported_device',
      reason: 'attestation_timeout',
      noLock: false,
    });
    await vi.advanceTimersByTimeAsync(60_000);

    await settled;
    expect(deps.api.enroll).not.toHaveBeenCalled();
  });

  it('reports an unsupported device when the server rejects the token as low confidence', async () => {
    const deps = makeDeps();
    (deps.api.enroll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(401, 'low_confidence'),
    );
    const result = await claimWithDeviceAttestation(deps, 'reviewer');
    expect(result).toEqual({
      kind: 'unsupported_device',
      reason: 'attestation_unavailable',
      noLock: false,
    });
  });

  it('rethrows a taken handle so the caller can reset the input', async () => {
    const deps = makeDeps();
    (deps.api.enroll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(409, 'taken'));
    await expect(claimWithDeviceAttestation(deps, 'reviewer')).rejects.toMatchObject({
      status: 409,
      code: 'taken',
    });
  });

  it('rethrows a reserved handle so the caller can reset the input', async () => {
    const deps = makeDeps();
    (deps.api.enroll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(409, 'reserved'),
    );
    await expect(claimWithDeviceAttestation(deps, 'reviewer')).rejects.toMatchObject({
      status: 409,
      code: 'reserved',
    });
  });

  it('reports an unsupported device for an unmapped enroll failure instead of a retry-only dead end', async () => {
    const deps = makeDeps();
    (deps.api.enroll as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ApiError(500));
    const result = await claimWithDeviceAttestation(deps, 'reviewer');
    expect(result).toEqual({
      kind: 'unsupported_device',
      reason: 'attestation_unavailable',
      noLock: false,
    });
  });
});

describe('fallbackReasonFor', () => {
  it('maps known reasons and falls back to sdk_error for the rest', () => {
    expect(fallbackReasonFor('biometric_unavailable')).toBe('biometric_unavailable');
    expect(fallbackReasonFor('minimum_confidence_unmet')).toBe('attestation_unavailable');
    expect(fallbackReasonFor('no_session')).toBe('sdk_error');
    expect(fallbackReasonFor('unknown_error')).toBe('sdk_error');
  });
});
