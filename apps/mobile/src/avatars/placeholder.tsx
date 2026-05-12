import React from 'react';
import { Animated } from 'react-native';
import { G, Rect, Text as SvgText } from 'react-native-svg';
import type { AnimalRender } from './types.js';

/**
 * Placeholder render for paid animals whose final illustration is
 * not yet drawn. Shows a brass-on-canvas square with the animal's
 * first letter — so the picker tile reads as "this avatar exists"
 * and the AcquireSheet has something to show on the portrait spot.
 *
 * Replace by adding a real `<animalId>.tsx` under `rares/` or
 * `legendaries/` and registering it in `ANIMALS` (`components.tsx`).
 *
 * Eye / mouth / amplitude props are accepted to satisfy the
 * `AnimalRender` contract; they're intentionally ignored here —
 * a still placeholder is better than a placeholder that pretends
 * to animate.
 */

const AnimatedG = Animated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const INK = '#14091A';

export function makePlaceholder(letter: string): AnimalRender {
  // capture letter into the closure so each call site builds a
  // distinct AnimalRender that draws its own glyph.
  const upper = letter.slice(0, 1).toUpperCase();
  // eslint-disable-next-line react/display-name
  const Placeholder: AnimalRender = ({ eyeScale }) => (
    <G>
      <Rect x={20} y={20} width={60} height={60} fill={BRASS} />
      <Rect x={20} y={20} width={60} height={60} fill={INK} opacity={0.05} />
      <SvgText
        x={50}
        y={64}
        fontSize={42}
        fontFamily="System"
        fill={INK}
        textAnchor="middle"
      >
        {upper}
      </SvgText>
      {/* a single thin breathe band so the placeholder isn't
          deathly still — drives off eyeScale because the renderer
          guarantees that's a real Animated.Value. */}
      <AnimatedG originX={50} originY={80} scaleY={eyeScale}>
        <Rect x={20} y={78} width={60} height={2} fill={INK} opacity={0.2} />
      </AnimatedG>
    </G>
  );
  return Placeholder;
}
