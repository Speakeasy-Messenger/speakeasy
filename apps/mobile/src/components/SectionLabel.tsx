import React from 'react';
import { StyleSheet, Text, type TextStyle } from 'react-native';
import { font, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Section label — BRANDING1.md §6.7. `meta` style (10px / weight 500
 * / 0.20em uppercase tracking) in `text-mute`. 20px bottom margin.
 *
 * Use to group lists / cards in Settings, the conversation list, etc.
 */
export interface SectionLabelProps {
  children: React.ReactNode;
  /** Override the bottom margin. Defaults to 20 per spec. */
  style?: TextStyle | TextStyle[];
}

export function SectionLabel({ children, style }: SectionLabelProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text
      style={[
        styles.text,
        {
          color: theme.textMute,
          fontFamily: font.medium,
          fontSize: type.meta.size,
          letterSpacing: type.meta.letterSpacingEm * type.meta.size,
        },
        style as TextStyle,
      ]}
    >
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: { textTransform: 'uppercase', marginBottom: 20 },
});
