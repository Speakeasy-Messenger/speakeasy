import React from 'react';
import Svg, { Path, Rect, Circle } from 'react-native-svg';
import { useTheme } from '../../theme/ThemeProvider.js';

/**
 * Stroke-based icons for the chat input bar — Phosphor-style
 * (1.5px stroke, square caps + joins) per BRANDING1.md §8. No fills.
 *
 * Three icons:
 *
 *  - `GifIcon` — square with a "GIF" wordmark inside. Sits to the
 *    LEFT of the text input, opens the Tenor sheet.
 *  - `PaperclipIcon` — classic paperclip arc. Right of the input,
 *    opens the photos/files picker.
 *  - `CameraIcon` — body + lens circle + viewfinder bump. Right-most,
 *    launches the device camera.
 */
interface IconProps {
  size?: number;
  color?: string;
}

export function GifIcon({ size = 24, color }: IconProps): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={5}
        width={18}
        height={14}
        rx={1}
        stroke={stroke}
        strokeWidth={1.5}
      />
      {/* G */}
      <Path
        d="M9 9 H6.5 V15 H9 V12.5 H7.7"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
      {/* I */}
      <Path
        d="M11.5 9 V15"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
      />
      {/* F */}
      <Path
        d="M14 15 V9 H17.5 M14 12 H16.5"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </Svg>
  );
}

export function PaperclipIcon({ size = 24, color }: IconProps): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  // Diagonal paperclip arc — single open path. Top loop curls down,
  // straight stem ends with a small left curl at the bottom.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M16.5 6.5 L9 14 a3 3 0 0 0 4.2 4.2 L19.5 12 a4.5 4.5 0 0 0 -6.4 -6.4 L7 12 a4.5 4.5 0 0 0 6.4 6.4"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="square"
        strokeLinejoin="miter"
        fill="none"
      />
    </Svg>
  );
}

export function CameraIcon({ size = 24, color }: IconProps): React.JSX.Element {
  const theme = useTheme();
  const stroke = color ?? theme.text;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Body */}
      <Rect
        x={3}
        y={7}
        width={18}
        height={13}
        rx={1}
        stroke={stroke}
        strokeWidth={1.5}
      />
      {/* Viewfinder bump */}
      <Path
        d="M8 7 L9 4 H15 L16 7"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="miter"
        strokeLinecap="square"
      />
      {/* Lens */}
      <Circle cx={12} cy={13.5} r={3.5} stroke={stroke} strokeWidth={1.5} />
    </Svg>
  );
}
