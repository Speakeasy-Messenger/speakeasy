import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ellipse, G, Path, Polygon, Rect } from 'react-native-svg';
import type { AnimalRender } from '../types.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';
const LAPIS = '#1F7B8A';

/**
 * Per-cell component. Earlier rc.24 attempt called `useShellShimmer`
 * 7× as a custom hook from inside `Turtle`. Babel's worklet transform
 * captured `phaseOffset` and `baseOpacity` into a worklet factory
 * IIFE that ran every render, which reanimated's internal
 * `useAnimatedProps` subscription tracked as a "new" worklet — the
 * resulting internal hook count diverged between first and
 * subsequent renders ("Rendered more hooks than during the previous
 * render."). Pulling each cell into its own component instance gives
 * each `useAnimatedProps` a stable hook position.
 */
function ShellCell({
  points,
  phaseOffset,
  baseOpacity,
}: {
  points: string;
  phaseOffset: number;
  baseOpacity: number;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 5000, easing: Easing.linear }),
      -1,
      false,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const phase = (t.value + phaseOffset) % 1;
    const opacity = baseOpacity + Math.sin(phase * Math.PI * 2) * 0.2;
    return { opacity };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Polygon points={points} fill={BRASS} />
    </AnimatedG>
  );
}

function Flipper({
  invert,
  children,
}: {
  invert: boolean;
  children: React.ReactNode;
}): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 2200, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const angle = (invert ? -1 : 1) * (t.value * 2 - 1) * 8;
    return {
      transform: [
        { translateX: invert ? 85 : 15 },
        { translateY: 62 },
        { rotate: `${angle}deg` },
        { translateX: invert ? -85 : -15 },
        { translateY: -62 },
      ],
    };
  });
  return <AnimatedG animatedProps={animatedProps}>{children}</AnimatedG>;
}

export const Turtle: AnimalRender = ({ eyeScale, mouthScale }) => (
  <G>
    <Ellipse cx={50} cy={80} rx={34} ry={3} fill="none" stroke={LAPIS} strokeWidth={0.5} opacity={0.35} />
    <Ellipse cx={50} cy={83} rx={28} ry={2.5} fill="none" stroke={LAPIS} strokeWidth={0.4} opacity={0.25} />
    <Ellipse cx={50} cy={86} rx={22} ry={2} fill="none" stroke={LAPIS} strokeWidth={0.3} opacity={0.18} />
    <Flipper invert={false}>
      <Polygon points="22,58 8,56 6,68 24,66" fill={LAPIS} />
      <Polygon points="14,60 8,58 8,66 14,64" fill={INK} opacity={0.25} />
    </Flipper>
    <Flipper invert={true}>
      <Polygon points="78,58 92,56 94,68 76,66" fill={LAPIS} />
      <Polygon points="86,60 92,58 92,66 86,64" fill={INK} opacity={0.25} />
    </Flipper>
    <Polygon points="78,52 90,48 88,56 76,54" fill={LAPIS} />
    <Polygon points="20,52 30,32 70,32 80,52 70,72 30,72" fill={LAPIS} />
    <Polygon points="20,52 30,32 70,32 80,52" fill={BONE} opacity={0.06} />
    <ShellCell points="50,42 58,46 58,58 50,62 42,58 42,46" phaseOffset={0} baseOpacity={0.85} />
    <ShellCell points="34,38 40,42 40,46 34,48 28,46 28,42" phaseOffset={0.16} baseOpacity={0.7} />
    <ShellCell points="66,38 72,42 72,46 66,48 60,46 60,42" phaseOffset={0.33} baseOpacity={0.7} />
    <ShellCell points="34,58 40,60 40,64 34,66 28,64 28,60" phaseOffset={0.5} baseOpacity={0.7} />
    <ShellCell points="66,58 72,60 72,64 66,66 60,64 60,60" phaseOffset={0.66} baseOpacity={0.7} />
    <ShellCell points="50,32 56,36 50,40 44,36" phaseOffset={0.83} baseOpacity={0.6} />
    <ShellCell points="50,64 56,68 50,72 44,68" phaseOffset={0.92} baseOpacity={0.6} />
    <Ellipse cx={14} cy={48} rx={11} ry={8} fill={LAPIS} />
    <Ellipse cx={14} cy={44} rx={9} ry={3} fill={BONE} opacity={0.06} />
    <Path d="M 4,50 Q 14,55 24,50 L 24,52 Q 14,58 4,52 Z" fill={INK} opacity={0.22} />
    <Polygon points="14,42 12,38 16,38" fill={BRASS} opacity={0.8} />
    <RNAnimatedG originX={11} originY={46} scaleY={eyeScale}>
      <Ellipse cx={11} cy={46} rx={1.6} ry={1.6} fill={INK} />
      <Ellipse cx={11.3} cy={45.6} rx={0.5} ry={0.5} fill={BONE} />
    </RNAnimatedG>
    <RNAnimatedG originX={8} originY={50.5} scaleX={mouthScale}>
      <Rect x={5} y={50} width={6} height={1} fill={INK} />
    </RNAnimatedG>
  </G>
);
