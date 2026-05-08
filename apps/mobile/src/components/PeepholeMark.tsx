import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

/**
 * BLOCK.md §5.1 — the Peephole mark replaces the animal portrait
 * everywhere the blocker sees a blocked user (frozen conversation
 * AppBar, conversation list row, block list, find sheet result for
 * blocked_by_you).
 *
 * Visual: a brass keyhole-style rectangle with a horizontal slit, on
 * a transparent background. Sits inside whatever portrait tile the
 * caller renders around it (we render the mark only — the surface
 * tile + border is a parent concern, matching how PortraitTile
 * wraps animal/room renderers).
 */

interface Props {
  size: number;
  /** Optional opacity override (e.g. 0.6 for the empty-state mark). */
  opacity?: number;
}

const BRASS = '#E5A645';

export function PeepholeMark({ size, opacity = 1 }: Props): React.ReactElement {
  // Stroke a rectangle outline with a horizontal slot cut through
  // the middle. The simplest reliable cross-platform version uses an
  // outer path + an inner path that's drawn with the surface color
  // — but we don't know the surface here. Instead we draw the
  // brass shape, then overlay a transparent slot using even-odd
  // fill on a single path.
  const innerSize = size;
  return (
    <View style={{ width: size, height: size, opacity }}>
      <Svg width={innerSize} height={innerSize} viewBox="0 0 100 100">
        {/* Outer rounded rectangle minus a centered slot. The
            evenOdd fill rule punches the slot out so the parent
            tile's surface bleeds through (transparent slot on
            cream/canvas). */}
        <Path
          d={[
            // Outer: a rectangle 56 wide × 84 tall, slightly
            // rounded corners (3px), centered horizontally.
            'M22 8 L78 8 Q81 8 81 11 L81 89 Q81 92 78 92 L22 92 Q19 92 19 89 L19 11 Q19 8 22 8 Z',
            // Inner: the slot — 60 × 10, centered vertically.
            'M20 45 L80 45 L80 55 L20 55 Z',
          ].join(' ')}
          fill={BRASS}
          fillRule="evenodd"
        />
      </Svg>
    </View>
  );
}
