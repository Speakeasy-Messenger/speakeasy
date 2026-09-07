import React from 'react';
import { act, create } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VerifyDeviceSheet } from './VerifyDeviceSheet.js';
import { useVerifySheet } from '../store/verify-sheet.js';
import { UNSUPPORTED_DEVICE_MESSAGE } from '../auth/unsupported-device.js';

vi.mock('react-native', () => ({
  Modal: 'div',
  Pressable: 'button',
  Text: 'span',
  View: 'section',
  StyleSheet: { create: (styles: unknown) => styles, absoluteFillObject: {}, hairlineWidth: 1 },
}));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('../theme/index.js', () => ({
  useColors: () => ({
    cream: '#fff',
    divider: '#ccc',
    ink: '#000',
    primary: '#aaa',
    slate: '#555',
  }),
}));

beforeEach(() => useVerifySheet.getState().finish());

describe('unsupported device sheet', () => {
  it('shows the requirement after failure with no input or alternate authentication action', () => {
    void useVerifySheet.getState().request('launch_refresh');
    useVerifySheet.getState().confirm();
    useVerifySheet.getState().fail(UNSUPPORTED_DEVICE_MESSAGE);
    const tree = create(React.createElement(VerifyDeviceSheet));
    expect(tree.root.findByProps({ testID: 'verify-device-error' }).props.children).toBe(
      UNSUPPORTED_DEVICE_MESSAGE,
    );
    expect(tree.root.findAllByType('input')).toHaveLength(0);
    // The sole press target is the existing dismissal scrim, with no label or children.
    expect(tree.root.findAllByType('button')).toHaveLength(1);
    expect(tree.root.findByType('button').props.children).toBeUndefined();
    act(() => tree.root.findByType('button').props.onPress());
    expect(useVerifySheet.getState().pending).toBeUndefined();
    tree.unmount();
  });
});
