import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ellipse, G, Path, Polygon } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';
const VERMILLION = '#C8413A';

/**
 * Flame flicker — each tail/wing flame layer pulses opacity at a
 * different phase, so the bird looks like it's burning. Faster cycle
 * (1.1s) than other paid avatars to match flame physics.
 */
function Flame({
  points,
  baseOpacity,
  phaseOffset,
}: {
  points: string;
  baseOpacity: number;
  phaseOffset: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.linear }),
      -1,
      false,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const phase = (t.value + phaseOffset) % 1;
    const flicker = Math.sin(phase * Math.PI * 2) * 0.25;
    return { opacity: Math.max(0.3, baseOpacity + flicker) };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Polygon points={points} fill={VERMILLION} />
    </AnimatedG>
  );
}

export const Phoenix: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Flame points="50,68 48,98 52,98" baseOpacity={1} phaseOffset={0} />
    <Flame points="44,68 36,96 48,96" baseOpacity={0.92} phaseOffset={0.1} />
    <Flame points="56,68 64,96 52,96" baseOpacity={0.92} phaseOffset={0.18} />
    <Flame points="40,68 28,90 44,92" baseOpacity={0.78} phaseOffset={0.28} />
    <Flame points="60,68 72,90 56,92" baseOpacity={0.78} phaseOffset={0.36} />
    <Polygon points="50,96 49,99 51,99" fill={BRASS} />
    <Polygon points="42,94 38,98 46,96" fill={BRASS} opacity={0.7} />
    <Polygon points="58,94 62,98 54,96" fill={BRASS} opacity={0.7} />
    <Path d="M 42,46 L 58,46 L 56,68 L 44,68 Z" fill={VERMILLION} />
    <Polygon points="46,52 54,52 50,58" fill={INK} opacity={0.32} />
    <Polygon points="46,58 54,58 50,64" fill={INK} opacity={0.22} />
    <Flame points="42,48 22,42 26,56 42,58" baseOpacity={1} phaseOffset={0.42} />
    <Flame points="42,42 16,32 22,46 42,50" baseOpacity={0.92} phaseOffset={0.5} />
    <Flame points="42,38 12,22 18,36 42,44" baseOpacity={0.85} phaseOffset={0.58} />
    <Flame points="42,32 8,12 14,28 42,38" baseOpacity={0.75} phaseOffset={0.66} />
    <Flame points="42,28 6,4 10,20 42,34" baseOpacity={0.65} phaseOffset={0.74} />
    <Flame points="58,48 78,42 74,56 58,58" baseOpacity={1} phaseOffset={0.46} />
    <Flame points="58,42 84,32 78,46 58,50" baseOpacity={0.92} phaseOffset={0.54} />
    <Flame points="58,38 88,22 82,36 58,44" baseOpacity={0.85} phaseOffset={0.62} />
    <Flame points="58,32 92,12 86,28 58,38" baseOpacity={0.75} phaseOffset={0.7} />
    <Flame points="58,28 94,4 90,20 58,34" baseOpacity={0.65} phaseOffset={0.78} />
    <Polygon points="50,28 46,8 50,18 54,8" fill={BRASS} />
    <Polygon points="44,28 38,12 44,22" fill={BRASS} opacity={0.92} />
    <Polygon points="56,28 62,12 56,22" fill={BRASS} opacity={0.92} />
    <Path d="M 42,28 L 58,28 L 56,46 L 44,46 Z" fill={VERMILLION} />
    <RNAnimatedG originX={50} originY={46} scaleY={mouthScale}>
      <Polygon points="46,42 54,42 50,50" fill={INK} />
    </RNAnimatedG>
    <RNAnimatedG originX={46} originY={36} scaleY={eyeScale}>
      <Ellipse cx={46} cy={36} rx={1.8} ry={1.8} fill={INK} />
      <Ellipse cx={46.4} cy={35.6} rx={0.5} ry={0.5} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={54} originY={36} scaleY={eyeScale}>
      <Ellipse cx={54} cy={36} rx={1.8} ry={1.8} fill={INK} />
      <Ellipse cx={54.4} cy={35.6} rx={0.5} ry={0.5} fill={BONE} />
    </RNAnimatedG>
  </G>
);
