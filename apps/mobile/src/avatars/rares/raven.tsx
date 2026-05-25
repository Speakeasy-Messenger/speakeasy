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

const HEAD_PIVOT = { x: 50, y: 58 };

/**
 * Raven head bob — rc.23 *test* effect. Continuous ±6° rotation at
 * 1.4s/cycle, no amplitude gate. The earlier amplitude-driven tilt
 * could only fire during live audio (calls), so a static-looking
 * raven in the picker / AppBar was indistinguishable from "reanimated
 * never ran". A continuous bob is unmissable: if you can see raven
 * nodding gently, the worklet runtime is alive.
 *
 * Once verified on device, this reverts to the amplitude-driven
 * head tilt per CALLS.md / spec.
 */
function useHeadBob() {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 1400, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  return useAnimatedProps(() => {
    'worklet';
    const angle = (t.value * 2 - 1) * 6;
    return {
      transform: [
        { translateX: HEAD_PIVOT.x },
        { translateY: HEAD_PIVOT.y },
        { rotate: `${angle}deg` },
        { translateX: -HEAD_PIVOT.x },
        { translateY: -HEAD_PIVOT.y },
      ],
    };
  });
}

export const Raven: AnimalRender = ({ eyeScale, mouthScale }) => {
  const headProps = useHeadBob();
  // Raven silhouette is ink (the bird is *black* — the name says so),
  // not brass. The previous version rendered head + body + beak all in
  // BRASS, which vanished against the light-mode cream tile and read
  // as "no avatar" in pickers. Brass survives as a sheen highlight
  // along the body's leading edge and as the golden eye + beak — both
  // classic raven cues and consistent with the brand's brass-on-ink
  // palette.
  return (
    <G>
      <Path d="M 30,60 L 70,60 L 76,90 L 24,90 Z" fill={INK} />
      <Path d="M 30,60 L 70,60 L 72,68 L 28,68 Z" fill={BRASS} opacity={0.22} />
      <Polygon points="34,72 50,68 66,72 50,76" fill={BONE} opacity={0.10} />
      <AnimatedG animatedProps={headProps}>
        <Path d="M 28,38 Q 34,18 56,20 Q 72,22 72,42 L 70,58 L 30,58 Z" fill={INK} />
        <Path d="M 30,40 Q 34,22 50,22 Q 58,22 60,32 L 56,40 Z" fill={BRASS} opacity={0.18} />
        <Polygon points="68,38 92,40 70,46" fill={BRASS} />
        <Polygon points="68,42 92,40 86,44" fill={INK} opacity={0.35} />
        <RNAnimatedG originX={56} originY={36} scaleY={eyeScale}>
          <Ellipse cx={56} cy={36} rx={2.6} ry={2.6} fill={BRASS} />
          <Ellipse cx={56} cy={36} rx={1.2} ry={1.2} fill={INK} />
          <Ellipse cx={56.5} cy={35.4} rx={0.5} ry={0.5} fill={BONE} />
        </RNAnimatedG>
        <RNAnimatedG originX={79} originY={43} scaleX={mouthScale}>
          <Polygon points="76,42 82,42 80,44" fill={INK} />
        </RNAnimatedG>
      </AnimatedG>
    </G>
  );
};
