import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { ANIMALS, AnimalSvg } from './components.js';
import type { EmotionState } from '../calls/emotion-state-machine.js';
import { renderParamsFor } from '../calls/emotion-state-machine.js';
import { useReducedMotion } from '../a11y/useReducedMotion.js';

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
  /**
   * Phase 5j Private Call — emotion state from
   * `EmotionStateMachine.push()`. Drives `eyeScale` (multiplicative
   * on the animal's baseline eye size), blink interval, and
   * `amplitudeBoost` (scales the per-animal mouth-amplitude response).
   * `'baseline'` (the default when undefined) returns neutral
   * parameters — so non-Private-Call call-sites stay at the current
   * behavior without any flag-checking.
   *
   * Transitions ease over 200ms in regular mode, instantly under
   * `useReducedMotion` (the locked /plan-design-review D12 behavior
   * that PR #57's reduce-motion soft-honor noted as deferred until
   * the per-animal Render hookup landed — which is this).
   */
  emotionState?: EmotionState;
}

export function AvatarRenderer({
  animalId,
  size,
  amplitude,
  skipBlink,
  emotionState,
}: Props): React.ReactElement {
  const def = ANIMALS[animalId];
  const breath = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const reducedMotion = useReducedMotion();

  // Phase 5j Private Call — emotion-driven Render params. Default
  // 'baseline' returns neutral values, so unwiring is a no-op for
  // every non-Private-Call mount site (chat row avatars, picker
  // grid tiles, etc.).
  const params = renderParamsFor(emotionState ?? 'baseline');
  const emotionEyeScale = useRef(new Animated.Value(params.eyeScale)).current;
  const emotionAmpBoost = useRef(new Animated.Value(params.amplitudeBoost)).current;
  const blinkIntervalSecRef = useRef(params.blinkIntervalSec);
  blinkIntervalSecRef.current = params.blinkIntervalSec;

  // Ease emotion-driven params across state transitions. 200ms is
  // long enough that the eye-size pop reads as "becoming alert"
  // rather than a glitch, but short enough that natural prosody
  // (which the hysteresis already filters) doesn't feel laggy.
  // useReducedMotion → duration 0 (instant snap) so the brand-
  // promise "the avatar is speaking" signal still flips, but the
  // decorative sweep is suppressed.
  useEffect(() => {
    const duration = reducedMotion ? 0 : 200;
    Animated.parallel([
      Animated.timing(emotionEyeScale, {
        toValue: params.eyeScale,
        duration,
        easing: Easing.out(Easing.quad),
        // Eye scale composes with `blink` via Animated.multiply
        // below — JS driver required to chain the two.
        useNativeDriver: false,
      }),
      Animated.timing(emotionAmpBoost, {
        toValue: params.amplitudeBoost,
        duration,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }),
    ]).start();
  }, [params.eyeScale, params.amplitudeBoost, reducedMotion, emotionEyeScale, emotionAmpBoost]);

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

  // Blink — random interval centered on the emotion-driven
  // `blinkIntervalSec` (baseline 5s, excited 3s, calm 8s). 50ms
  // close + 50ms open. JS-driver because the target is an SVG
  // transform prop, not a top-level View transform. Skipped when
  // `skipBlink` is set (picker grid) OR when reduce-motion is on
  // (the eyes hold open as a static neutral pose; the "speaking"
  // brand signal lives on the mouth, which still animates).
  useEffect(() => {
    if (skipBlink || reducedMotion) return undefined;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      // Center the delay on (blinkIntervalSec * 1000); ±1500ms jitter
      // keeps the random feel of the previous fixed [4000, 7000]
      // window for the baseline 5s default.
      const center = blinkIntervalSecRef.current * 1000;
      const delay = Math.max(500, center - 1500 + Math.random() * 3000);
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
  }, [blink, skipBlink, reducedMotion]);

  // Outer breathing wrapper. The inner SVG sees `eyeScale` + `mouthScale`
  // as Animated.Values (or interpolations) and pipes them into the
  // relevant <AnimatedG>s.
  const breathScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.015],
  });

  // Always derive the source Animated.Value here so we can expose it
  // to the per-animal Render as `amplitude`. Paid-tier animals
  // (lynx, raven, etc.) use it to drive their signature effect;
  // free animals ignore it.
  const source = useAmplitudeSource(amplitude);
  // Phase 5j — `boostedSource = source × emotionAmpBoost` so the
  // per-animal signature effect inherits the emotion boost without
  // each animal having to know about emotion state.
  const boostedSource = Animated.multiply(source, emotionAmpBoost);
  const mouthScale = boostedSource.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, def?.meta.audioResponse.scaleMax ?? 1],
  });
  // Eye scale = blink × emotion (excited bumps eyes up by 15%, calm
  // is neutral). Multiplying keeps the blink animation intact when
  // emotion changes mid-blink — the value chain just scales.
  const composedEyeScale = Animated.multiply(blink, emotionEyeScale);

  if (!def) {
    return <View style={{ width: size, height: size }} />;
  }

  return (
    <Animated.View style={{ width: size, height: size, transform: [{ scaleY: breathScale }] }}>
      <AnimalSvg
        animalId={animalId}
        size={size}
        eyeScale={composedEyeScale}
        mouthScale={mouthScale}
        amplitude={boostedSource}
        emotionState={emotionState}
      />
    </Animated.View>
  );
}

/**
 * Resolve the (number | Animated.Value | undefined) input into a
 * single stable Animated.Value the renderer can reuse for both the
 * mouth-scale interpolation and the per-animal signature-effect
 * driver. Re-using the same ref across renders prevents spurious
 * unmounts of the SVG tree on every parent re-render.
 */
function useAmplitudeSource(
  amplitude: Animated.Value | number | undefined,
): Animated.Value {
  const fallback = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (typeof amplitude === 'number') {
      fallback.setValue(amplitude);
    } else if (amplitude === undefined) {
      fallback.setValue(0);
    }
  }, [amplitude, fallback]);

  return amplitude instanceof Animated.Value ? amplitude : fallback;
}
