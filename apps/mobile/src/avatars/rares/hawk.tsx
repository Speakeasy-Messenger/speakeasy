import React, { useEffect } from 'react';
import { Animated as RNAnimated } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Ellipse, G, Line, Path, Polygon } from 'react-native-svg';
import type { AnimalRender } from '../types.js';
import { useEmotionDrive } from '../emotion-drive.js';

const AnimatedG = Animated.createAnimatedComponent(G);
const RNAnimatedG = RNAnimated.createAnimatedComponent(G);
const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';

const BEAK_PIVOT = { x: 75, y: 43 };

/**
 * Beak ready — slow, predator-still scan. Beak rotates ±3° around the
 * peak vertex over 3.4s, sin-eased. The rest of the silhouette holds.
 */
function BeakScan(): React.ReactElement {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: 3400, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    );
  }, [t]);
  const animatedProps = useAnimatedProps(() => {
    'worklet';
    const angle = (t.value * 2 - 1) * 3;
    return {
      transform: [
        { translateX: BEAK_PIVOT.x },
        { translateY: BEAK_PIVOT.y },
        { rotate: `${angle}deg` },
        { translateX: -BEAK_PIVOT.x },
        { translateY: -BEAK_PIVOT.y },
      ],
    };
  });
  return (
    <AnimatedG animatedProps={animatedProps}>
      <Polygon points="64,40 86,40 70,48" fill={BRASS} />
      <Polygon points="78,42 86,40 82,48" fill={INK} opacity={0.4} />
    </AnimatedG>
  );
}

// Predator head pivot — base of the skull where it meets the chest.
// Tilt rotates the whole head group (silhouette, brow shadow, beak,
// eye, mouth, cheek mark) around this point so the gesture reads as
// "I'm listening" rather than the head decoupling from the body.
const HEAD_TILT_PIVOT = { x: 50, y: 60 };
const HEAD_TILT_MAX_DEG = 6;

export const Hawk: AnimalRender = ({ eyeScale, mouthScale, emotionState }) => {
  // Phase 5j Private Call — calm = sustained low-energy speech; the
  // hawk's natural read for that is a "listening tilt." Excited and
  // baseline hold the head level so the BeakScan stays unambiguous.
  const tilt = useEmotionDrive(emotionState, (s) => (s === 'calm' ? 1 : 0));
  // react-native-svg <G rotation={…}> takes a numeric degree.
  const rotation = tilt.interpolate({
    inputRange: [0, 1],
    outputRange: [0, HEAD_TILT_MAX_DEG],
  });
  return (
    <G>
      <Path d="M 32,62 L 68,62 L 76,92 L 24,92 Z" fill={BRASS} opacity={0.85} />
      <Line x1={32} y1={72} x2={68} y2={72} stroke={INK} strokeWidth={0.5} opacity={0.25} />
      <Line x1={34} y1={80} x2={66} y2={80} stroke={INK} strokeWidth={0.5} opacity={0.25} />
      <RNAnimatedG
        originX={HEAD_TILT_PIVOT.x}
        originY={HEAD_TILT_PIVOT.y}
        rotation={rotation}
      >
        <Path d="M 28,40 L 24,28 L 32,18 Q 50,16 64,24 L 70,42 L 64,60 L 32,60 Z" fill={BRASS} />
        <Polygon points="24,28 36,28 32,18" fill={INK} opacity={0.32} />
        <BeakScan />
        <RNAnimatedG originX={50} originY={36} scaleY={eyeScale}>
          <Ellipse cx={50} cy={36} rx={2.8} ry={2.8} fill={INK} />
          <Ellipse cx={50.5} cy={35.4} rx={0.7} ry={0.7} fill={BONE} />
        </RNAnimatedG>
        <RNAnimatedG originX={75} originY={43} scaleX={mouthScale}>
          <Polygon points="72,42 78,42 76,44" fill={INK} />
        </RNAnimatedG>
        <Polygon points="38,46 32,56 42,52" fill={INK} opacity={0.18} />
      </RNAnimatedG>
    </G>
  );
};
