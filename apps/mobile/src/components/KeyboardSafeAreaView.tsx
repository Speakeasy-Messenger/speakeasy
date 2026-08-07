import React, { useEffect, useState } from 'react';
import { Keyboard, Platform } from 'react-native';
import {
  SafeAreaView,
  type Edge,
  type SafeAreaViewProps,
} from 'react-native-safe-area-context';

const EDGES_WITHOUT_BOTTOM: readonly Edge[] = ['top', 'right', 'left'];

/**
 * Keeps Android content above the system navigation bar until the IME opens.
 * Android 16 reports the navigation inset while the IME is visible, even
 * though the keyboard has replaced that area, so applying both creates a gap.
 */
export function KeyboardSafeAreaView(props: SafeAreaViewProps) {
  const [androidKeyboardVisible, setAndroidKeyboardVisible] = useState(
    () => Platform.OS === 'android' && Keyboard.isVisible(),
  );

  useEffect(() => {
    if (Platform.OS !== 'android') return;

    const shown = Keyboard.addListener('keyboardDidShow', () => {
      setAndroidKeyboardVisible(true);
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      setAndroidKeyboardVisible(false);
    });

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return (
    <SafeAreaView
      {...props}
      edges={androidKeyboardVisible ? EDGES_WITHOUT_BOTTOM : props.edges}
    />
  );
}
