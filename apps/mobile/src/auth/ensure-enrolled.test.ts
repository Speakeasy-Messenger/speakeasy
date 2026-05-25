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

import { ensureServerBinding } from './ensure-enrolled.js';
import { ApiError } from '../api/client.js';

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

  it('returns "noop" when there is no userId or deviceToken yet', async () => {
    useIdentity.setState({ userId: undefined, deviceToken: undefined });
    const result = await ensureServerBinding({ signalProtocol, vouchflow });
    expect(result).toBe('noop');
    expect(apiMock.fetchUser).not.toHaveBeenCalled();
    expect(apiMock.enroll).not.toHaveBeenCalled();
  });
});
