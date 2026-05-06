import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { font, type } from '../theme/tokens.js';
import { useTheme } from '../theme/ThemeProvider.js';

type Variant = 'hero' | 'small';

export interface WordmarkProps {
  /** `hero` for splash/brand-canvas (96pt), `small` for inline use. */
  variant?: Variant;
  /** Optional tagline below the wordmark. Defaults to none. The
   * spec's canonical tagline is "Say it. Leave nothing." — pass it
   * explicitly when needed. */
  tagline?: string;
  /** Override the text color. Defaults to `theme.text`. Brand-canvas
   * screens pass the brand-side equivalent (warm bone). */
  color?: string;
}

/**
 * "speakeasy" — set lowercase, weight 700, optical-size 96 (we use
 * the static Bricolage Bold), letter-spacing -0.045em, line-height
 * 0.92. The trailing period is **always brass**, never `text`.
 *
 * The period is brand punctuation — it echoes through the product
 * (handle separators, status indicators) as a tiny consistent
 * gesture. Don't drop it, don't recolor it, don't bold-the-rest-and-
 * leave-it-default.
 */
export function Wordmark({
  variant = 'small',
  tagline,
  color,
}: WordmarkProps): React.JSX.Element {
  const theme = useTheme();
  const isHero = variant === 'hero';
  const size = isHero ? type.display.size : type.title.size;
  const lineHeight = Math.round(size * 0.92);
  const wordColor = color ?? theme.text;

  return (
    <View style={styles.col} accessible accessibilityLabel="speakeasy">
      <Text
        style={[
          styles.word,
          {
            color: wordColor,
            fontSize: size,
            letterSpacing: type.display.letterSpacingEm * size,
            lineHeight,
            fontFamily: font.bold,
          },
        ]}
      >
        speakeasy
        <Text style={{ color: theme.accent }}>.</Text>
      </Text>
      {tagline ? (
        <Text
          style={[
            styles.tagline,
            { color: theme.textMute, fontSize: type.body.size, fontFamily: font.regular },
          ]}
        >
          {tagline}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  col: { alignItems: 'center', gap: 16 },
  word: {},
  tagline: { textAlign: 'center', maxWidth: 320 },
});
