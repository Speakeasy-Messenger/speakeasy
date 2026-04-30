import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { colors, fonts, radius, space } from '../theme/index.js';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** primary (purple bg, cream text) | ghost (cream bg, ink text) */
  tone?: 'primary' | 'ghost';
  style?: StyleProp<ViewStyle>;
  /** Stable selector for end-to-end (Maestro) tests. */
  testID?: string;
}

export function Button({
  label,
  onPress,
  loading = false,
  disabled = false,
  tone = 'primary',
  style,
  testID,
}: ButtonProps) {
  const isPrimary = tone === 'primary';
  const bg = isPrimary ? colors.primary : colors.cream;
  const fg = isPrimary ? colors.cream : colors.ink;
  const isInert = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={isInert ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: bg,
          opacity: isInert ? 0.5 : pressed ? 0.85 : 1,
          borderWidth: isPrimary ? 0 : 1,
          borderColor: colors.pale,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={[styles.label, { color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: space.md,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
  },
  label: {
    fontFamily: fonts.inter500,
    fontSize: 15,
    letterSpacing: 0.2,
  },
});
