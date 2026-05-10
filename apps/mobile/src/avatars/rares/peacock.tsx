import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Circle, Ellipse, G, Path, Polygon } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

/**
 * Tail-eye shimmer — each of the 7 fan eyes pulses brightness with a
 * phase offset, so the brightening sweeps across the fan. Same per-
 * instance pattern as koi.FinStrand.
 */
function TailEye({
  cx,
  cy,
  phaseOffset,
}: {
  cx: number;
  cy: number;
  phaseOffset: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 2800, easing: Easing.linear }),
      -1,
      false,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const phase = (t.value + phaseOffset) % 1;
    return { opacity: 0.6 + Math.sin(phase * Math.PI * 2) * 0.4 };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Ellipse cx={cx} cy={cy} rx={3} ry={3.5} fill={BONE} />
      <Ellipse cx={cx} cy={cy} rx={1.4} ry={1.6} fill={INK} />
    </AnimatedG>
  );
}

export const Peacock: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Path d="M 50,60 L 6,40 L 8,18 L 50,28 L 92,18 L 94,40 Z" fill={BRASS} opacity={0.85} />
    <TailEye cx={14} cy={32} phaseOffset={0} />
    <TailEye cx={26} cy={28} phaseOffset={0.14} />
    <TailEye cx={38} cy={26} phaseOffset={0.28} />
    <TailEye cx={50} cy={24} phaseOffset={0.42} />
    <TailEye cx={62} cy={26} phaseOffset={0.56} />
    <TailEye cx={74} cy={28} phaseOffset={0.7} />
    <TailEye cx={86} cy={32} phaseOffset={0.84} />
    <Path d="M 42,56 L 58,56 L 56,86 L 44,86 Z" fill={BRASS} />
    <Ellipse cx={50} cy={50} rx={9} ry={8} fill={BRASS} />
    <Polygon points="48,42 50,32 52,42" fill={BRASS} />
    <Circle cx={50} cy={32} r={1.2} fill={BONE} />
    <Polygon points="50,52 50,58 54,55" fill={INK} />
    <RNAnimatedG originX={46} originY={48} scaleY={eyeScale}>
      <Ellipse cx={46} cy={48} rx={1.4} ry={1.4} fill={INK} />
    </RNAnimatedG>
    <RNAnimatedG originX={54} originY={48} scaleY={eyeScale}>
      <Ellipse cx={54} cy={48} rx={1.4} ry={1.4} fill={INK} />
    </RNAnimatedG>
    <RNAnimatedG originX={51} originY={55} scaleY={mouthScale}>
      <Polygon points="50,53 52,56 50,57" fill={INK} />
    </RNAnimatedG>
  </G>
);
