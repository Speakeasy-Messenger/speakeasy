import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdentity } from '../store/identity.js';

// Mock services.ts so we don't drag the real ApiClient / native
// VouchflowSDK / CachingVouchflowClient into the test process.
const apiMock = {
  fetchUser: vi.fn(),
  enroll: vi.fn(),
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

  it('keeps the identity intact when re-enroll hits 409 "taken"', async () => {
    apiMock.enroll.mockRejectedValueOnce(new ApiError(409, 'taken'));
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
