import React from 'react';
import Svg, { Path } from 'react-native-svg';

/**
 * Bell-with-slash glyph — marks a muted conversation in the
 * conversation list and the chat header. Thin geometric line work to
 * match the brand's other icons; `color` is the caller's choice
 * (typically `text-mute`). Sized small — it's a quiet status mark,
 * not an action.
 */
export function MutedIcon({
  size = 14,
  color,
}: {
  size?: number;
  color: string;
}): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* Bell body. */}
      <Path
        d="M7 16.5 V10.5 a5 5 0 0 1 10 0 V16.5 l1.5 1.5 H5.5 Z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="miter"
      />
      {/* Clapper. */}
      <Path
        d="M10 19 a2 2 0 0 0 4 0"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="square"
      />
      {/* The "muted" slash. */}
      <Path
        d="M4 4 L20 20"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="square"
      />
    </Svg>
  );
}
