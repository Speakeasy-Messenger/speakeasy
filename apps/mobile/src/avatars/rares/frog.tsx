import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ellipse, G, Path } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

/**
 * Throat-sac pulse — frogs inflate their vocal sac to call. Per-instance
 * worklet pattern (see turtle.ShellCell) so reanimated tracks a stable
 * hook position. Single instance, but kept as its own component for
 * consistency with the other paid avatars.
 */
function ThroatSac(): React.ReactElement {
  const s = useSharedValue(1);
  useEffect(() => {
    s.value = withRepeat(
      withTiming(1.18, { duration: 1100, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [s]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    return {
      transform: [
        { translateX: 50 },
        { translateY: 68 },
        { scaleY: s.value },
        { translateX: -50 },
        { translateY: -68 },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Ellipse cx={50} cy={68} rx={14} ry={8} fill={BRASS} opacity={0.85} />
      <Ellipse cx={50} cy={68} rx={10} ry={5} fill={INK} opacity={0.12} />
    </AnimatedG>
  );
}

export const Frog: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <ThroatSac />
    <Ellipse cx={50} cy={58} rx={28} ry={14} fill={BRASS} />
    <Ellipse cx={50} cy={52} rx={18} ry={3} fill={BONE} opacity={0.08} />
    <Ellipse cx={38} cy={34} rx={8} ry={9} fill={BRASS} />
    <Ellipse cx={62} cy={34} rx={8} ry={9} fill={BRASS} />
    <RNAnimatedG originX={38} originY={32} scaleY={eyeScale}>
      <Ellipse cx={38} cy={32} rx={4} ry={4} fill={INK} />
      <Ellipse cx={38.6} cy={31.2} rx={1} ry={1} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={62} originY={32} scaleY={eyeScale}>
      <Ellipse cx={62} cy={32} rx={4} ry={4} fill={INK} />
      <Ellipse cx={62.6} cy={31.2} rx={1} ry={1} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={50} originY={60} scaleY={mouthScale}>
      <Path d="M 28,58 Q 50,64 72,58 L 70,60 Q 50,66 30,60 Z" fill={INK} />
    </RNAnimatedG>
  </G>
);
