/**
 * Shared per-animal emotion driver — see AvatarRenderer's
 * `emotionEyeScale` / `emotionAmpBoost` for the universal-channel
 * equivalent. Animals that have a *signature tell* (raven feathers,
 * fox ears, hawk head tilt) use this hook to translate the discrete
 * EmotionState into a smooth [0..1] (or signed [-1..1]) drive value
 * with the same 200ms ease — and the same 0ms snap under
 * `useReducedMotion` — that the universal channels honor.
 *
 * The `map` argument lets the caller choose what each EmotionState
 * means for its animal. E.g. raven maps excited → 1 (ruffle visible),
 * else → 0. Fox maps excited → 1, calm → -1, baseline → 0 so a
 * single Animated.Value drives an opposite-direction ear motion.
 */
import { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';
import { useReducedMotion } from '../a11y/useReducedMotion.js';
import type { EmotionState } from '../calls/emotion-state-machine.js';

export function useEmotionDrive(
  emotionState: EmotionState | undefined,
  map: (s: EmotionState) => number,
): Animated.Value {
  const state = emotionState ?? 'baseline';
  const target = map(state);
  const value = useRef(new Animated.Value(target)).current;
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    Animated.timing(value, {
      toValue: target,
      duration: reducedMotion ? 0 : 200,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false,
    }).start();
  }, [target, reducedMotion, value]);
  return value;
}
