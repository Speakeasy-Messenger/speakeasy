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
const OXBLOOD = '#7E2D40';

/**
 * Mane sway — the spiked mane around the head sways gently as if in a
 * slow current. Rotation pivots at the head center so spikes near the
 * top and bottom move in opposite arcs.
 */
function ManeSpike({
  points,
  opacity,
  phaseOffset,
}: {
  points: string;
  opacity: number;
  phaseOffset: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 3200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const phase = (t.value + phaseOffset) % 1;
    const angle = Math.sin(phase * Math.PI * 2) * 2.5;
    return {
      transform: [
        { translateX: 50 },
        { translateY: 40 },
        { rotate: `${angle}deg` },
        { translateX: -50 },
        { translateY: -40 },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Polygon points={points} fill={OXBLOOD} opacity={opacity} />
    </AnimatedG>
  );
}

export const Manticore: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Path
      d="M 36,40 L 8,28 L 4,42 L 14,46 L 6,52 L 18,52 L 12,60 L 24,56 L 22,64 L 38,52 Z"
      fill={OXBLOOD}
    />
    <Path d="M 36,40 L 14,38 L 18,52 L 36,48 Z" fill={INK} opacity={0.2} />
    <Path
      d="M 64,40 L 92,28 L 96,42 L 86,46 L 94,52 L 82,52 L 88,60 L 76,56 L 78,64 L 62,52 Z"
      fill={OXBLOOD}
    />
    <Path d="M 64,40 L 86,38 L 82,52 L 64,48 Z" fill={INK} opacity={0.2} />
    <Path
      d="M 76,72 Q 88,62 88,48 Q 86,38 76,38 L 78,42 Q 84,42 86,50 Q 86,60 76,68 Z"
      fill={OXBLOOD}
    />
    <Circle cx={84} cy={56} r={1.2} fill={INK} opacity={0.3} />
    <Circle cx={86} cy={50} r={1} fill={INK} opacity={0.3} />
    <Polygon points="76,38 70,32 78,36" fill={BRASS} />
    <Polygon points="74,36 71,33 76,36" fill={BONE} opacity={0.6} />
    <ManeSpike points="50,4 46,24 54,24" opacity={1} phaseOffset={0} />
    <ManeSpike points="38,8 38,28 46,24" opacity={0.92} phaseOffset={0.1} />
    <ManeSpike points="62,8 62,28 54,24" opacity={0.92} phaseOffset={0.1} />
    <ManeSpike points="26,14 30,32 38,26" opacity={0.85} phaseOffset={0.2} />
    <ManeSpike points="74,14 70,32 62,26" opacity={0.85} phaseOffset={0.2} />
    <ManeSpike points="18,26 26,42 32,34" opacity={0.78} phaseOffset={0.3} />
    <ManeSpike points="82,26 74,42 68,34" opacity={0.78} phaseOffset={0.3} />
    <ManeSpike points="14,40 24,52 30,44" opacity={0.72} phaseOffset={0.4} />
    <ManeSpike points="86,40 76,52 70,44" opacity={0.72} phaseOffset={0.4} />
    <ManeSpike points="18,54 28,64 32,56" opacity={0.7} phaseOffset={0.5} />
    <ManeSpike points="82,54 72,64 68,56" opacity={0.7} phaseOffset={0.5} />
    <ManeSpike points="28,62 36,72 42,64" opacity={0.68} phaseOffset={0.6} />
    <ManeSpike points="72,62 64,72 58,64" opacity={0.68} phaseOffset={0.6} />
    <ManeSpike points="42,68 50,76 58,68" opacity={0.66} phaseOffset={0.7} />
    <ManeSpike points="46,72 50,80 54,72" opacity={0.62} phaseOffset={0.8} />
    <Polygon points="36,22 30,12 44,18" fill={BRASS} />
    <Polygon points="37,20 36,15 41,18" fill={INK} opacity={0.4} />
    <Polygon points="64,22 70,12 56,18" fill={BRASS} />
    <Polygon points="63,20 64,15 59,18" fill={INK} opacity={0.4} />
    <Path d="M 36,28 L 64,28 L 66,46 L 60,58 L 40,58 L 34,46 Z" fill={BRASS} />
    <Polygon points="36,42 42,56 38,46" fill={INK} opacity={0.18} />
    <Polygon points="64,42 58,56 62,46" fill={INK} opacity={0.18} />
    <Rect x={40} y={34} width={20} height={1.4} fill={INK} opacity={0.32} />
    <RNAnimatedG originX={44} originY={40} scaleY={eyeScale}>
      <Ellipse cx={44} cy={40} rx={2.4} ry={2.4} fill={INK} />
      <Ellipse cx={44.4} cy={39.4} rx={0.6} ry={0.6} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={56} originY={40} scaleY={eyeScale}>
      <Ellipse cx={56} cy={40} rx={2.4} ry={2.4} fill={INK} />
      <Ellipse cx={56.4} cy={39.4} rx={0.6} ry={0.6} fill={BONE} />
    </RNAnimatedG>
    <Polygon points="48,46 52,46 50,50" fill={INK} />
    <RNAnimatedG originX={50} originY={54} scaleY={mouthScale}>
      <Path d="M 44,52 L 56,52 L 53,57 L 47,57 Z" fill={INK} />
      <Polygon points="46,52 47,55 48,52" fill={BONE} />
      <Polygon points="52,52 53,55 54,52" fill={BONE} />
    </RNAnimatedG>
  </G>
);
