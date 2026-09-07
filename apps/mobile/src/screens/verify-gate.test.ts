import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VouchflowClientError } from '../native/vouchflow.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import { VerifyGateScreen } from './VerifyGateScreen.js';

const vouchflowMock = vi.hoisted(() => ({
  verify: vi.fn(),
  getCachedDeviceToken: vi.fn(async () => null),
}));

vi.mock('react-native', () => ({
  Animated: {
    Value: class {
      interpolate() {
        return 0;
      }
    },
    View: 'div',
    timing: () => ({ start: () => undefined }),
  },
  Easing: { cubic: {}, out: () => ({}) },
  KeyboardAvoidingView: 'div',
  Platform: { OS: 'ios' },
  Pressable: 'button',
  SafeAreaView: 'div',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'span',
  View: 'section',
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: 'div' }));
vi.mock('../avatars/AvatarRenderer.js', () => ({ AvatarRenderer: 'avatar' }));
vi.mock('../services.js', () => ({ vouchflow: vouchflowMock }));

describe('VerifyGateScreen', () => {
  beforeEach(() => {
    useIdentity.setState({
      userId: 'alice',
      deviceToken: undefined,
      deviceTokenIssuedAt: undefined,
      hydrated: true,
    });
    useProfiles.setState({ byUserId: {} });
    vouchflowMock.verify.mockReset();
  });

  it('keeps retry controls available after an unknown verification failure', async () => {
    vouchflowMock.verify.mockRejectedValueOnce(new VouchflowClientError('unknown_error'));
    const tree = create(React.createElement(VerifyGateScreen));

    await act(async () => {
      tree.root.findByProps({ testID: 'verify-gate-continue' }).props.onPress();
      await Promise.resolve();
    });

    expect(tree.root.findByProps({ testID: 'verify-gate-error' }).props.children).toBe(
      "Couldn't verify this device. Please try again.",
    );
    expect(tree.root.findByProps({ testID: 'verify-gate-continue' }).props.children.props.children).toBe(
      'Verify this device',
    );
    tree.unmount();
  });
});
