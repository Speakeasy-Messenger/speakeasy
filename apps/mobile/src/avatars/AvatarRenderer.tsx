import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { ANIMALS, AnimalSvg } from './components.js';

/**
 * Animated avatar — breathing always on, eyes blinking on a randomized
 * 4–7s cadence, mouth scale driven by `amplitude` (0..1) when supplied.
 *
 * Spec reference: AVATAR-SYSTEM.md §3.
 *
 * Animation channels:
 *  - Breathing: `scaleY 1.0 → 1.015 → 1.0` over 4.2s, sin-shaped.
 *    Native driver — outer Animated.View, no SVG transform.
 *  - Blink: paired eye `scaleY 1.0 → 0.05 → 1.0` over 100ms (50ms ease
 *    out, 50ms ease in), fired at random in [4000, 7000]ms.
 *  - Mouth: `scaleY` (or `scaleX` for beak-axis animals) interpolated
 *    by `amplitude * (scaleMax - 1) + 1`. Smoothed with a small
 *    low-pass filter at the source — see `props.amplitude` doc.
 *
 * Audio amplitude wires up in Phase 5 (native module). MVP renders
 * eyes-only animation; mouth holds at scale 1.0 (idle pose).
 */

interface Props {
  animalId: string;
  size: number;
  /**
   * Amplitude in [0, 1] driving the mouth. Pass an Animated.Value when
   * you want to drive it from a stream (audio module); pass a plain
   * number for a fixed pose; omit for idle (no mouth motion).
   *
   * The renderer applies the per-animal `audioResponse.scaleMax`
   * mapping on top — callers don't need to know each animal's max.
   */
  amplitude?: Animated.Value | number;
  /**
   * Skip blink — useful for static previews (avatar picker grid) where
   * 12 simultaneously-blinking tiles would feel cluttered.
   */
  skipBlink?: boolean;
}

export function AvatarRenderer({
  animalId,
  size,
  amplitude,
  skipBlink,
}: Props): React.ReactElement {
  const def = ANIMALS[animalId];
  const breath = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;

  // Breathing — continuous loop, native driver. The whole figure
  // scales by 1.5% on the Y axis; spec §3.1.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 2100,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 2100,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath]);

  // Blink — random interval in [4000, 7000]ms, 50ms close + 50ms open.
  // JS-driver because the target is an SVG transform prop, not a
  // top-level View transform. Negligible at this rate.
  useEffect(() => {
    if (skipBlink) return undefined;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      const delay = 4000 + Math.random() * 3000;
      timeout = setTimeout(() => {
        if (cancelled) return;
        Animated.sequence([
          Animated.timing(blink, {
            toValue: 0.05,
            duration: 50,
            easing: Easing.out(Easing.quad),
            useNativeDriver: false,
          }),
          Animated.timing(blink, {
            toValue: 1,
            duration: 50,
            easing: Easing.in(Easing.quad),
            useNativeDriver: false,
          }),
        ]).start(() => {
          if (!cancelled) schedule();
        });
      }, delay);
    }
    schedule();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [blink, skipBlink]);

  // Outer breathing wrapper. The inner SVG sees `eyeScale` + `mouthScale`
  // as Animated.Values (or interpolations) and pipes them into the
  // relevant <AnimatedG>s.
  const breathScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.015],
  });

  const mouthScale = useMouthScale(amplitude, def?.meta.audioResponse.scaleMax ?? 1);

  if (!def) {
    return <View style={{ width: size, height: size }} />;
  }

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scaleY: breathScale }] }}>
      <AnimalSvg
        animalId={animalId}
        size={size}
        eyeScale={blink}
        mouthScale={mouthScale}
      />
    </Animated.View>
  );
}

/**
 * Convert an external amplitude signal (number or Animated.Value, in
 * [0, 1]) into the `mouthScale` value the per-animal SVG expects.
 *
 * Mapping: `1 + amplitude * (scaleMax - 1)`. So amplitude=0 → 1.0
 * (rest pose), amplitude=1 → scaleMax (loudest).
 */
function useMouthScale(
  amplitude: Animated.Value | number | undefined,
  scaleMax: number,
): Animated.AnimatedInterpolation<number> | Animated.Value {
  // Stable Animated.Value backing constant amplitudes (or undefined).
  // Re-using the same ref across renders prevents spurious unmounts on
  // every re-render of the parent.
  const fallback = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (typeof amplitude === 'number') {
      fallback.setValue(amplitude);
    } else if (amplitude === undefined) {
      fallback.setValue(0);
    }
  }, [amplitude, fallback]);

  const source: Animated.Value =
    amplitude instanceof Animated.Value ? amplitude : fallback;

  return source.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, scaleMax],
  });
}
