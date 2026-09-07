import React from 'react';
import { Text, TextInput } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { ReviewerVerification, UNSUPPORTED_DEVICE_MESSAGE } from './ReviewerVerification.js';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View',
  StyleSheet: { create: (styles: unknown) => styles },
}));

function mount(onSubmit = vi.fn(async (_args: { code: string }) => {})) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(
      React.createElement(ReviewerVerification, {
        onSubmit,
        colors: { text: '#fff', muted: '#aaa', faint: '#777' },
        testIDPrefix: 'verify',
        renderButton: (button) => React.createElement('Button', button),
      }),
    );
  });
  const find = (id: string) => tree.root.findByProps({ testID: `verify-${id}` });
  return { tree, find, onSubmit };
}

describe('unsupported device reviewer entry', () => {
  it('shows the device requirement and a secondary reviewer action, with no input initially', () => {
    const { tree, find } = mount();
    expect(find('unsupported').props.children).toBe(UNSUPPORTED_DEVICE_MESSAGE);
    expect(find('reviewer').findByType(Text).props.children).toBe(
      'Reviewing this app? Enter a verification code.',
    );
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0);
  });

  it('reveals a verification-code input and submits only the code after an explicit reviewer action', async () => {
    const { tree, find, onSubmit } = mount();
    act(() => find('reviewer').props.onPress());
    expect(tree.root.findAllByType(TextInput)).toHaveLength(1);
    act(() => find('code').props.onChangeText('12abg'));
    expect(find('code').props.value).toBe('12abg');
    expect(find('verify').props.disabled).toBe(true);
    act(() => find('code').props.onChangeText('0123456789ABCDEF0123456789ABCDEF'));
    expect(find('code').props.value).toBe('0123456789abcdef0123456789abcdef');
    await act(async () => find('verify').props.onPress());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ code: '0123456789abcdef0123456789abcdef' });
  });

  it('keeps a rejected code on the screen for retry and prevents concurrent submissions', async () => {
    let reject!: (error: Error) => void;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const { find } = mount(onSubmit);
    act(() => find('reviewer').props.onPress());
    act(() => find('code').props.onChangeText('0123456789abcdef0123456789abcdef'));
    act(() => {
      find('verify').props.onPress();
      find('verify').props.onPress();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(find('code').props.editable).toBe(false);
    await act(async () => reject(new Error('Rejected')));
    expect(find('error').props.children).toContain("That code didn't work");
    expect(find('verify').props.disabled).toBe(false);
  });
});
