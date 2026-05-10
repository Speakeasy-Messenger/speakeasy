import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { Circle, Ellipse, G, Path, Polygon, Rect } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const INK = '#14091A';

/**
 * Tongue flick — most of the time invisible; every ~2.5s it shoots out
 * for ~250ms. Loop runs continuously while the avatar is mounted.
 */
function Tongue(): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withSequence(
        withTiming(0, { duration: 2300 }),
        withTiming(1, { duration: 120, easing: Easing.out(Easing.quad) }),
        withTiming(0, { duration: 200, easing: Easing.in(Easing.quad) }),
      ),
      -1,
      false,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    return {
      opacity: t.value,
      transform: [{ scaleX: t.value }],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Path
        d="M 50,46 L 58,52 L 56,53 L 50,48 L 44,53 L 42,52 Z"
        fill={INK}
      />
    </AnimatedG>
  );
}

export const Snake: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Path
      d="M 50,90 Q 22,90 22,70 Q 22,52 42,52 Q 56,52 56,62 Q 56,68 50,68"
      fill="none"
      stroke={BRASS}
      strokeWidth={8}
      strokeLinecap="round"
    />
    <Path d="M 50,90 Q 78,90 78,72" fill="none" stroke={BRASS} strokeWidth={8} strokeLinecap="round" opacity={0.85} />
    <Circle cx={32} cy={80} r={1.4} fill={INK} opacity={0.3} />
    <Circle cx={42} cy={86} r={1.4} fill={INK} opacity={0.3} />
    <Circle cx={60} cy={86} r={1.4} fill={INK} opacity={0.3} />
    <Circle cx={70} cy={80} r={1.4} fill={INK} opacity={0.3} />
    <Path d="M 38,46 L 62,46 L 56,30 L 44,30 Z" fill={BRASS} />
    <Polygon points="44,30 56,30 50,22" fill={BRASS} />
    <Polygon points="40,38 42,30 44,38" fill={INK} opacity={0.25} />
    <Polygon points="60,38 58,30 56,38" fill={INK} opacity={0.25} />
    <RNAnimatedG originX={43} originY={38} scaleY={eyeScale}>
      <Ellipse cx={43} cy={38} rx={2} ry={2} fill={INK} />
      <Rect x={42.4} y={36.8} width={1.2} height={2.4} fill={BRASS} />
    </RNAnimatedG>
    <RNAnimatedG originX={57} originY={38} scaleY={eyeScale}>
      <Ellipse cx={57} cy={38} rx={2} ry={2} fill={INK} />
      <Rect x={56.4} y={36.8} width={1.2} height={2.4} fill={BRASS} />
    </RNAnimatedG>
    <RNAnimatedG originX={50} originY={44.5} scaleX={mouthScale}>
      <Rect x={46} y={44} width={8} height={1} fill={INK} />
    </RNAnimatedG>
    <Tongue />
  </G>
);
