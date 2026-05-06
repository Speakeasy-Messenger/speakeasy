import React from 'react';
import Svg, { Defs, Mask, Path, Rect } from 'react-native-svg';
import { accent } from '../theme/tokens.js';

/**
 * Door — secondary / stamp mark. A forward-leaning parallelogram with
 * two redaction-slot openings. Used on splash, onboarding moments, and
 * "verified room" indicators.
 */
interface Props {
  size?: number;
  color?: string;
}

export function Door({ size = 32, color = accent.base }: Props): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <Mask id="doorSlots">
          <Rect width="100" height="100" fill="white" />
          <Rect x={35} y={32} width={44} height={8} fill="black" />
          <Rect x={17} y={60} width={44} height={8} fill="black" />
        </Mask>
      </Defs>
      <Path d="M5,10 L75,10 L85,90 L15,90 Z" fill={color} mask="url(#doorSlots)" />
    </Svg>
  );
}
