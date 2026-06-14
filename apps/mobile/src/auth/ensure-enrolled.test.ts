import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdentity } from '../store/identity.js';

// Mock services.ts so we don't drag the real ApiClient / native
// VouchflowSDK / CachingVouchflowClient into the test process.
const apiMock = {
  fetchUser: vi.fn(),
  enroll: vi.fn(),
  rebindDevice: vi.fn(),
};
vi.mock('../services.js', () => ({
  get api() {
    return apiMock;
  },
}));

// Mock the device-verification flow so the re-attest path doesn't drag in
// the native Vouchflow SDK / verify sheet.
const verifyMock = vi.fn();
vi.mock('./verify-device.js', () => ({
  verifyDeviceWithExplanation: (...args: unknown[]) => verifyMock(...args),
}));

import { ensureServerBinding } from './ensure-enrolled.js';
import { ApiError } from '../api/client.js';
import { useToast } from '../store/toast.js';
import { DeviceVerificationCancelledError } from './verify-device-types.js';

const signalProtocol = {
  generateIdentityKey: vi.fn(async () => 'pk-base64'),
  generatePreKeyBundle: vi.fn(async () => ({
    registrationId: 12345,
    signedPreKeyId: 1,
    signedPreKey: 'spk',
    signedPreKeySig: 'sig',
    preKeys: [],
  })),
} as unknown as Parameters<typeof ensureServerBinding>[0]['signalProtocol'];

const vouchflow = {} as unknown as Parameters<typeof ensureServerBinding>[0]['vouchflow'];

beforeEach(() => {
  apiMock.fetchUser.mockReset();
  apiMock.enroll.mockReset();
  apiMock.rebindDevice.mockReset();
  verifyMock.mockReset();
  useToast.setState({ message: undefined, nonce: 0 });
  useIdentity.setState({
    userId: 'silent-golden-hawk',
    deviceToken: 'dvt_test',
    deviceTokenIssuedAt: Date.now(),
  });
});

afterEach(() => {
  useIdentity.getState().reset();
});

describe('ensureServerBinding', () => {
  it('returns "ok" when the probe succeeds and does not re-enroll', async () => {
    apiMock.fetchUser.mockResolvedValueOnce({ id: 'silent-golden-hawk' });
    const result = await ensureServerBinding({ signalProtocol, vouchflow });
    expect(result).toBe('ok');
    expect(apiMock.fetchUser).toHaveBeenCalledOnce();
    expect(apiMock.enroll).not.toHaveBeenCalled();
  });

  it('re-enrolls on a 401 from the probe', async () => {
    apiMock.fetchUser.mockRejectedValueOnce(new ApiError(401, 'not_enrolled'));
    apiMock.enroll.mockResolvedValueOnce(undefined);
    const result = await ensureServerBinding({ signalProtocol, vouchflow });
    expect(result).toBe('reenrolled');
    expect(apiMock.enroll).toHaveBeenCalledOnce();
  });

  it('with forceReenroll=true, SKIPS the probe and re-enrolls directly', async () => {
    // The WS just told us the binding is broken; the REST probe is a
    // false-positive sensor (returns 200 even when WS-side binding is
    // gone). Forcing skips the wasted round-trip and the false signal.
    apiMock.enroll.mockResolvedValueOnce(undefined);
    const result = await ensureServerBinding({
      signalProtocol,
      vouchflow,
      forceReenroll: true,
    });
    expect(result).toBe('reenrolled');
    expect(apiMock.fetchUser).not.toHaveBeenCalled();
    expect(apiMock.enroll).toHaveBeenCalledOnce();
  });

  it('on 409 "taken", tries rebind and reports "reenrolled" on success', async () => {
    apiMock.enroll.mockRejectedValueOnce(new ApiError(409, 'taken'));
    apiMock.rebindDevice.mockResolvedValueOnce({ user_id: 'silent-golden-hawk' });
    const result = await ensureServerBinding({
      signalProtocol,
      vouchflow,
      forceReenroll: true,
    });
    expect(result).toBe('reenrolled');
    expect(apiMock.rebindDevice).toHaveBeenCalledOnce();
    // The rebind call MUST carry the same publicKey + bundle as the
    // failed enroll — that's the proof the server uses to confirm
    // we still own the handle.
    const rebindArgs = apiMock.rebindDevice.mock.calls[0]?.[0];
    expect(rebindArgs.user_id).toBe('silent-golden-hawk');
    expect(rebindArgs.publicKey).toBe('pk-base64');
    expect(rebindArgs.token).toBe('dvt_test');
  });

  it('on 409 "taken" + rebind 401 "identity_mismatch", keeps identity intact', async () => {
    // The user wiped local data; their fresh Signal identity doesn't
    // match what the server has on file. Rebind refuses (correctly —
    // we'd be letting any biometric-passing device steal the handle).
    apiMock.enroll.mockRejectedValueOnce(new ApiError(409, 'taken'));
    apiMock.rebindDevice.mockRejectedValueOnce(
      new ApiError(401, 'identity_mismatch'),
    );
    const result = await ensureServerBinding({
      signalProtocol,
      vouchflow,
      forceReenroll: true,
    });
    expect(result).toBe('noop');
    // Identity should remain intact in the store — we must NOT
    // destroy a working local identity over an unrecoverable handle.
    expect(useIdentity.getState().userId).toBe('silent-golden-hawk');
  });

  it('on 409 "taken" + rebind generic failure, returns "noop"', async () => {
    // E.g., server 500 during rebind. Don't loop, don't destroy
    // identity — same shape as the original 409 keep-intact path.
    apiMock.enroll.mockRejectedValueOnce(new ApiError(409, 'taken'));
    apiMock.rebindDevice.mockRejectedValueOnce(new ApiError(500, 'internal'));
    const result = await ensureServerBinding({
      signalProtocol,
      vouchflow,
      forceReenroll: true,
    });
    expect(result).toBe('noop');
  });

  // --- sandbox→production migration: stale token re-attestation ---

  it('re-attests for a fresh token when enroll 401s device_not_found, then re-enrolls', async () => {
    // The stored token is a stale alpha SANDBOX token; the production
    // server returns device_not_found. The recovery must mint a FRESH
    // attestation and retry — without it, the account is stuck forever.
    apiMock.enroll
      .mockRejectedValueOnce(new ApiError(401, 'device_not_found'))
      .mockResolvedValueOnce(undefined); // retry with the fresh token
    verifyMock.mockResolvedValueOnce({ deviceToken: 'dvt_fresh_prod' });

    const result = await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(result).toBe('reenrolled');
    expect(verifyMock).toHaveBeenCalledOnce();
    expect(apiMock.enroll).toHaveBeenCalledTimes(2);
    // The retry must carry the freshly-minted token, not the stale one.
    expect(apiMock.enroll.mock.calls[1]?.[0].token).toBe('dvt_fresh_prod');
  });

  it('re-attests, then rebinds on 409 taken with the fresh token (existing-account recovery)', async () => {
    // fuertechino's exact case: handle already exists in the (shared) DB,
    // so the fresh-token enroll hits 409 → rebind with the fresh token +
    // matching identity succeeds.
    apiMock.enroll
      .mockRejectedValueOnce(new ApiError(401, 'device_not_found'))
      .mockRejectedValueOnce(new ApiError(409, 'taken'));
    verifyMock.mockResolvedValueOnce({ deviceToken: 'dvt_fresh_prod' });
    apiMock.rebindDevice.mockResolvedValueOnce({ user_id: 'silent-golden-hawk' });

    const result = await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(result).toBe('reenrolled');
    expect(apiMock.rebindDevice.mock.calls[0]?.[0].token).toBe('dvt_fresh_prod');
  });

  it('caps re-attestation at one — does NOT loop if the fresh token is also rejected', async () => {
    // If attestation itself is broken (e.g. a TLS PinningFailure that still
    // somehow yields a token), the fresh token gets rejected too. We must
    // give up with "noop", not re-attest forever (biometric prompt loop).
    apiMock.enroll
      .mockRejectedValueOnce(new ApiError(401, 'device_not_found'))
      .mockRejectedValueOnce(new ApiError(401, 'device_not_found'));
    verifyMock.mockResolvedValueOnce({ deviceToken: 'dvt_fresh_prod' });

    const result = await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(result).toBe('noop');
    expect(verifyMock).toHaveBeenCalledOnce(); // exactly once, no loop
  });

  it('returns "noop" if re-attestation itself fails (e.g. PinningFailure / cancelled)', async () => {
    apiMock.enroll.mockRejectedValueOnce(new ApiError(401, 'device_not_found'));
    verifyMock.mockRejectedValueOnce(new Error('VouchflowError$PinningFailure'));

    const result = await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(result).toBe('noop');
    // Identity must remain intact — never destroyed over a failed re-attest.
    expect(useIdentity.getState().userId).toBe('silent-golden-hawk');
  });

  // --- error UX: never fail silently on a re-attest failure (v1.0.8) ---

  it('shows a toast when re-attestation throws a real error (e.g. device_not_owned)', async () => {
    apiMock.enroll.mockRejectedValueOnce(new ApiError(401, 'device_not_found'));
    verifyMock.mockRejectedValueOnce(
      new Error('ServerError(statusCode=403, code=device_not_owned)'),
    );

    await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    // The "press Continue, nothing happens" regression: the user must get
    // visible feedback, not a silent noop.
    expect(useToast.getState().message).toMatch(/verify this device/i);
  });

  it('does NOT toast when the user explicitly cancels the verify prompt', async () => {
    apiMock.enroll.mockRejectedValueOnce(new ApiError(401, 'device_not_found'));
    verifyMock.mockRejectedValueOnce(new DeviceVerificationCancelledError());

    await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(useToast.getState().message).toBeUndefined();
  });

  it('shows a toast when the fresh token is still server-rejected', async () => {
    apiMock.enroll
      .mockRejectedValueOnce(new ApiError(401, 'device_not_found'))
      .mockRejectedValueOnce(new ApiError(401, 'device_not_found')); // fresh token rejected too
    verifyMock.mockResolvedValueOnce({ deviceToken: 'dvt_fresh_prod' });

    await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(useToast.getState().message).toMatch(/verify this device/i);
  });

  it('does NOT toast on a successful re-attest + recovery', async () => {
    apiMock.enroll
      .mockRejectedValueOnce(new ApiError(401, 'device_not_found'))
      .mockResolvedValueOnce(undefined);
    verifyMock.mockResolvedValueOnce({ deviceToken: 'dvt_fresh_prod' });

    const result = await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(result).toBe('reenrolled');
    expect(useToast.getState().message).toBeUndefined();
  });

  it('does NOT re-attest on identity_mismatch (re-attestation cannot fix it)', async () => {
    apiMock.enroll.mockRejectedValueOnce(new ApiError(409, 'taken'));
    apiMock.rebindDevice.mockRejectedValueOnce(new ApiError(401, 'identity_mismatch'));

    const result = await ensureServerBinding({ signalProtocol, vouchflow, forceReenroll: true });

    expect(result).toBe('noop');
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns "noop" when there is no userId or deviceToken yet', async () => {
    useIdentity.setState({ userId: undefined, deviceToken: undefined });
    const result = await ensureServerBinding({ signalProtocol, vouchflow });
    expect(result).toBe('noop');
    expect(apiMock.fetchUser).not.toHaveBeenCalled();
    expect(apiMock.enroll).not.toHaveBeenCalled();
  });
});
