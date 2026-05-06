import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { font, radius, space, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Sharp button. Per BRANDING1.md §6.6:
 *   - height 48
 *   - radius 0 (intentional, do not soften)
 *   - padding 12 / 24
 *   - body weight 600
 *   - press state: 100ms fade to pressed bg
 *
 * Three variants:
 *   primary    — brass background, ink text. Use sparingly (one CTA / screen).
 *   secondary  — transparent + 1px text-faint border, text in `text`.
 *   ghost      — transparent, text-mute. For demote / cancel.
 *
 * The legacy `tone` prop ('primary' | 'ghost') is accepted as an alias
 * to `variant` to keep older callers compiling during the rebrand.
 */
type Variant = 'primary' | 'secondary' | 'ghost';
type LegacyTone = 'primary' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** New name (preferred). */
  variant?: Variant;
  /** @deprecated alias for `variant`. */
  tone?: LegacyTone;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Button({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant,
  tone,
  style,
  testID,
}: ButtonProps): React.JSX.Element {
  const theme = useTheme();
  const isInert = disabled || loading;
  const v: Variant = variant ?? tone ?? 'primary';

  const bg =
    v === 'primary' ? theme.accent : v === 'secondary' ? 'transparent' : 'transparent';
  const fg =
    v === 'primary'
      ? theme.accentFg
      : v === 'ghost'
        ? theme.textMute
        : theme.text;
  const pressedBg =
    v === 'primary'
      ? theme.accentPressed
      : v === 'secondary'
        ? theme.surface
        : theme.textGhost;
  const borderColor = v === 'secondary' ? theme.textFaint : 'transparent';
  const borderWidth = v === 'secondary' ? 1 : 0;

  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      onPress={isInert ? undefined : onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: pressed && !isInert ? pressedBg : bg,
          borderColor,
          borderWidth,
          opacity: isInert ? 0.5 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text
          style={[
            styles.label,
            {
              color: fg,
              fontFamily: font.semibold,
              fontSize: type.body.size,
            },
          ]}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    height: 48,
    paddingHorizontal: space.xl,
    paddingVertical: space.m,
    borderRadius: radius.none, // sharp — do not soften
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { letterSpacing: 0 },
});
