import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';
import { type } from './tokens.js';
import { useTheme } from './ThemeProvider.js';

/**
 * Typed text helpers. One per scale entry in `tokens.type`. Each
 * resolves to the right Bricolage weight + size + tracking, and
 * defaults the color to `theme.text` (workspace foreground). Pass
 * `tone="mute"` for secondary text or `tone="accent"` for the
 * `meta`-style "leaves in Xs" / brass status copy. Pass `style` for
 * positioning overrides; do NOT override font/size/weight here —
 * use a different scale entry instead.
 */

type Tone = 'default' | 'mute' | 'accent' | 'inherit';

interface BaseProps extends Omit<RNTextProps, 'style'> {
  tone?: Tone;
  style?: TextStyle | TextStyle[];
  children?: React.ReactNode;
}

function makeText(
  spec: { size: number; weight: string; letterSpacingEm: number; uppercase?: boolean },
  testID?: string,
) {
  return function Typed({ tone = 'default', style, children, ...rest }: BaseProps) {
    const theme = useTheme();
    const color =
      tone === 'mute'
        ? theme.textMute
        : tone === 'accent'
          ? theme.accent
          : tone === 'inherit'
            ? undefined
            : theme.text;
    const base: TextStyle = {
      fontFamily: spec.weight,
      fontSize: spec.size,
      letterSpacing: spec.letterSpacingEm * spec.size,
      color,
      textTransform: spec.uppercase ? 'uppercase' : undefined,
    };
    return (
      <RNText {...rest} testID={testID ?? rest.testID} style={[base, style as TextStyle]}>
        {children}
      </RNText>
    );
  };
}

export const TextDisplay = makeText(type.display);
export const TextTitle = makeText(type.title);
export const TextSubtitle = makeText(type.subtitle);
export const TextBody = makeText(type.body);
export const TextBodyEmphasis = makeText(type.bodyEmphasis);
export const TextCaption = makeText(type.caption);
export const TextMeta = makeText(type.meta);
export const TextHandle = makeText(type.handle);
