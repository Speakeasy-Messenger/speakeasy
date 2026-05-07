import React from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { useColors } from '../theme/index.js';
import { font, type } from '../theme/tokens.js';

/**
 * Brand-locked handle rendering.
 * Spec: BRANDING.md §5.2 (brass `@` punctuation) + §6.1 (AppBar handle).
 *
 *   <Handle value="bento" />           // "@bento"
 *   <Handle value="bento" weight="display" />
 *
 * The brass `@` and the handle text are SEPARATE Text spans — the `@`
 * is a brand glyph, not a typed character. The stored handle never
 * includes the `@`; it gets rendered here as a colored prefix.
 *
 * If you find yourself reaching for `Text>{`@${handle}`}</Text>`
 * anywhere in the codebase, replace it with this component. The brass
 * @ has to come from a separately-colored span, full stop. (BRANDING
 * §10: "rendering a handle without the brass `@` prefix as a separate
 * colored span" is listed as a critical regression.)
 */

interface Props {
  /** The handle, without `@`. Stored canonical form. */
  value: string;
  /**
   * Type-scale variant. `body` is the default for most surfaces;
   * `subtitle` for AppBars; `display` for onboarding's "@bento" screen
   * input + the empty-room "TAP TO SHARE" hero.
   */
  variant?: 'body' | 'subtitle' | 'display' | 'caption';
  /** Override text color. Defaults to `themed.ink`. The `@` always
   * stays brass regardless. */
  color?: string;
  /** Pass-through for custom layout (e.g. flex shrink, numberOfLines
   * via the parent Text). Prefer composing via the parent. */
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}

export function Handle({
  value,
  variant = 'body',
  color,
  style,
  numberOfLines,
}: Props): React.ReactElement {
  const themed = useColors();
  const text = color ?? themed.ink;
  const sized = SIZED[variant];
  return (
    <Text
      style={[styles.base, sized, style]}
      numberOfLines={numberOfLines}
    >
      <Text style={[sized, { color: themed.primary, fontFamily: font.bold }]}>@</Text>
      <Text style={[sized, { color: text, fontFamily: sized.fontFamily }]}>{value}</Text>
    </Text>
  );
}

const SIZED = {
  body: {
    fontFamily: font.medium,
    fontSize: type.body.size,
    letterSpacing: type.body.size * type.body.letterSpacingEm,
  },
  subtitle: {
    fontFamily: font.medium,
    fontSize: type.subtitle.size,
    letterSpacing: type.subtitle.size * type.subtitle.letterSpacingEm,
  },
  display: {
    // Used on the onboarding handle input + the empty-room hero.
    // 30px maps to the spec's "display style, ~30px" rather than the
    // full 56–96 wordmark scale.
    fontFamily: font.bold,
    fontSize: 30,
    letterSpacing: -0.035 * 30,
  },
  caption: {
    fontFamily: font.medium,
    fontSize: type.caption.size,
    letterSpacing: type.caption.size * type.caption.letterSpacingEm,
  },
} as const;

const styles = StyleSheet.create({
  base: {
    // Single Text wrapping two spans. iOS handles inline mixed colors
    // cleanly; Android needs the inner spans to be Text not View.
  },
});
