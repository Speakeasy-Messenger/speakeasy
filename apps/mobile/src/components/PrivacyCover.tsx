import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUiState } from '../store/ui.js';
import { SplashScreen } from './SplashScreen.js';

/**
 * Full-screen opaque privacy sheet. Shown by App.tsx's AppState listener
 * (via `useUiState.privacyCovered`) whenever the app is NOT
 * foregrounded-active — i.e. backgrounded, inactive, or the device screen
 * just went off. It hides chat content from:
 *   - the OS app-switcher / recents thumbnail
 *   - the brief flash when the screen turns back on before the app is
 *     fully 'active'
 *
 * Renders the SplashScreen verbatim (the aubergine brand splash) rather
 * than a bare wordmark on canvas: it's opaque (fully hides content), it
 * looks finished, and reusing the exact splash makes the cover read as
 * "the app", not a glitch — including the brief cover that shows when
 * resuming via a push tap.
 *
 * Intentionally lightweight (plan, rc.* 1.0.x): it auto-clears on
 * 'active' and does NOT require re-auth on resume — a biometric re-lock
 * is a separate, settings-gated feature.
 */
export function PrivacyCover(): React.ReactElement | null {
  const covered = useUiState((s) => s.privacyCovered);
  if (!covered) return null;
  return (
    <View
      style={styles.fill}
      // Block any touches from reaching the screens beneath while covered.
      pointerEvents="auto"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="privacy-cover"
    >
      <SplashScreen />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
  },
});
