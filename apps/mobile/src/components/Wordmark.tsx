import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts } from '../theme/index.js';

type Variant = 'hero' | 'small';

export interface WordmarkProps {
  variant?: Variant;
  /** Override the text colour. Defaults to ink. */
  color?: string;
  /** Optional subtitle in caps below the wordmark. Brand-WIP, parameterised. */
  subtitle?: string;
}

/**
 * Lowercase "speakeasy" wordmark. Spec §14 — April 2026 revision: no gold
 * silence-mark line, no display font, just Inter at the right weight and
 * tracking.
 */
export function Wordmark({ variant = 'small', color = colors.ink, subtitle }: WordmarkProps) {
  const isHero = variant === 'hero';
  const fontSize = isHero ? 40 : 22;
  const letterSpacing = isHero ? 14 : 6;
  const lineHeight = Math.round(fontSize * 1.1);

  return (
    <View style={styles.col} accessible accessibilityLabel="speakeasy">
      <Text
        style={[
          styles.word,
          { color, fontSize, letterSpacing, lineHeight, fontFamily: isHero ? fonts.inter500 : fonts.inter300 },
        ]}
      >
        speakeasy
      </Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: colors.slate }]}>{subtitle.toUpperCase()}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  col: { alignItems: 'center', gap: 6 },
  word: {},
  subtitle: {
    fontFamily: fonts.inter300,
    fontSize: 9,
    letterSpacing: 2,
  },
});
