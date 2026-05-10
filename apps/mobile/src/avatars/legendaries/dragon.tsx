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
const JADE = '#3D9D6F';

/**
 * Wing flap — slow, regal beat. Wings scale on Y axis 0.92 ↔ 1.0 over
 * 2.4s, sin-eased. Per-instance pattern; pivots at the wing root so
 * the trailing tip sweeps through the larger arc.
 */
function Wing({
  d,
  pivotX,
  pivotY,
  phaseOffset,
}: {
  d: string;
  pivotX: number;
  pivotY: number;
  phaseOffset: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 2400, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const phase = (t.value + phaseOffset) % 1;
    const scale = 0.92 + (Math.sin(phase * Math.PI * 2) * 0.5 + 0.5) * 0.08;
    return {
      transform: [
        { translateX: pivotX },
        { translateY: pivotY },
        { scaleY: scale },
        { translateX: -pivotX },
        { translateY: -pivotY },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Path d={d} fill={JADE} opacity={0.9} />
    </AnimatedG>
  );
}

export const Dragon: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Polygon points="50,2 47,10 50,8 53,10" fill={BRASS} />
    <Polygon points="46,4 44,11 47,10" fill={BRASS} opacity={0.85} />
    <Polygon points="54,4 56,11 53,10" fill={BRASS} opacity={0.85} />
    <Circle cx={50} cy={9} r={1.8} fill={BONE} />
    <Polygon points="40,18 36,4 42,16" fill={BRASS} />
    <Polygon points="38,10 28,6 36,12" fill={BRASS} />
    <Polygon points="40,14 30,12 38,16" fill={BRASS} opacity={0.92} />
    <Polygon points="60,18 64,4 58,16" fill={BRASS} />
    <Polygon points="62,10 72,6 64,12" fill={BRASS} />
    <Polygon points="60,14 70,12 62,16" fill={BRASS} opacity={0.92} />
    <Polygon points="32,28 22,30 30,38" fill={JADE} />
    <Polygon points="28,36 18,40 30,44" fill={JADE} opacity={0.88} />
    <Polygon points="26,44 14,50 30,52" fill={JADE} opacity={0.78} />
    <Polygon points="68,28 78,30 70,38" fill={JADE} />
    <Polygon points="72,36 82,40 70,44" fill={JADE} opacity={0.88} />
    <Polygon points="74,44 86,50 70,52" fill={JADE} opacity={0.78} />
    <Polygon points="44,22 42,12 48,18" fill={JADE} opacity={0.85} />
    <Polygon points="56,22 58,12 52,18" fill={JADE} opacity={0.85} />
    <Polygon points="46,94 54,94 50,99" fill={JADE} />
    <Path d="M 40,84 L 60,84 L 56,94 L 44,94 Z" fill={JADE} />
    <Path d="M 36,74 L 64,74 L 62,86 L 38,86 Z" fill={JADE} />
    <Polygon points="46,74 50,69 54,74" fill={JADE} />
    <Polygon points="44,80 50,78 56,80 50,83" fill={INK} opacity={0.18} />
    <Path d="M 34,64 L 66,64 L 64,76 L 36,76 Z" fill={JADE} />
    <Polygon points="42,64 46,59 50,64" fill={JADE} />
    <Polygon points="52,64 56,59 60,64" fill={JADE} />
    <Polygon points="44,70 50,68 56,70 50,73" fill={INK} opacity={0.18} />
    <Path d="M 36,18 L 64,18 L 66,32 L 34,32 Z" fill={JADE} />
    <Path d="M 38,32 L 62,32 L 60,44 L 40,44 Z" fill={JADE} />
    <Path d="M 41,44 L 59,44 L 56,52 L 44,52 Z" fill={JADE} />
    <Rect x={36} y={24} width={28} height={1.4} fill={INK} opacity={0.32} />
    <Ellipse cx={46} cy={40} rx={1.2} ry={0.7} fill={INK} opacity={0.55} />
    <Ellipse cx={54} cy={40} rx={1.2} ry={0.7} fill={INK} opacity={0.55} />
    <Polygon points="40,30 36,38 40,38" fill={INK} opacity={0.18} />
    <Polygon points="60,30 64,38 60,38" fill={INK} opacity={0.18} />
    <Wing
      d="M 40,46 Q 28,52 22,64 Q 18,72 22,82 L 24,82 Q 20,72 24,64 Q 30,54 41,48 Z"
      pivotX={40}
      pivotY={48}
      phaseOffset={0}
    />
    <Wing
      d="M 60,46 Q 72,52 78,64 Q 82,72 78,82 L 76,82 Q 80,72 76,64 Q 70,54 59,48 Z"
      pivotX={60}
      pivotY={48}
      phaseOffset={0.05}
    />
    <RNAnimatedG originX={42} originY={28} scaleY={eyeScale}>
      <Ellipse cx={42} cy={28} rx={2.6} ry={2.6} fill={INK} />
      <Ellipse cx={42.5} cy={27.4} rx={0.7} ry={0.7} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={58} originY={28} scaleY={eyeScale}>
      <Ellipse cx={58} cy={28} rx={2.6} ry={2.6} fill={INK} />
      <Ellipse cx={58.5} cy={27.4} rx={0.7} ry={0.7} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={50} originY={49} scaleY={mouthScale}>
      <Path d="M 44,46 L 56,46 L 54,52 L 46,52 Z" fill={INK} />
      <Polygon points="46,46 47,49 48,46" fill={BONE} />
      <Polygon points="52,46 53,49 54,46" fill={BONE} />
    </RNAnimatedG>
  </G>
);
