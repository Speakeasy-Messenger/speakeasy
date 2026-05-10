import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ellipse, G, Line, Path, Polygon, Rect } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

/**
 * Dorsal fin flutter — the small fins along the back ripple in
 * sequence. Each fin gets its own component instance with phaseOffset.
 */
function DorsalFin({
  points,
  phaseOffset,
}: {
  points: string;
  phaseOffset: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.linear }),
      -1,
      false,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const phase = (t.value + phaseOffset) % 1;
    return { opacity: 0.6 + Math.sin(phase * Math.PI * 2) * 0.3 };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Polygon points={points} fill={BRASS} />
    </AnimatedG>
  );
}

export const Seahorse: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <DorsalFin points="48,18 56,12 54,22" phaseOffset={0} />
    <DorsalFin points="52,28 62,22 58,32" phaseOffset={0.2} />
    <DorsalFin points="58,40 68,36 62,46" phaseOffset={0.4} />
    <DorsalFin points="58,52 68,52 62,60" phaseOffset={0.6} />
    <DorsalFin points="50,62 60,66 54,70" phaseOffset={0.8} />
    <Path
      d="M 44,18 Q 56,28 50,42 Q 40,52 50,62 Q 60,70 50,80 Q 42,84 38,90"
      fill="none"
      stroke={BRASS}
      strokeWidth={9}
      strokeLinecap="round"
    />
    <Line x1={46} y1={26} x2={52} y2={28} stroke={INK} strokeWidth={0.5} opacity={0.3} />
    <Line x1={50} y1={36} x2={48} y2={42} stroke={INK} strokeWidth={0.5} opacity={0.3} />
    <Line x1={44} y1={48} x2={50} y2={50} stroke={INK} strokeWidth={0.5} opacity={0.3} />
    <Line x1={50} y1={58} x2={54} y2={62} stroke={INK} strokeWidth={0.5} opacity={0.3} />
    <Line x1={50} y1={72} x2={46} y2={76} stroke={INK} strokeWidth={0.5} opacity={0.3} />
    <Path
      d="M 38,90 Q 32,92 32,86 Q 32,82 38,82"
      fill="none"
      stroke={BRASS}
      strokeWidth={6}
      strokeLinecap="round"
    />
    <Ellipse cx={42} cy={20} rx={9} ry={7} fill={BRASS} />
    <Rect x={22} y={18} width={22} height={5} fill={BRASS} />
    <Polygon points="22,18 18,20 22,23" fill={BRASS} />
    <Polygon points="44,12 46,4 48,12" fill={BRASS} />
    <Polygon points="40,14 42,8 44,14" fill={BRASS} opacity={0.85} />
    <RNAnimatedG originX={44} originY={20} scaleY={eyeScale}>
      <Ellipse cx={44} cy={20} rx={1.6} ry={1.6} fill={INK} />
      <Ellipse cx={44.4} cy={19.5} rx={0.5} ry={0.5} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={21.5} originY={20.5} scaleX={mouthScale}>
      <Rect x={20} y={20} width={3} height={1} fill={INK} />
    </RNAnimatedG>
  </G>
);
