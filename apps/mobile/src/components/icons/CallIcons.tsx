import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../theme/ThemeProvider.js';

interface IconProps {
  size?: number;
  color?: string;
}

/**
 * Phosphor-style 1.5px-stroke phone receiver. Pointing up-right —
 * matches the brand's other utility icons (paperclip, camera).
 */
export function PhoneIcon({ size = 24, color }: IconProps): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 5 a2 2 0 0 1 2 -2 h2 l2 5 -2.5 1.5 a11 11 0 0 0 6 6 L16 13 l5 2 v2 a2 2 0 0 1 -2 2 A14 14 0 0 1 5 5"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </Svg>
  );
}

/**
 * Phone receiver rotated ~135° — used for the "end call" button.
 * Same path geometry as PhoneIcon, transformed.
 */
export function PhoneEndIcon({ size = 24, color }: IconProps): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 14 a14 14 0 0 1 18 0 l-2 2 -3 -1 -3 2 a8 8 0 0 0 -2 0 l-3 -2 -3 1 z"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </Svg>
  );
}

/** Microphone with stand — used for mute toggle. */
export function MicIcon({
  size = 24,
  color,
  muted,
}: IconProps & { muted?: boolean }): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3 a3 3 0 0 0 -3 3 v6 a3 3 0 0 0 6 0 V6 a3 3 0 0 0 -3 -3 z M6 11 a6 6 0 0 0 12 0 M12 17 v4"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      {muted ? (
        <Path d="M4 4 L20 20" stroke={stroke} strokeWidth={1.5} strokeLinecap="square" />
      ) : null}
    </Svg>
  );
}

/** Speaker icon — used for the loudspeaker toggle. */
export function SpeakerIcon({
  size = 24,
  color,
  active,
}: IconProps & { active?: boolean }): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 9 H7 L13 4 V20 L7 15 H3 z"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
      {active ? (
        <Path
          d="M16 9 a4 4 0 0 1 0 6 M19 6 a8 8 0 0 1 0 12"
          stroke={stroke}
          strokeWidth={1.5}
          strokeLinecap="square"
        />
      ) : null}
    </Svg>
  );
}
