import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import { UNSUPPORTED_DEVICE_MESSAGE } from '../../auth/unsupported-device.js';
import { HandleStep } from './HandleStep.js';

const services = vi.hoisted(() => ({
  api: {
    checkAvailability: vi.fn(async () => ({ available: true })),
    enroll: vi.fn(async () => ({ user_id: 'alice' })),
  },
  signalProtocol: {
    generateIdentityKey: vi.fn(async () => 'identity-key'),
    generatePreKeyBundle: vi.fn(async () => ({
      registrationId: 1,
      signedPreKeyId: 1,
      signedPreKey: 'pre-key',
      signedPreKeySig: 'signature',
      preKeys: [],
    })),
  },
  vouchflow: {
    verify: vi.fn(async () => ({
      verified: true,
      confidence: 'low',
      deviceToken: 'dvt_new',
      deviceAgeDays: 1,
      networkVerifications: 1,
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
    })),
  },
}));

const lockScreen = vi.hoisted(() => ({ isDeviceSecure: vi.fn(async () => false) }));

vi.mock('react-native', () => ({
  KeyboardAvoidingView: 'section',
  Platform: { OS: 'ios' },
  SafeAreaView: 'section',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'span',
  TextInput: 'input',
  View: 'div',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'section' }));
vi.mock('../../components/Button.js', () => ({
  Button: (props: React.Attributes) => React.createElement('button', props),
}));
vi.mock('../../services.js', () => services);
vi.mock('../../native/lock-screen.js', () => lockScreen);
vi.mock('../../diag/log.js', () => ({ diag: vi.fn() }));

describe('HandleStep device verification outcomes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    services.api.checkAvailability.mockReset().mockResolvedValue({ available: true });
    services.api.enroll.mockReset().mockResolvedValue({ user_id: 'alice' });
    services.vouchflow.verify.mockClear();
    lockScreen.isDeviceSecure.mockReset().mockResolvedValue(false);
  });

  async function enterAvailableHandle(tree: ReturnType<typeof create>) {
    await act(async () => {
      tree.root.findByProps({ testID: 'onboarding-handle' }).props.onChangeText('alice');
      await vi.advanceTimersByTimeAsync(300);
    });
  }

  it('replaces onboarding with the sole unsupported-device message when attestation cannot start', async () => {
    const onClaimed = vi.fn();
    const tree = create(React.createElement(HandleStep, { onClaimed }));
    await enterAvailableHandle(tree);

    await act(async () => {
      tree.root.findByProps({ testID: 'onboarding-continue' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'onboarding-error' }).props.children).toBe(
      UNSUPPORTED_DEVICE_MESSAGE,
    );
    expect(tree.root.findAllByType('input')).toHaveLength(0);
    expect(tree.root.findAllByType('button')).toHaveLength(0);
    expect(onClaimed).not.toHaveBeenCalled();
    expect(services.vouchflow.verify).not.toHaveBeenCalled();
    tree.unmount();
  });

  it('keeps onboarding actionable after a transient enrollment failure', async () => {
    lockScreen.isDeviceSecure.mockResolvedValue(true);
    services.api.enroll.mockRejectedValueOnce(new ApiError(500, 'internal'));
    const tree = create(React.createElement(HandleStep, { onClaimed: vi.fn() }));
    await enterAvailableHandle(tree);

    await act(async () => {
      tree.root.findByProps({ testID: 'onboarding-continue' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'onboarding-error' }).props.children).toBe(
      'Enrollment failed (500 internal).',
    );
    expect(tree.root.findByProps({ testID: 'onboarding-continue' }).props.disabled).toBe(false);
    expect(tree.root.findAllByType('input')).toHaveLength(1);
    tree.unmount();
  });
});
