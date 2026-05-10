import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Circle, Ellipse, G, Line, Path, Polygon } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const INK = '#14091A';

/**
 * Antenna sway — a small per-instance worklet that rotates the antenna
 * around its head-attached pivot. Phase offset gives the two antennas a
 * slight lead/lag so they don't move in lock-step.
 */
function Antenna({
  rootX,
  rootY,
  d,
  tipX,
  tipY,
  invert,
  phaseOffset,
}: {
  rootX: number;
  rootY: number;
  d: string;
  tipX: number;
  tipY: number;
  invert: boolean;
  phaseOffset: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const phase = (t.value + phaseOffset) % 1;
    const angle = (invert ? -1 : 1) * Math.sin(phase * Math.PI * 2) * 4;
    return {
      transform: [
        { translateX: rootX },
        { translateY: rootY },
        { rotate: `${angle}deg` },
        { translateX: -rootX },
        { translateY: -rootY },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Path d={d} stroke={BRASS} strokeWidth={1.4} fill="none" />
      <Circle cx={tipX} cy={tipY} r={1.6} fill={BRASS} />
    </AnimatedG>
  );
}

export const Beetle: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Polygon points="24,46 12,38 14,42 26,48" fill={BRASS} opacity={0.85} />
    <Polygon points="22,58 8,58 10,62 24,60" fill={BRASS} opacity={0.85} />
    <Polygon points="24,70 12,76 14,72 26,68" fill={BRASS} opacity={0.85} />
    <Polygon points="76,46 88,38 86,42 74,48" fill={BRASS} opacity={0.85} />
    <Polygon points="78,58 92,58 90,62 76,60" fill={BRASS} opacity={0.85} />
    <Polygon points="76,70 88,76 86,72 74,68" fill={BRASS} opacity={0.85} />
    <Antenna rootX={40} rootY={30} d="M 40,30 L 30,12" tipX={30} tipY={12} invert={false} phaseOffset={0} />
    <Antenna rootX={60} rootY={30} d="M 60,30 L 70,12" tipX={70} tipY={12} invert={true} phaseOffset={0.18} />
    <Ellipse cx={50} cy={34} rx={11} ry={8} fill={BRASS} />
    <Path d="M 50,42 L 24,46 L 22,72 L 50,80 Z" fill={BRASS} />
    <Circle cx={36} cy={58} r={2.4} fill={INK} opacity={0.4} />
    <Circle cx={32} cy={68} r={1.8} fill={INK} opacity={0.4} />
    <Circle cx={42} cy={68} r={1.8} fill={INK} opacity={0.4} />
    <Path d="M 50,42 L 76,46 L 78,72 L 50,80 Z" fill={BRASS} />
    <Circle cx={64} cy={58} r={2.4} fill={INK} opacity={0.4} />
    <Circle cx={68} cy={68} r={1.8} fill={INK} opacity={0.4} />
    <Circle cx={58} cy={68} r={1.8} fill={INK} opacity={0.4} />
    <Line x1={50} y1={42} x2={50} y2={80} stroke={INK} strokeWidth={0.6} opacity={0.4} />
    <RNAnimatedG originX={46} originY={33} scaleY={eyeScale}>
      <Ellipse cx={46} cy={33} rx={1.6} ry={1.6} fill={INK} />
    </RNAnimatedG>
    <RNAnimatedG originX={54} originY={33} scaleY={eyeScale}>
      <Ellipse cx={54} cy={33} rx={1.6} ry={1.6} fill={INK} />
    </RNAnimatedG>
    <RNAnimatedG originX={50} originY={38.5} scaleX={mouthScale}>
      <Path d="M 47,38 L 53,38 L 53,39 L 47,39 Z" fill={INK} />
    </RNAnimatedG>
  </G>
);
