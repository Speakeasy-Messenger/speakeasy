import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AvatarRenderer } from '../avatars/AvatarRenderer.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { useProfiles } from '../store/profiles.js';
import { accent, brand, font, motion, type as typeScale, workspace } from '../theme/tokens.js';
import { space } from '../theme/index.js';

interface Props {
  userId: string;
  onContinue: () => void;
  /** Brand-canvas Share Handle screen, reachable as a side-trip from
   * here. Back from ShareHandle returns to IdReveal. */
  onShareHandle: () => void;
}

/**
 * Post-onboarding identity confirmation (CLAUDECODENOTE.md §1).
 *
 * Brand canvas. 96×96 portrait of the chosen animal. Display-style
 * handle in bone with brass `@` + brass period. Three short
 * paragraphs of canonical copy that name the handle, state the
 * lose-this-device-lose-this-identity trade, and invite the user in.
 *
 * Two stacked actions: "Share my handle" secondary, "Open the door"
 * primary. The note's table maps post-onboarding-first-time → secondary
 * is share, which is exactly this surface.
 *
 * Whole identity stack fades up (opacity 0→1, translateY 8→0) over
 * 600ms ease-out. The previous staggered-word reveal was retired
 * along with the old hyphenated id format.
 */
export function IdRevealScreen({
  userId,
  onContinue,
  onShareHandle,
}: Props): React.ReactElement {
  const profile = useProfiles((s) => s.byUserId[userId]);
  const animalId = profile?.selectedAvatarId ?? defaultAnimalForUser(userId);

  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(reveal, {
      toValue: 1,
      duration: motion.dissolve,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [reveal]);
  const translateY = reveal.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });

  return (
    <SafeAreaView testID="id-reveal-screen" style={styles.root}>
      <View style={styles.body}>
        <Animated.View
          style={[
            styles.stack,
            { opacity: reveal, transform: [{ translateY }] },
          ]}
        >
          <Text style={styles.eyebrow}>YOU'RE IN</Text>

          <View style={styles.portraitTile}>
            <AvatarRenderer animalId={animalId} size={Math.round(96 * 0.78)} />
          </View>

          <Text style={styles.copy}>
            Your handle is{' '}
            <Text style={styles.copyEm}>
              <Text style={styles.brass}>@</Text>
              {userId}
            </Text>{' '}
            and your face is the {animalId}.
          </Text>
          <Text style={styles.copy}>
            Nothing about you was used to make either. No phone, no email, no
            real name. Lose this device, lose this identity — that's the
            trade.
          </Text>
          <Text style={styles.copy}>When you're ready, step inside.</Text>
        </Animated.View>

        {/* Hidden testID-bearing label for Maestro. The styled stack
            uses Animated.Text + spans which Maestro can't easily
            reassemble. */}
        <Text
          testID="id-reveal-userid"
          accessible
          accessibilityLabel={`@${userId}`}
          style={styles.hiddenLabel}
        >
          @{userId}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={onShareHandle}
          style={styles.btnSecondary}
          testID="id-reveal-share"
        >
          <Text style={styles.btnSecondaryText}>Share my handle</Text>
        </Pressable>
        <Pressable
          onPress={onContinue}
          style={styles.btnPrimary}
          testID="id-reveal-get-started"
        >
          <Text style={styles.btnPrimaryText}>Open the door</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const BRASS = accent.base;
const BONE = workspace.dark.text;
const INK = accent.foreground;
const BRAND_SURFACE = brand.surface;
const TEXT_FAINT = workspace.dark.textFaint;
const TEXT_MUTE = workspace.dark.textMute;

const styles = StyleSheet.create({
  // Brand canvas — never themed.
  root: { flex: 1, backgroundColor: brand.canvas },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  stack: { alignItems: 'center', maxWidth: 32 * 8 },
  // Note §1: eyebrow is meta-style in `text-mute`, not brass.
  eyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    color: TEXT_MUTE,
    fontWeight: '500',
    marginBottom: 24,
  },
  portraitTile: {
    width: 96,
    height: 96,
    backgroundColor: BRAND_SURFACE,
    borderWidth: 1,
    borderColor: TEXT_FAINT,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  copy: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: BONE,
    textAlign: 'center',
    marginBottom: 14,
  },
  copyEm: {
    fontFamily: font.medium,
    color: BONE,
  },
  brass: { color: BRASS, fontFamily: font.bold },
  actions: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: 8,
  },
  btnPrimary: {
    backgroundColor: BRASS,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: INK,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: TEXT_FAINT,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: BONE,
    letterSpacing: 0.5,
  },
  hiddenLabel: { fontSize: 1, color: BRAND_SURFACE, height: 1 },
});
