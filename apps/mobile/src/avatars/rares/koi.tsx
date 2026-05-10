import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ellipse, G, Path, Rect } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

const TAIL_PIVOT = { x: 78, y: 56 };

/**
 * Per-fin component. Same hooks-isolation rationale as turtle's
 * ShellCell — closure-captured `phaseOffset` inside a loop-style
 * custom hook tripped reanimated's worklet-tracking and produced
 * mismatched hook counts across renders.
 */
function FinStrand({
  d,
  opacity,
  phaseOffset,
}: {
  d: string;
  opacity: number;
  phaseOffset: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 3000, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const angle = Math.sin((t.value + phaseOffset) * Math.PI * 2) * 5;
    return {
      transform: [
        { translateX: TAIL_PIVOT.x },
        { translateY: TAIL_PIVOT.y },
        { rotate: `${angle}deg` },
        { translateX: -TAIL_PIVOT.x },
        { translateY: -TAIL_PIVOT.y },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Path d={d} fill={BRASS} opacity={opacity} />
    </AnimatedG>
  );
}

export const Koi: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <FinStrand d="M 78,52 Q 92,42 96,30 L 94,32 Q 90,42 78,54 Z" opacity={0.85} phaseOffset={0} />
    <FinStrand d="M 80,54 Q 96,52 98,42 L 96,42 Q 92,52 80,56 Z" opacity={0.78} phaseOffset={0.15} />
    <FinStrand d="M 80,58 Q 96,62 98,72 L 96,72 Q 92,62 80,60 Z" opacity={0.78} phaseOffset={0.3} />
    <FinStrand d="M 78,60 Q 92,72 96,82 L 94,82 Q 90,72 78,62 Z" opacity={0.85} phaseOffset={0.45} />
    <Path d="M 18,52 Q 32,40 50,46 Q 70,52 80,52 Q 70,60 50,62 Q 32,68 18,56 Z" fill={BRASS} />
    <Ellipse cx={38} cy={50} rx={5} ry={3} fill={INK} opacity={0.4} />
    <Ellipse cx={58} cy={58} rx={4} ry={2.5} fill={INK} opacity={0.4} />
    <Ellipse cx={50} cy={48} rx={3} ry={2} fill={BONE} opacity={0.55} />
    <Path d="M 22,56 Q 40,62 70,58" stroke={INK} strokeWidth={0.6} fill="none" opacity={0.25} />
    <Path d="M 36,46 L 32,38 L 42,42 Z" fill={BRASS} opacity={0.9} />
    <Path d="M 50,44 L 48,34 L 56,40 Z" fill={BRASS} opacity={0.9} />
    <Path d="M 64,46 L 64,38 L 70,44 Z" fill={BRASS} opacity={0.9} />
    <Path d="M 42,62 L 40,72 L 48,64 Z" fill={BRASS} opacity={0.7} />
    <Path d="M 28,54 Q 22,64 18,68 L 22,62 Q 26,58 30,56 Z" fill={BRASS} opacity={0.85} />
    <Path d="M 18,52 Q 14,50 10,52 Q 14,56 18,56 Z" fill={BRASS} />
    <RNAnimatedG originX={20} originY={51} scaleY={eyeScale}>
      <Ellipse cx={20} cy={51} rx={1.6} ry={1.6} fill={INK} />
      <Ellipse cx={20.4} cy={50.5} rx={0.5} ry={0.5} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={12.5} originY={53.9} scaleX={mouthScale}>
      <Rect x={11} y={53.5} width={3} height={0.8} fill={INK} />
    </RNAnimatedG>
    <Path d="M 12,54 Q 8,58 6,62" stroke={BRASS} strokeWidth={0.6} fill="none" opacity={0.7} />
    <Path d="M 14,55 Q 10,60 8,64" stroke={BRASS} strokeWidth={0.6} fill="none" opacity={0.6} />
  </G>
);
