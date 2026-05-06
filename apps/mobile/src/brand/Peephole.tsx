import React from 'react';
import Svg, { Defs, Mask, Rect } from 'react-native-svg';
import { accent } from '../theme/tokens.js';

/**
 * Peephole — utility / iconography motif. A vertical block with a
 * single horizontal slot. Used for empty states, loading indicators,
 * and the "seal" on a closed/expired conversation. Most reductive of
 * the three marks.
 */
interface Props {
  size?: number;
  color?: string;
}

export function Peephole({ size = 32, color = accent.base }: Props): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <Mask id="peepSlot">
          <Rect width="100" height="100" fill="white" />
          <Rect x={20} y={45} width={60} height={10} fill="black" />
        </Mask>
      </Defs>
      <Rect x={22} y={8} width={56} height={84} rx={3} fill={color} mask="url(#peepSlot)" />
    </Svg>
  );
}
