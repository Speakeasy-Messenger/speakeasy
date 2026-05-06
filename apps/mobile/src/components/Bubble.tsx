import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { font, motion, radius, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Chat bubble — BRANDING1.md §6.2 (incoming) / §6.3 (outgoing) /
 * §6.4 (fading modifier).
 *
 *   incoming   — `surface` bg, 1px text-faint border, `text` foreground
 *   outgoing   — brass bg, ink foreground, no border (mode-invariant)
 *
 * No tail, no avatar, no sender name. Max width 78%.
 *
 * The `fading` modifier draws the bubble at opacity 0.32 with a
 * `meta`-style "LEAVES IN Ns" caption underneath in `text-mute`. When
 * the parent unmounts the bubble (after the dissolve TTL), the
 * unmount itself fades over `motion.dissolve`.
 */
type Variant = 'them' | 'me';

export interface BubbleProps {
  text: string;
  variant: Variant;
  /** Whether to dim the bubble + show the LEAVES IN caption. */
  fading?: boolean;
  /** Seconds remaining before unmount; surfaced in the caption. */
  leavesInSeconds?: number;
}

export function Bubble({
  text,
  variant,
  fading = false,
  leavesInSeconds,
}: BubbleProps): React.JSX.Element {
  const theme = useTheme();
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (fading) {
      Animated.timing(opacity, {
        toValue: 0.32,
        duration: motion.fade,
        useNativeDriver: true,
      }).start();
    } else {
      opacity.setValue(1);
    }
  }, [fading, opacity]);

  const isMe = variant === 'me';
  const bubbleStyle = [
    styles.base,
    isMe
      ? {
          alignSelf: 'flex-end' as const,
          backgroundColor: theme.accent,
          borderWidth: 0,
        }
      : {
          alignSelf: 'flex-start' as const,
          backgroundColor: theme.surface,
          borderColor: theme.textFaint,
          borderWidth: 1,
        },
  ];

  return (
    <View style={styles.row}>
      <Animated.View style={[bubbleStyle, { opacity }]}>
        <Text
          style={[
            styles.text,
            {
              color: isMe ? theme.accentFg : theme.text,
              fontFamily: isMe ? font.medium : font.regular,
              fontSize: type.body.size,
            },
          ]}
        >
          {text}
        </Text>
      </Animated.View>
      {fading ? (
        <Text
          style={[
            styles.caption,
            {
              color: theme.textMute,
              fontFamily: font.medium,
              fontSize: type.meta.size,
              letterSpacing: type.meta.letterSpacingEm * type.meta.size,
              alignSelf: isMe ? 'flex-end' : 'flex-start',
            },
          ]}
        >
          {leavesInSeconds !== undefined
            ? `LEAVES IN ${leavesInSeconds}S`
            : 'LEAVING'}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 4 },
  base: {
    maxWidth: '78%',
    paddingVertical: 9,
    paddingHorizontal: 13,
    borderRadius: radius.sm, // 4px — sharp, geometric
  },
  text: { lineHeight: 20 },
  caption: { textTransform: 'uppercase', paddingHorizontal: space.xs },
});
