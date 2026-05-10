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

const TWITCH_THRESHOLD = 0.55;
const TWITCH_COOLDOWN_MS = 250;
const TWITCH_MAX_DEG = 8;

/**
 * Per-tuft component. Same hooks-isolation pattern as turtle's
 * ShellCell — pulling the worklet into its own component instance
 * sidesteps the babel-transform IIFE that tripped reanimated's
 * worklet-subscription tracking.
 */
function Tuft({
  amplitude,
  pivotX,
  pivotY,
  points,
}: {
  amplitude: AnimalRenderProps['amplitude'];
  pivotX: number;
  pivotY: number;
  points: string;
}): React.ReactElement {
  const angle = useSharedValue(0);
  useEffect(() => {
    if (!(amplitude instanceof RNAnimated.Value)) return undefined;
    let cooldownUntil = 0;
    const id = amplitude.addListener(({ value }) => {
      if (value <= TWITCH_THRESHOLD) return;
      const now = Date.now();
      if (now <= cooldownUntil) return;
      if (Math.random() >= 0.5) return;
      angle.value = (Math.random() - 0.5) * 2 * TWITCH_MAX_DEG;
      angle.value = withTiming(0, {
        duration: 220,
        easing: Easing.out(Easing.quad),
      });
      cooldownUntil = now + TWITCH_COOLDOWN_MS;
    });
    return () => amplitude.removeListener(id);
  }, [amplitude, angle]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    return {
      transform: [
        { translateX: pivotX },
        { translateY: pivotY },
        { rotate: `${angle.value}deg` },
        { translateX: -pivotX },
        { translateY: -pivotY },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Polygon points={points} fill={BRASS} />
    </AnimatedG>
  );
}

export const Lynx: AnimalRender = ({ eyeScale, mouthScale, amplitude }) => (
  <G>
    <Polygon points="28,38 38,18 42,40" fill={BRASS} />
    <Polygon points="72,38 62,18 58,40" fill={BRASS} />
    <Polygon points="32,34 38,24 40,36" fill={INK} opacity={0.4} />
    <Polygon points="68,34 62,24 60,36" fill={INK} opacity={0.4} />
    <Tuft amplitude={amplitude} pivotX={38} pivotY={18} points="38,18 36,2 40,16" />
    <Tuft amplitude={amplitude} pivotX={62} pivotY={18} points="62,18 64,2 60,16" />
    <Path d="M 32,40 L 68,40 L 64,68 L 56,76 L 44,76 L 36,68 Z" fill={BRASS} />
    <Polygon points="32,52 22,58 32,60" fill={BRASS} opacity={0.85} />
    <Polygon points="68,52 78,58 68,60" fill={BRASS} opacity={0.85} />
    <Polygon points="36,58 32,68 38,64" fill={INK} opacity={0.18} />
    <Polygon points="64,58 68,68 62,64" fill={INK} opacity={0.18} />
    <Rect x={36} y={46} width={28} height={1} fill={INK} opacity={0.3} />
    <RNAnimatedG originX={42} originY={50} scaleY={eyeScale}>
      <Ellipse cx={42} cy={50} rx={2.4} ry={2.4} fill={INK} />
      <Ellipse cx={42.4} cy={49.4} rx={0.6} ry={0.6} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={58} originY={50} scaleY={eyeScale}>
      <Ellipse cx={58} cy={50} rx={2.4} ry={2.4} fill={INK} />
      <Ellipse cx={58.4} cy={49.4} rx={0.6} ry={0.6} fill={BONE} />
    </RNAnimatedG>
    <Polygon points="48,58 52,58 50,62" fill={INK} />
    <RNAnimatedG originX={50} originY={68} scaleY={mouthScale}>
      <Path d="M 46,66 L 54,66 L 52,70 L 48,70 Z" fill={INK} />
    </RNAnimatedG>
  </G>
);
