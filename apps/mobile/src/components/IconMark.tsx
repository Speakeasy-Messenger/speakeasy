import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line } from 'react-native-svg';
import { colors } from '../theme/index.js';

export interface IconMarkProps {
  /** Outer size in px. Default 64. */
  size?: number;
  /** Wrap in a cream rounded shell (app-icon style). Default false. */
  shell?: boolean;
}

/**
 * The Speakeasy icon mark — spec §14 (April 2026):
 *
 *   solid purple disc on the left + parallel horizontal trails fading right.
 *
 * Reads as a signal in the act of dispersing — the visual core of
 * "this won't be here long." Sibling of the Vouchflow mark (two geometric
 * squares = device verification): disc + trail = signal that fades.
 *
 *   - Disc:   fill primary, ~28% of canvas height
 *   - Trails: 6 parallel horizontals, length & opacity decreasing along
 *     primary → soft → 0
 */
export function IconMark({ size = 64, shell = false }: IconMarkProps) {
  // The mark sits in a wider canvas than tall to accommodate the trails.
  const w = size;
  const h = size * 0.5;
  const padX = size * 0.04;

  const discR = h * 0.34;
  const discCx = padX + discR;
  const discCy = h / 2;

  // Trails — start just right of the disc and extend to the right edge.
  const trailStartX = discCx + discR;
  const trailEndX = w - padX;
  const trailSpanX = trailEndX - trailStartX;

  const trailCount = 6;
  const trails = Array.from({ length: trailCount }, (_, i) => {
    const t = i / (trailCount - 1); // 0 → 1
    // Length shrinks toward the tail.
    const len = trailSpanX * (1 - t * 0.6);
    // Vertically distributed across the disc's height; subtle vertical fan.
    const yOffset = (i - (trailCount - 1) / 2) * (discR * 0.55);
    const x1 = trailStartX + 2;
    const x2 = trailStartX + len;
    const y = discCy + yOffset;
    // Opacity fades along primary → soft → 0.
    const opacity = 1 - t * 0.85;
    // Stroke transitions from primary toward soft at the tail.
    const stroke = t < 0.5 ? colors.primary : colors.soft;
    const strokeWidth = Math.max(1.2, h / 28) * (1 - t * 0.4);
    return { x1, x2, y, opacity, stroke, strokeWidth, key: i };
  });

  const svg = (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <Circle cx={discCx} cy={discCy} r={discR} fill={colors.primary} />
      {trails.map((t) => (
        <Line
          key={t.key}
          x1={t.x1}
          y1={t.y}
          x2={t.x2}
          y2={t.y}
          stroke={t.stroke}
          strokeOpacity={t.opacity}
          strokeWidth={t.strokeWidth}
          strokeLinecap="round"
        />
      ))}
    </Svg>
  );

  if (!shell) return svg;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        backgroundColor: colors.cream,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {svg}
    </View>
  );
}
