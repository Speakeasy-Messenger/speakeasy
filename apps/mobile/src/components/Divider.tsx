import React from 'react';
import { View, type ViewStyle } from 'react-native';
import { useTheme } from '../theme/ThemeProvider.js';

/**
 * Divider — BRANDING1.md §6.9. 1px hairline in `text-faint`. Use
 * sparingly; the brand prefers space to lines.
 */
export function Divider({ style }: { style?: ViewStyle | ViewStyle[] }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      style={[{ height: 1, backgroundColor: theme.textFaint }, style as ViewStyle]}
    />
  );
}
