import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUiState } from '../store/ui.js';
import { useCalls } from '../store/calls.js';
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
  // A live call must NEVER be hidden by the privacy cover. Backgrounding a
  // video call floats it into a PiP bubble whose entire purpose is to keep
  // showing the counterparty's face; this component renders the brand
  // splash, so painting it over the bubble defeats the feature outright
  // (and at z-9999 / pointerEvents:auto it even eats the taps that would
  // restore the app). The previous guard lived in App.tsx's AppState
  // listener — an event-timing exemption that proved unreliable across the
  // PiP transition. Gating HERE, reactively on the call store, makes the
  // cover structurally incapable of covering a call regardless of AppState
  // ordering: as long as a call is active this returns null. Audio calls
  // are covered too — the call UI isn't the sensitive chat content the
  // cover exists to hide from the app-switcher.
  const callActive = useCalls((s) => !!s.active);
  if (callActive || !covered) return null;
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
