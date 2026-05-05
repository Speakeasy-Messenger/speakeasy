import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, fonts, radius, space } from '../theme/index.js';
import { useBanner } from '../store/banner.js';

const AUTO_DISMISS_MS = 4000;

interface Props {
  /** Tap handler — receives the active banner's target so the parent can
   * route accordingly. The banner itself never imports the navigator. */
  onTap: (target: import('../store/banner.js').BannerData['target']) => void;
}

export function InAppBanner({ onTap }: Props) {
  const insets = useSafeAreaInsets();
  const current = useBanner((s) => s.current);
  const dismiss = useBanner((s) => s.dismiss);

  // Single Animated value drives both the slide (translateY) and the
  // fade. Re-keyed off `current?.id` so a new banner re-runs the
  // entrance animation even if one was already in flight.
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!current) return;
    progress.setValue(0);
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    const t = setTimeout(() => {
      Animated.timing(progress, {
        toValue: 0,
        duration: 200,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) dismiss();
      });
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [current?.id, dismiss, progress]);

  if (!current) return null;

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-80, 0],
  });

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        { paddingTop: insets.top + space.xs, opacity: progress, transform: [{ translateY }] },
      ]}
    >
      <Pressable
        onPress={() => {
          dismiss();
          onTap(current.target);
        }}
        style={styles.card}
        testID="in-app-banner"
      >
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {current.sender.slice(0, 1).toUpperCase()}
          </Text>
        </View>
        <View style={styles.body}>
          <Text style={styles.sender} numberOfLines={1}>
            {current.target.kind === 'group' ? `# ${current.sender}` : current.sender}
          </Text>
          <Text style={styles.text} numberOfLines={2}>
            {current.text}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: space.md,
    zIndex: 1000,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: '#FFFFFF',
    borderRadius: radius.avatar,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.pale,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: fonts.inter500,
    fontSize: 14,
    color: colors.primary,
  },
  body: { flex: 1 },
  sender: {
    fontFamily: fonts.inter500,
    fontSize: 13,
    color: colors.ink,
  },
  text: {
    fontFamily: fonts.inter400,
    fontSize: 13,
    color: colors.slate,
    marginTop: 2,
  },
});
