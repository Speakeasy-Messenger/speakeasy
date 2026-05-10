import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Circle, Ellipse, G, Path, Polygon, Rect } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

/**
 * Lure glow — the dangling brass orb pulses in the abyssal dark, the
 * iconic anglerfish move. Halo opacity sweeps 0.2 → 0.6 over 1.6s.
 */
function Lure(): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    return { opacity: 0.2 + t.value * 0.4 };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Circle cx={36} cy={12} r={6} fill={BRASS} />
    </AnimatedG>
  );
}

export const Anglerfish: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Path d="M 50,32 Q 44,18 36,12" stroke={INK} strokeWidth={1.6} fill="none" />
    <Lure />
    <Circle cx={36} cy={12} r={2.6} fill={BRASS} />
    <Circle cx={35.4} cy={11.4} r={0.9} fill={BONE} />
    <Ellipse cx={52} cy={58} rx={32} ry={22} fill={INK} />
    <Circle cx={42} cy={50} r={0.6} fill={BRASS} opacity={0.6} />
    <Circle cx={64} cy={48} r={0.5} fill={BRASS} opacity={0.5} />
    <Circle cx={70} cy={62} r={0.6} fill={BRASS} opacity={0.55} />
    <Circle cx={48} cy={68} r={0.5} fill={BRASS} opacity={0.5} />
    <Circle cx={58} cy={72} r={0.6} fill={BRASS} opacity={0.6} />
    <Path d="M 78,56 Q 90,52 94,58 Q 90,62 78,62 Z" fill={INK} />
    <Polygon points="84,52 96,42 92,58 96,72 84,64" fill={INK} />
    <Path d="M 22,58 L 60,52 L 64,72 L 24,68 Z" fill={INK} />
    <Path d="M 28,60 L 56,56 L 58,68 L 30,66 Z" fill={INK} />
    <Polygon points="26,58 28,62 30,58" fill={BONE} />
    <Polygon points="32,57 34,62 36,57" fill={BONE} />
    <Polygon points="40,55 42,60 44,55" fill={BONE} />
    <Polygon points="48,54 50,59 52,54" fill={BONE} />
    <Polygon points="56,52 58,58 60,53" fill={BONE} />
    <Polygon points="28,68 30,64 32,68" fill={BONE} opacity={0.85} />
    <Polygon points="38,68 40,64 42,68" fill={BONE} opacity={0.85} />
    <Polygon points="48,68 50,64 52,68" fill={BONE} opacity={0.85} />
    <Polygon points="56,67 58,63 60,67" fill={BONE} opacity={0.85} />
    <RNAnimatedG originX={46} originY={62} scaleY={mouthScale}>
      <Rect x={40} y={61} width={12} height={2} fill={INK} />
    </RNAnimatedG>
    <RNAnimatedG originX={44} originY={42} scaleY={eyeScale}>
      <Ellipse cx={44} cy={42} rx={2} ry={2} fill={BONE} />
      <Ellipse cx={44} cy={42} rx={1} ry={1} fill={INK} />
    </RNAnimatedG>
    <RNAnimatedG originX={56} originY={42} scaleY={eyeScale}>
      <Ellipse cx={56} cy={42} rx={2} ry={2} fill={BONE} />
      <Ellipse cx={56} cy={42} rx={1} ry={1} fill={INK} />
    </RNAnimatedG>
  </G>
);
