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

const TAIL_PIVOT = { x: 70, y: 62 };
const TWITCH_THRESHOLD = 0.5;
const TWITCH_COOLDOWN_MS = 280;
const TWITCH_MAX_DEG = 6;

/**
 * Bushy tail twitch — squirrels are skittish. Same amplitude-driven
 * pattern as lynx.Tuft: random small flicks on speech, rests at 0
 * between calls.
 */
function Tail({
  amplitude,
}: {
  amplitude: AnimalRenderProps['amplitude'];
}): React.ReactElement {
  const angle = useSharedValue(0);
  useEffect(() => {
    if (!(amplitude instanceof RNAnimated.Value)) return undefined;
    let cooldownUntil = 0;
    const id = amplitude.addListener(({ value }) => {
      if (value <= TWITCH_THRESHOLD) return;
      const now = Date.now();
      if (now <= cooldownUntil) return;
      if (Math.random() >= 0.4) return;
      angle.value = (Math.random() - 0.5) * 2 * TWITCH_MAX_DEG;
      angle.value = withTiming(0, {
        duration: 240,
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
        { translateX: TAIL_PIVOT.x },
        { translateY: TAIL_PIVOT.y },
        { rotate: `${angle.value}deg` },
        { translateX: -TAIL_PIVOT.x },
        { translateY: -TAIL_PIVOT.y },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Path
        d="M 70,80 Q 92,70 92,40 Q 92,18 72,12 Q 60,12 64,28 Q 76,32 78,46 Q 78,58 68,68 Z"
        fill={BRASS}
      />
      <Path d="M 76,30 Q 84,38 82,52" fill="none" stroke={INK} strokeWidth={0.8} opacity={0.25} />
      <Path d="M 70,18 Q 76,26 76,40" fill="none" stroke={INK} strokeWidth={0.8} opacity={0.25} />
    </AnimatedG>
  );
}

export const Squirrel: AnimalRender = ({ eyeScale, mouthScale, amplitude }) => (
  <G>
    <Tail amplitude={amplitude} />
    <Ellipse cx={44} cy={68} rx={20} ry={20} fill={BRASS} />
    <Ellipse cx={40} cy={80} rx={4} ry={6} fill={BRASS} />
    <Ellipse cx={48} cy={80} rx={4} ry={6} fill={BRASS} />
    <Ellipse cx={44} cy={74} rx={14} ry={6} fill={INK} opacity={0.12} />
    <Ellipse cx={38} cy={44} rx={14} ry={13} fill={BRASS} />
    <Polygon points="28,32 26,22 32,30" fill={BRASS} />
    <Polygon points="46,32 48,22 42,30" fill={BRASS} />
    <Polygon points="29,29 28,24 31,28" fill={INK} opacity={0.4} />
    <Polygon points="45,29 46,24 43,28" fill={INK} opacity={0.4} />
    <Ellipse cx={32} cy={48} rx={4} ry={3} fill={BONE} opacity={0.1} />
    <RNAnimatedG originX={34} originY={42} scaleY={eyeScale}>
      <Ellipse cx={34} cy={42} rx={2} ry={2} fill={INK} />
      <Ellipse cx={34.4} cy={41.5} rx={0.5} ry={0.5} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={42} originY={42} scaleY={eyeScale}>
      <Ellipse cx={42} cy={42} rx={2} ry={2} fill={INK} />
      <Ellipse cx={42.4} cy={41.5} rx={0.5} ry={0.5} fill={BONE} />
    </RNAnimatedG>
    <Ellipse cx={38} cy={50} rx={1.4} ry={1} fill={INK} />
    <RNAnimatedG originX={38} originY={54} scaleY={mouthScale}>
      <Path d="M 35,52 L 41,52 L 39,55 L 37,55 Z" fill={INK} />
    </RNAnimatedG>
    <Rect x={36.5} y={53} width={3} height={2} fill={BONE} />
  </G>
);
