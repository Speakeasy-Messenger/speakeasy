import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { ANIMALS, AnimalSvg } from './components.js';
import { NEUTRAL_PROSODY, type AnimatedProsody, type ProsodyState } from './types.js';
import type { AcousticEvent } from '../calls/audio-feature-extractor.js';
import { useReducedMotion } from '../a11y/useReducedMotion.js';

/**
 * Animated avatar — breathing always on, eyes blinking on a randomized
 * 4–7 s cadence, mouth scale driven by `amplitude` (0..1) when supplied.
 *
 * Spec reference: AVATAR-SYSTEM.md §3.
 *
 * Animation channels (rc.11):
 *  - Breathing: `scaleY 1.0 → 1.015 → 1.0` over 4.2 s, sin-shaped.
 *    Native driver — outer Animated.View, no SVG transform.
 *  - Blink: paired eye `scaleY 1.0 → 0.05 → 1.0` over 100 ms (50 ms ease
 *    out, 50 ms ease in), fired at random in [4000, 7000] ms.
 *  - Mouth: `scaleY` (or `scaleX` for beak-axis animals) interpolated
 *    by `amplitude * (scaleMax - 1) + 1`. Smoothed with a small
 *    low-pass filter at the source. The new `mouthShape` channel in
 *    prosody is consumed by per-animal Renders that have a shape
 *    pose (vowels vs fricatives); the universal mouth channel
 *    remains amplitude-driven.
 *  - **Prosody channels** (rc.11): when a `prosody` prop is supplied
 *    (Private Call), 7 continuous channels are lifted into
 *    Animated.Values via `useProsodyAnimatedValues` and handed to
 *    the per-animal Render. The legacy `emotionState` categorical
 *    enum is gone — continuous-feature → motion mapping replaced it.
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
   *
   * If `prosody` is also supplied, this prop wins for the mouth Y
   * scale (typically the locally-meterd audio level), while the
   * other prosody channels drive shape / head / fidget.
   */
  amplitude?: Animated.Value | number;
  /**
   * Skip blink — useful for static previews (avatar picker grid) where
   * 12 simultaneously-blinking tiles would feel cluttered.
   */
  skipBlink?: boolean;
  /**
   * Phase 5j Private Call (rc.11) — peer's latest prosody snapshot
   * from the WebRTC data channel. When set, the avatar's
   * continuous-channel animations follow the peer's voice. When
   * absent or neutral, the avatar renders at rest.
   *
   * Pass NEUTRAL_PROSODY (or omit) at chat row / picker / static
   * preview sites.
   */
  prosody?: ProsodyState;
}

export function AvatarRenderer({
  animalId,
  size,
  amplitude,
  skipBlink,
  prosody,
}: Props): React.ReactElement {
  const def = ANIMALS[animalId];
  const breath = useRef(new Animated.Value(0)).current;
  const blink = useRef(new Animated.Value(1)).current;
  const reducedMotion = useReducedMotion();

  // Lift the numeric prosody snapshot into stable Animated.Values
  // that the per-animal Render reads. Each Animated.Value is created
  // ONCE and updated via Animated.timing on prosody changes —
  // creating new Values on each render would thrash the SVG
  // setNativeProps chain and break smooth easing.
  const animatedProsody = useProsodyAnimatedValues(prosody, reducedMotion);

  // Phase 5j Private Call (rc.11) — acoustic-event pose overlay. One-
  // shot transforms applied to the wrapping Animated.View when the
  // peer's audio pipeline detects laugh / sigh / gasp / "hmm". Each
  // event runs an ~1.5 s animation on top of the continuous channels;
  // breathing + breathing scale keep going underneath. Reduce-motion
  // users skip the animation entirely (no decorative one-shots).
  const eventOverlay = useEventOverlay(prosody, reducedMotion);

  // Breathing — continuous loop, native driver. The whole figure
  // scales by 1.5 % on the Y axis; spec §3.1.
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

  // Blink — random interval centered on a baseline 5 s with ±1.5 s
  // jitter. 50 ms close + 50 ms open. JS-driver because the target
  // is an SVG transform prop, not a top-level View transform.
  // Skipped when `skipBlink` is set (picker grid) OR when
  // reduce-motion is on (the eyes hold open as a static neutral
  // pose; the "speaking" brand signal lives on the mouth, which
  // still animates).
  useEffect(() => {
    if (skipBlink || reducedMotion) return undefined;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      const delay = 4000 + Math.random() * 3000; // 4000–7000 ms
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
  // as Animated.Values and pipes them into the relevant <AnimatedG>s.
  const breathScale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, 1.015],
  });

  // Resolve the (number | Animated.Value | undefined) amplitude prop
  // into a single stable Animated.Value the renderer reuses for both
  // the mouth-scale interpolation and the per-animal signature-effect
  // driver. Re-using the same ref across renders prevents spurious
  // unmounts of the SVG tree on every parent re-render.
  const source = useAmplitudeSource(amplitude);
  const mouthScale = source.interpolate({
    inputRange: [0, 1],
    outputRange: [1.0, def?.meta.audioResponse.scaleMax ?? 1],
  });

  if (!def) {
    return <View style={{ width: size, height: size }} />;
  }

  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        opacity: eventOverlay.opacity,
        transform: [
          { scale: eventOverlay.scale },
          { rotate: eventOverlay.rotateDeg },
          { scaleY: breathScale },
        ],
      }}
    >
      <AnimalSvg
        animalId={animalId}
        size={size}
        eyeScale={blink}
        mouthScale={mouthScale}
        amplitude={source}
        prosody={animatedProsody}
      />
    </Animated.View>
  );
}

/** Wire quantization is 1/255 per channel — deltas smaller than
 *  this are noise (encoder rounded a tiny change to the same byte).
 *  Below this threshold we skip the timing entirely. */
const PROSODY_DELTA_EPSILON = 1 / 255;

/**
 * Stable Animated.Value mirror of the numeric `prosody` prop. Each
 * channel gets ONE Animated.Value that's reused across renders; on
 * prosody change, `Animated.timing` eases the value toward the new
 * target only for channels whose target actually moved beyond the
 * wire's quantization step. Reduce-motion users get a 0 ms snap.
 *
 * Three things this hook does for performance:
 *  1. Per-channel delta gate — most frames a single sustained sound
 *     produces tiny changes that quantize identically; we don't
 *     re-fire those timings.
 *  2. Composite handle — the prior frame's `Animated.parallel` is
 *     stopped before the new one starts, so the JS-driver doesn't
 *     stack mid-flight timings on top of each other at 30 Hz.
 *  3. Re-uses Animated.Values across renders (the existing approach;
 *     creating new ones each render would unmount the per-animal SVG
 *     interpolation chain).
 *
 * `event` + `eventAt` pass through unchanged (one-shot triggers,
 * not continuous channels — handled by `useEventOverlay`).
 */
function useProsodyAnimatedValues(
  prosody: ProsodyState | undefined,
  reducedMotion: boolean,
): AnimatedProsody {
  const snapshot = prosody ?? NEUTRAL_PROSODY;
  const amplitude = useRef(new Animated.Value(snapshot.amplitude)).current;
  const pitchNorm = useRef(new Animated.Value(snapshot.pitchNorm)).current;
  const zcrNorm = useRef(new Animated.Value(snapshot.zcrNorm)).current;
  const mouthShape = useRef(new Animated.Value(snapshot.mouthShape)).current;
  const pitchTrend = useRef(new Animated.Value(snapshot.pitchTrend)).current;
  const expressiveness = useRef(
    new Animated.Value(snapshot.expressiveness),
  ).current;
  const activity = useRef(new Animated.Value(snapshot.activity)).current;

  // Track the last applied target per channel so the delta gate
  // works frame-to-frame (Animated.Value doesn't expose its current
  // numeric value publicly via a stable API; tracking it ourselves
  // is the cheap correct path).
  const lastTargetsRef = useRef({
    amplitude: snapshot.amplitude,
    pitchNorm: snapshot.pitchNorm,
    zcrNorm: snapshot.zcrNorm,
    mouthShape: snapshot.mouthShape,
    pitchTrend: snapshot.pitchTrend,
    expressiveness: snapshot.expressiveness,
    activity: snapshot.activity,
  });
  const compositeRef = useRef<Animated.CompositeAnimation | null>(null);

  // Frame cadence is 30 Hz; a 60 ms ease keeps a single value
  // change visually smooth without piling animations on top of
  // each other (a longer ease would still be mid-flight when the
  // next frame arrives).
  const duration = reducedMotion ? 0 : 60;
  useEffect(() => {
    const animations: Animated.CompositeAnimation[] = [];
    const last = lastTargetsRef.current;
    const channels: Array<{
      value: Animated.Value;
      prev: number;
      next: number;
      assign: (v: number) => void;
    }> = [
      { value: amplitude, prev: last.amplitude, next: snapshot.amplitude, assign: (v) => (last.amplitude = v) },
      { value: pitchNorm, prev: last.pitchNorm, next: snapshot.pitchNorm, assign: (v) => (last.pitchNorm = v) },
      { value: zcrNorm, prev: last.zcrNorm, next: snapshot.zcrNorm, assign: (v) => (last.zcrNorm = v) },
      { value: mouthShape, prev: last.mouthShape, next: snapshot.mouthShape, assign: (v) => (last.mouthShape = v) },
      { value: pitchTrend, prev: last.pitchTrend, next: snapshot.pitchTrend, assign: (v) => (last.pitchTrend = v) },
      { value: expressiveness, prev: last.expressiveness, next: snapshot.expressiveness, assign: (v) => (last.expressiveness = v) },
      { value: activity, prev: last.activity, next: snapshot.activity, assign: (v) => (last.activity = v) },
    ];
    for (const ch of channels) {
      if (Math.abs(ch.next - ch.prev) < PROSODY_DELTA_EPSILON) continue;
      ch.assign(ch.next);
      animations.push(
        Animated.timing(ch.value, {
          toValue: ch.next,
          duration,
          easing: Easing.linear,
          useNativeDriver: false,
        }),
      );
    }
    if (animations.length === 0) return undefined;
    // Stop any in-flight composite from the previous frame before
    // starting this one — without this, JS-driver bookkeeping for
    // superseded timings keeps doing per-frame work until they hit
    // their (already-stale) completion.
    compositeRef.current?.stop();
    const composite = Animated.parallel(animations);
    compositeRef.current = composite;
    composite.start();
    return () => {
      composite.stop();
    };
  }, [
    snapshot.amplitude,
    snapshot.pitchNorm,
    snapshot.zcrNorm,
    snapshot.mouthShape,
    snapshot.pitchTrend,
    snapshot.expressiveness,
    snapshot.activity,
    duration,
    amplitude,
    pitchNorm,
    zcrNorm,
    mouthShape,
    pitchTrend,
    expressiveness,
    activity,
  ]);

  return {
    amplitude,
    pitchNorm,
    zcrNorm,
    mouthShape,
    pitchTrend,
    expressiveness,
    activity,
    event: snapshot.event,
    eventAt: snapshot.eventAt,
  };
}

/**
 * Per-event animation timeline. Returns `(values) → Animated.composite`
 * that the AvatarRenderer kicks off when an event arrives. Each
 * event has its own choreography; durations are tuned for the
 * "dramatic beat" feel (laugh = playful bounce, sigh = slow settle,
 * gasp = sharp pop, hmm = thoughtful tilt). All run native-driver
 * so they layer cleanly with the breathing scale on the wrapping
 * Animated.View.
 */
function buildEventAnimation(
  event: AcousticEvent,
  values: {
    scale: Animated.Value;
    rotate: Animated.Value;
    opacity: Animated.Value;
  },
): Animated.CompositeAnimation {
  const { scale, rotate, opacity } = values;
  const native = true;
  switch (event) {
    case 'laugh':
      // Playful bounce — scale up, dip, up, settle. ~900 ms.
      return Animated.sequence([
        Animated.timing(scale, { toValue: 1.12, duration: 150, easing: Easing.out(Easing.quad), useNativeDriver: native }),
        Animated.timing(scale, { toValue: 0.95, duration: 200, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.timing(scale, { toValue: 1.06, duration: 200, easing: Easing.inOut(Easing.quad), useNativeDriver: native }),
        Animated.timing(scale, { toValue: 1.0, duration: 350, easing: Easing.out(Easing.cubic), useNativeDriver: native }),
      ]);
    case 'sigh':
      // Slow settle — scale down + fade slightly + return. ~1.5 s.
      return Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 0.96, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
          Animated.timing(scale, { toValue: 1.0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.78, duration: 600, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
          Animated.timing(opacity, { toValue: 1.0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
        ]),
      ]);
    case 'gasp':
      // Sharp pop — quick scale-up + hold + release. ~800 ms.
      return Animated.sequence([
        Animated.timing(scale, { toValue: 1.18, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: native }),
        Animated.timing(scale, { toValue: 1.18, duration: 200, easing: Easing.linear, useNativeDriver: native }),
        Animated.timing(scale, { toValue: 1.0, duration: 480, easing: Easing.in(Easing.cubic), useNativeDriver: native }),
      ]);
    case 'hmm':
      // Thoughtful head tilt — rotate left, hold, return. ~1.4 s.
      return Animated.sequence([
        Animated.timing(rotate, { toValue: -4, duration: 350, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
        Animated.timing(rotate, { toValue: -4, duration: 600, easing: Easing.linear, useNativeDriver: native }),
        Animated.timing(rotate, { toValue: 0, duration: 450, easing: Easing.inOut(Easing.sin), useNativeDriver: native }),
      ]);
    case 'none':
    default:
      // No-op timing keeps the return type uniform.
      return Animated.timing(scale, {
        toValue: 1,
        duration: 0,
        useNativeDriver: native,
      });
  }
}

/**
 * Acoustic-event pose overlay. Holds three Animated.Values
 * (scale / rotate / opacity) that the AvatarRenderer composes into
 * the wrapping Animated.View's transform. On each new event
 * (identified by the receiver-side `eventAt` timestamp, which
 * changes only when a new event arrives), kicks off the
 * event-specific animation. Aborts mid-flight and starts the new
 * one if a fresh event arrives before the previous completed.
 *
 * Reduce-motion users get no overlay — the dramatic beats are
 * decorative; the steady-state mouth + per-animal channels still
 * carry the conversation.
 */
function useEventOverlay(
  prosody: ProsodyState | undefined,
  reducedMotion: boolean,
): {
  scale: Animated.Value;
  rotateDeg: Animated.AnimatedInterpolation<string>;
  opacity: Animated.Value;
} {
  const scale = useRef(new Animated.Value(1)).current;
  const rotate = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const event = prosody?.event ?? 'none';
  const eventAt = prosody?.eventAt ?? 0;

  useEffect(() => {
    if (reducedMotion) return undefined;
    if (event === 'none' || eventAt === 0) return undefined;
    // Reset to neutral synchronously so a previous event's tail
    // doesn't shadow the new one's leading edge.
    scale.setValue(1);
    rotate.setValue(0);
    opacity.setValue(1);
    const anim = buildEventAnimation(event, { scale, rotate, opacity });
    anim.start();
    return () => anim.stop();
    // Trigger key is `eventAt`: it's stamped with `Date.now()` on the
    // receiving end every time a new event arrives, so repeated laughs
    // (laugh → laugh after the 2 s cooldown) re-fire the effect.
    // `event` is in the deps because the body *reads* it to pick a
    // timeline; without it eslint's exhaustive-deps complains, and
    // the value never changes without `eventAt` also changing under
    // the App.tsx frame-handler invariant, so the extra dep is inert.
  }, [eventAt, event, reducedMotion, scale, rotate, opacity]);

  // rotate is degrees; the View transform `rotate` field needs a
  // string with a unit. Memo the interpolation node so we don't
  // allocate a fresh AnimatedInterpolation on every parent render
  // (CallScreen → PortraitTile → AvatarRenderer all subscribe to
  // usePeerAnimation, so the chain re-renders ~30 Hz during a
  // Private Call).
  const rotateDeg = useMemo(
    () =>
      rotate.interpolate({
        inputRange: [-360, 360],
        outputRange: ['-360deg', '360deg'],
      }),
    [rotate],
  );

  return { scale, rotateDeg, opacity };
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
