import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VouchflowClient, VerifyResult } from '../native/vouchflow.js';
import { useIdentity } from '../store/identity.js';

const { mockAlert } = vi.hoisted(() => ({
  mockAlert: vi.fn(),
}));

vi.mock('react-native', async () => {
  const actual = await vi.importActual<typeof import('react-native')>('react-native');
  return {
    ...actual,
    Alert: { alert: mockAlert },
  };
});

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

function tapButton(label: string): void {
  const buttons = mockAlert.mock.calls.at(-1)?.[2] as Array<{
    text: string;
    onPress?: () => void;
  }>;
  buttons.find((b) => b.text === label)?.onPress?.();
}

describe('verifyDeviceWithExplanation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useIdentity.setState({
      userId: 'alice',
      deviceToken: undefined,
      deviceTokenIssuedAt: undefined,
      hydrated: true,
    });
  });

  it('shows an explanation before calling Vouchflow verify', async () => {
    const vouchflow = client();
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    expect(mockAlert).toHaveBeenCalledWith(
      'Verify this device',
      expect.stringContaining('passkey prompt will open only after you tap Continue'),
      expect.any(Array),
    );
    expect(vouchflow.verify).not.toHaveBeenCalled();

    tapButton('Continue');
    await expect(pending).resolves.toMatchObject({ deviceToken: 'dvt_new' });
    expect(vouchflow.verify).toHaveBeenCalledTimes(1);
    expect(useIdentity.getState().deviceToken).toBe('dvt_new');
  });

  it('does not call verify when the user cancels', async () => {
    const vouchflow = client();
    const pending = verifyDeviceWithExplanation(vouchflow, 'send_message');

    tapButton('Not now');
    await expect(pending).rejects.toBeInstanceOf(DeviceVerificationCancelledError);
    expect(vouchflow.verify).not.toHaveBeenCalled();
  });
});

describe('getDeviceTokenOrVerify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(mockAlert).not.toHaveBeenCalled();
    expect(vouchflow.verify).not.toHaveBeenCalled();
  });
});
