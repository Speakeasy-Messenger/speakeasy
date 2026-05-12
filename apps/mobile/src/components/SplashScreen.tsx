import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CipherS } from '../brand/CipherS.js';
import { brand, accent, font } from '../theme/tokens.js';

/**
 * Pre-hydration splash. Shown while the persisted stores rehydrate
 * (`hydrated` flag in App.tsx). Mirrors the hero on
 * speakeasyapp.xyz: brand-canvas aubergine ground, CipherS glyph
 * centered, "speakeasy." wordmark beneath, brand tagline below.
 *
 * Why not the marketing site's full mesh (12 animals + connecting
 * lines)? Splash is a sub-second moment — too much detail reads as
 * busy. The CipherS alone is the brand's anchor glyph and gives the
 * splash a visual identity that no longer feels like a blank loading
 * canvas.
 *
 * The wordmark uses the static `font.bold` directly rather than
 * `Wordmark` (which uses `useTheme()`) — splash renders before the
 * ThemeProvider can read system color scheme reliably on cold start.
 */
export function SplashScreen(): React.ReactElement {
  return (
    <View style={styles.root} testID="splash-screen">
      <View style={styles.center}>
        <CipherS size={96} />
        <Text style={styles.wordmark} accessibilityLabel="speakeasy">
          speakeasy<Text style={styles.dot}>.</Text>
        </Text>
        <Text style={styles.tagline}>
          encrypted messages that disappear.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: brand.canvas,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    alignItems: 'center',
    gap: 24,
  },
  wordmark: {
    fontFamily: font.bold,
    fontSize: 36,
    color: '#F2E9D8',
    letterSpacing: -36 * 0.025,
  },
  dot: {
    color: accent.base,
  },
  tagline: {
    fontFamily: font.regular,
    fontSize: 13,
    color: 'rgba(242,233,216,0.55)',
    textAlign: 'center',
    letterSpacing: 0.2,
  },
});
