import React, { useEffect, useRef } from 'react';
import { Animated, SafeAreaView, StyleSheet, View } from 'react-native';
import { CipherS } from '../../brand/CipherS.js';
import { Wordmark } from '../../components/Wordmark.js';
import { Button } from '../../components/Button.js';
import { brand, motion } from '../../theme/tokens.js';

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
});
