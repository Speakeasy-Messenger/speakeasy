import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Ellipse, G, Path, Polygon, Rect } from 'react-native-svg';
import type { AnimalRender, AnimalRenderProps } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

const PINCH_THRESHOLD = 0.55;
const PINCH_COOLDOWN_MS = 320;
const PINCH_MAX_DEG = 9;

/**
 * Pincer pinch — crabs snap their claws when alert. Amplitude-driven,
 * with a hinge at the claw root so the upper jaw lifts then snaps shut.
 */
function Pincer({
  amplitude,
  invert,
}: {
  amplitude: AnimalRenderProps['amplitude'];
  invert: boolean;
}): React.ReactElement {
  const angle = useSharedValue(0);
  useEffect(() => {
    if (!(amplitude instanceof RNAnimated.Value)) return undefined;
    let cooldownUntil = 0;
    const id = amplitude.addListener(({ value }) => {
      if (value <= PINCH_THRESHOLD) return;
      const now = Date.now();
      if (now <= cooldownUntil) return;
      if (Math.random() >= 0.45) return;
      angle.value = (invert ? -1 : 1) * Math.random() * PINCH_MAX_DEG;
      angle.value = withTiming(0, {
        duration: 200,
        easing: Easing.out(Easing.quad),
      });
      cooldownUntil = now + PINCH_COOLDOWN_MS;
    });
    return () => amplitude.removeListener(id);
  }, [amplitude, angle, invert]);
  const pivotX = invert ? 86 : 14;
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    return {
      transform: [
        { translateX: pivotX },
        { translateY: 26 },
        { rotate: `${angle.value}deg` },
        { translateX: -pivotX },
        { translateY: -26 },
      ],
    };
  });
  return invert ? (
    <AnimatedG animatedProps={animatedProps}>
      <Rect x={72} y={28} width={14} height={6} fill={BRASS} transform="rotate(15 86 28)" />
      <Path d="M 92,26 L 82,18 L 86,28 L 84,32 Z" fill={BRASS} />
      <Path d="M 92,26 L 84,30 L 86,32 L 94,30 Z" fill={BRASS} transform="rotate(18 86 26)" />
    </AnimatedG>
  ) : (
    <AnimatedG animatedProps={animatedProps}>
      <Rect x={14} y={28} width={14} height={6} fill={BRASS} transform="rotate(-15 14 28)" />
      <Path d="M 8,26 L 18,18 L 14,28 L 16,32 Z" fill={BRASS} />
      <Path d="M 8,26 L 16,30 L 14,32 L 6,30 Z" fill={BRASS} transform="rotate(-18 14 26)" />
    </AnimatedG>
  );
}

export const Crab: AnimalRender = ({ eyeScale, mouthScale, amplitude }) => (
  <G>
    <Polygon points="22,52 8,42 12,40 24,50" fill={BRASS} opacity={0.85} />
    <Polygon points="22,58 6,58 8,54 24,56" fill={BRASS} opacity={0.85} />
    <Polygon points="22,64 8,72 12,74 24,66" fill={BRASS} opacity={0.85} />
    <Polygon points="78,52 92,42 88,40 76,50" fill={BRASS} opacity={0.85} />
    <Polygon points="78,58 94,58 92,54 76,56" fill={BRASS} opacity={0.85} />
    <Polygon points="78,64 92,72 88,74 76,66" fill={BRASS} opacity={0.85} />
    <Pincer amplitude={amplitude} invert={false} />
    <Pincer amplitude={amplitude} invert={true} />
    <Ellipse cx={50} cy={58} rx={22} ry={16} fill={BRASS} />
    <Ellipse cx={50} cy={56} rx={14} ry={3} fill={BONE} opacity={0.08} />
    <Ellipse cx={44} cy={64} rx={2} ry={1.4} fill={INK} opacity={0.2} />
    <Ellipse cx={56} cy={64} rx={2} ry={1.4} fill={INK} opacity={0.2} />
    <Ellipse cx={50} cy={68} rx={2} ry={1.4} fill={INK} opacity={0.2} />
    <Rect x={43} y={42} width={1.4} height={6} fill={BRASS} />
    <Rect x={55.6} y={42} width={1.4} height={6} fill={BRASS} />
    <RNAnimatedG originX={43.7} originY={42} scaleY={eyeScale}>
      <Ellipse cx={43.7} cy={42} rx={2.4} ry={2.4} fill={INK} />
      <Ellipse cx={44} cy={41.5} rx={0.6} ry={0.6} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={56.3} originY={42} scaleY={eyeScale}>
      <Ellipse cx={56.3} cy={42} rx={2.4} ry={2.4} fill={INK} />
      <Ellipse cx={56.6} cy={41.5} rx={0.6} ry={0.6} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={50} originY={58.7} scaleX={mouthScale}>
      <Rect x={47} y={58} width={6} height={1.4} fill={INK} />
    </RNAnimatedG>
  </G>
);
