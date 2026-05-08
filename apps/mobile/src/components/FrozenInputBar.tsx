import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { space, useColors } from '../theme/index.js';
import { font, type as typeScale } from '../theme/tokens.js';

/**
 * BLOCK.md §5.2 — frozen-conversation InputBar replacement.
 *
 * Same height as the standard input bar so the chat surface
 * doesn't reflow when block toggles. Two centered lines:
 *   - "You blocked them." (caption, text-mute, brass period)
 *   - "Unblock" (brass, weight 500, tappable)
 */

interface Props {
  onUnblock: () => void;
}

export function FrozenInputBar({ onUnblock }: Props): React.ReactElement {
  const themed = useColors();
  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: themed.cream, borderTopColor: themed.divider },
      ]}
      testID="frozen-input-bar"
    >
      <Text style={[styles.line, { color: themed.slate }]}>
        You blocked them<Text style={{ color: themed.primary }}>.</Text>
      </Text>
      <Pressable onPress={onUnblock} hitSlop={8} testID="frozen-input-unblock">
        <Text style={[styles.action, { color: themed.primary }]}>Unblock</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: space.md,
    paddingTop: 14,
    paddingBottom: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    gap: 6,
  },
  line: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 18,
    textAlign: 'center',
  },
  action: {
    fontFamily: font.medium,
    fontSize: typeScale.caption.size,
    letterSpacing: 0.005 * typeScale.caption.size,
    textAlign: 'center',
  },
});
