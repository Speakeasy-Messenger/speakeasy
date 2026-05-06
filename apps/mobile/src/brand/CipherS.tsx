import React from 'react';
import Svg, { Rect } from 'react-native-svg';
import { accent } from '../theme/tokens.js';

/**
 * Cipher S — primary brand mark. Three offset bars forming an
 * abstract "S" / three-redacted-bars motif. Default to brass; pass an
 * explicit color when the surface needs something else (the spec
 * says brass is canonical on dark, light, and brand canvases —
 * overrides should be rare).
 */
interface Props {
  size?: number;
  color?: string;
}

export function CipherS({ size = 32, color = accent.base }: Props): React.JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Rect x={5} y={20} width={60} height={14} fill={color} />
      <Rect x={35} y={43} width={60} height={14} fill={color} />
      <Rect x={5} y={66} width={60} height={14} fill={color} />
    </Svg>
  );
}
