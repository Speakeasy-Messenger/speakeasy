import React, { useEffect, useRef } from 'react';
import { Animated, Linking, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CipherS } from '../../brand/CipherS.js';
import { Wordmark } from '../../components/Wordmark.js';
import { Button } from '../../components/Button.js';
import { brand, motion } from '../../theme/tokens.js';

// Terms / Privacy live on the marketing site; the same URLs are linked
// from the About screen. Tapping "Open the door" is the agreement action
// (App Store Guideline 1.2 requires users agree to terms with a clear
// no-tolerance-for-objectionable-content stance before using the service).
const TERMS_URL = 'https://speakeasyapp.xyz/terms';
const PRIVACY_URL = 'https://speakeasyapp.xyz/privacy';

/**
 * Onboarding screen 01 — Door.
 * Spec: ONBOARDING.md §2.1.
 *
 * Brand-canvas (aubergine) full-frame. CipherS mark (the three offset
 * bars used on the app icon, splash, and notification icon — primary
 * brand mark per BRANDING.md §1) + wordmark + tagline + primary
 * button "Open the door". The earlier Door silhouette read as a
 * different brand (icon vs onboarding mismatch on first launch); rc.46
 * unifies on CipherS so the splash → onboarding handoff is visually
 * continuous. 240ms fade-in on first paint.
 */

interface Props {
  onContinue: () => void;
}

export function DoorStep({ onContinue }: Props): React.ReactElement {
  const fade = useRef(new Animated.Value(0)).current;
  const buttonSlide = useRef(new Animated.Value(12)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, {
        toValue: 1,
        duration: motion.screen,
        useNativeDriver: true,
      }),
      Animated.timing(buttonSlide, {
        toValue: 0,
        duration: motion.screen,
        useNativeDriver: true,
      }),
    ]).start();
  }, [fade, buttonSlide]);

  return (
    <SafeAreaView style={styles.root}>
      <Animated.View style={[styles.center, { opacity: fade }]}>
        <CipherS size={96} />
        <View style={styles.spacer32} />
        {/* Force bone (workspace-dark text) on the aubergine brand
            canvas regardless of current mode — the canvas itself is
            mode-invariant. Without this override, light-mode users
            would get ink-on-aubergine which is illegible. */}
        <Wordmark variant="hero" tagline="Say it. Leave nothing." color="#F2E9D8" />
      </Animated.View>
      <Animated.View
        style={[
          styles.bottom,
          { opacity: fade, transform: [{ translateY: buttonSlide }] },
        ]}
      >
        <Button label="Open the door" onPress={onContinue} testID="onboarding-door-continue" />
        <Text style={styles.legal}>
          By opening the door, you agree to our{' '}
          <Text
            style={styles.legalLink}
            onPress={() => void Linking.openURL(TERMS_URL)}
          >
            Terms of Use
          </Text>{' '}
          and{' '}
          <Text
            style={styles.legalLink}
            onPress={() => void Linking.openURL(PRIVACY_URL)}
          >
            Privacy Policy
          </Text>
          . Speakeasy has zero tolerance for harassment or objectionable
          content.
        </Text>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: brand.canvas,
    paddingHorizontal: 24,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  spacer32: { height: 32 },
  bottom: {
    paddingBottom: 24,
  },
  legal: {
    marginTop: 14,
    textAlign: 'center',
    color: 'rgba(242,233,216,0.65)',
    fontSize: 12,
    lineHeight: 17,
  },
  legalLink: {
    color: '#F2E9D8',
    textDecorationLine: 'underline',
  },
});
