import React from 'react';
import Svg, { Line } from 'react-native-svg';
import { useTheme } from '../../theme/ThemeProvider.js';

/**
 * Settings affordance — three horizontal stroke bars per
 * BRANDING1.md §8 (stroke-based, 1.5px, square caps + joins). Reads
 * as "settings / more" and matches the Cipher S vocabulary
 * (horizontal bars). No fill.
 *
 * Replaces the ⚙️ emoji that used to live in the conversations
 * header — the emoji broke spec §10 ("emoji as UI elements" forbidden,
 * though emoji in user content is fine).
 */
interface Props {
  size?: number;
  /** Override stroke color. Defaults to `theme.text`. */
  color?: string;
}

export function SettingsIcon({ size = 24, color }: Props): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  // 24×24 viewBox, three bars at y={6, 12, 18}. The middle bar is
  // shorter (length 14 vs 18) — gives a "menu / list / settings"
  // affordance rather than a uniform hamburger menu.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Line
        x1={3}
        y1={6}
        x2={21}
        y2={6}
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
      />
      <Line
        x1={3}
        y1={12}
        x2={17}
        y2={12}
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
      />
      <Line
        x1={3}
        y1={18}
        x2={21}
        y2={18}
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
      />
    </Svg>
  );
}
