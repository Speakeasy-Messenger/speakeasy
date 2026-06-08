import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUiState } from '../store/ui.js';
import { useTheme } from '../theme/ThemeProvider.js';
import { Wordmark } from './Wordmark.js';

/**
 * Full-screen opaque privacy sheet. Shown by App.tsx's AppState listener
 * (via `useUiState.privacyCovered`) whenever the app is NOT
 * foregrounded-active — i.e. backgrounded, inactive, or the device screen
 * just went off. It hides chat content from:
 *   - the OS app-switcher / recents thumbnail
 *   - the brief flash when the screen turns back on before the app is
 *     fully 'active'
 *
 * Intentionally lightweight (plan, rc.* 1.0.x): it auto-clears on
 * 'active' and does NOT require re-auth on resume — a biometric re-lock
 * is a separate, settings-gated feature. The opaque background + brand
 * mark mirror the splash so the transition reads as "the app", not a
 * glitch.
 */
export function PrivacyCover(): React.ReactElement | null {
  const covered = useUiState((s) => s.privacyCovered);
  const theme = useTheme();
  if (!covered) return null;
  return (
    <View
      style={[styles.fill, { backgroundColor: theme.canvas }]}
      // Block any touches from reaching the screens beneath while covered.
      pointerEvents="auto"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="privacy-cover"
    >
      <Wordmark variant="hero" />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
