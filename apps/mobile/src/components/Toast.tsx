import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useToast } from '../store/toast.js';
import { useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

/**
 * Transient confirmation toast — the cross-platform replacement for
 * Android's `ToastAndroid` (iOS has no system toast). A pill near the
 * bottom of the screen: fades in, holds ~1.6s, fades out. One at a
 * time — `useToast.show()` replaces any in-flight toast.
 *
 * Mounted once at the app root (App.tsx), alongside `<InAppBanner>`.
 */
const HOLD_MS = 1600;
const ANIM_MS = 200;

export function Toast() {
  const insets = useSafeAreaInsets();
  const themed = useColors();
  const message = useToast((s) => s.message);
  const nonce = useToast((s) => s.nonce);
  const clear = useToast((s) => s.clear);

  // Re-keyed off `nonce` so a fresh show() replaces an in-flight toast
  // without queuing.
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!message) return;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: ANIM_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    const t = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: ANIM_MS,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) clear();
      });
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [nonce, message, clear, progress]);

  if (!message) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        { bottom: insets.bottom + 56, opacity: progress },
      ]}
    >
      <Text
        style={[styles.pill, { backgroundColor: themed.ink, color: themed.pale }]}
      >
        {message}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 1000,
  },
  pill: {
    fontFamily: font.medium,
    fontSize: typeScale.caption.size,
    overflow: 'hidden',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
  },
});
