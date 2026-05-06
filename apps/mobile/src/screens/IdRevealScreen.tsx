import React, { useEffect, useRef } from 'react';
import { Animated, SafeAreaView, StyleSheet, Text, View, Easing } from 'react-native';
import { Button } from '../components/Button.js';
import { colors, fonts, space, text } from '../theme/index.js';
import { brand, workspace } from '../theme/tokens.js';

interface Props {
  userId: string;
  onContinue: () => void;
}

/**
 * Spec §14 (April 2026):
 *   - cream bg
 *   - "INTRODUCING" primary-purple, Inter 500 9px / 2px tracking
 *   - 3 ID words stacked in Inter 700 38px ink, primary-purple `·` separators
 *
 * Motion: words arrive one-at-a-time, 200ms staggered, fading up from 8px.
 * Separators fade in after each word. Total ~800ms.
 */
export function IdRevealScreen({ userId, onContinue }: Props) {
  // New `@handle` format has no hyphens — render as one block with the
  // `@` prefix. Legacy 3-word ids retain the staggered-word animation.
  const words = userId.includes('-') ? userId.split('-') : [`@${userId}`];
  const wordAnims = useRef(words.map(() => new Animated.Value(0))).current;
  const sepAnims = useRef(words.slice(0, -1).map(() => new Animated.Value(0))).current;

  useEffect(() => {
    const animations: Animated.CompositeAnimation[] = [];
    words.forEach((_, i) => {
      animations.push(
        Animated.timing(wordAnims[i]!, {
          toValue: 1,
          duration: 350,
          delay: i * 200,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      );
      if (i < words.length - 1) {
        animations.push(
          Animated.timing(sepAnims[i]!, {
            toValue: 1,
            duration: 250,
            delay: i * 200 + 200,
            useNativeDriver: true,
          }),
        );
      }
    });
    Animated.parallel(animations).start();
  }, [wordAnims, sepAnims, words]);

  return (
    <SafeAreaView testID="id-reveal-screen" style={styles.root}>
      <View style={styles.center}>
        <Text style={[text.introLabel, styles.intro]}>INTRODUCING</Text>
        <View style={styles.stack}>
          {words.map((word, i) => (
            <React.Fragment key={`${i}-${word}`}>
              <Animated.Text
                style={[
                  text.idWord,
                  styles.word,
                  {
                    opacity: wordAnims[i],
                    transform: [
                      {
                        translateY: wordAnims[i]!.interpolate({
                          inputRange: [0, 1],
                          outputRange: [8, 0],
                        }),
                      },
                    ],
                  },
                ]}
              >
                {word}
              </Animated.Text>
              {i < words.length - 1 ? (
                <Animated.Text style={[styles.separator, { opacity: sepAnims[i] }]}>
                  ·
                </Animated.Text>
              ) : null}
            </React.Fragment>
          ))}
        </View>
        <Text style={styles.tagline}>Say it & leave.</Text>
      </View>
      <View style={styles.bottom}>
        {/* The IdReveal screen renders the userId in a stack of animated
            words, which Maestro can't easily reassemble. We mirror it
            into a visible-but-tiny Text node tagged with both testID and
            accessibilityLabel so Tier B can read it without altering
            the layout. fontSize: 1 + opacity: 0 keeps it offscreen
            visually but inside the rendered hierarchy. */}
        <Text
          testID="id-reveal-userid"
          accessible
          accessibilityLabel={`@${userId}`}
          style={styles.hiddenLabel}
        >
          @{userId}
        </Text>
        <Button
          label="Get started"
          onPress={onContinue}
          tone="primary"
          testID="id-reveal-get-started"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // Spec §7: brand-moment screens render on the brand canvas (aubergine).
  root: { flex: 1, backgroundColor: brand.canvas, padding: space.lg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space.lg },
  intro: { color: colors.primary },
  stack: { alignItems: 'center', gap: space.sm },
  word: { color: colors.ink },
  separator: {
    fontFamily: fonts.inter500,
    fontSize: 24,
    color: colors.primary,
    paddingVertical: 2,
  },
  tagline: {
    fontFamily: fonts.inter300,
    fontSize: 12,
    color: colors.slate,
    marginTop: space.xl,
  },
  bottom: { gap: space.sm },
  hiddenLabel: { fontSize: 1, color: colors.cream, height: 1 },
});
