import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import { colors, fonts, radius, space } from '../theme/index.js';

/**
 * Five-stage dissolve per spec §14 motion #2. **Real Animated transitions,
 * not static frames.** Stages, durations, and target values are spec'd:
 *
 *   sent         — opacity 1.00, scale 1.00, blur  0px (static)
 *   seen         — pulse: scale 1 → 1.02 → 1 over 200ms
 *   disappearing — opacity → 0.55, scale → 0.97, blur →  4px over 600ms
 *   almost-gone  — opacity → 0.18, scale → 0.92, blur → 10px over 600ms
 *   gone         — opacity → 0,    height → 0,            over 400ms
 *
 * Total dissolve from `disappearing` start: ~1.6s.
 *
 * Note on blur: React Native does not have a built-in CSS-style `filter:
 * blur()`. Real Gaussian blur lives behind `@react-native-community/blur`,
 * which links once the iOS / Android shells are scaffolded. Until then we
 * track a `blurAmount` value through the animation so the swap is mechanical
 * (replace the `blur` prop wiring in this file). The opacity + scale
 * trajectory alone reads as a dissolve.
 */

export type DisappearingStage =
  | 'sent'
  | 'seen'
  | 'disappearing'
  | 'almost-gone'
  | 'gone';

export interface DisappearingMessageBubbleProps {
  text: string;
  stage: DisappearingStage;
  /** Sender vs recipient — affects bubble colours per spec §14. */
  variant?: 'sent' | 'received';
  /** Fires when the current stage's animation completes. */
  onStageAnimated?: (stage: DisappearingStage) => void;
}

interface StageTarget {
  opacity: number;
  scale: number;
  blur: number;
  /** Height multiplier (1 = full, 0 = collapsed). */
  heightFactor: number;
  duration: number;
  /** Pulse describes a there-and-back-again; otherwise single-pass. */
  pulse?: { peakScale: number; halfDuration: number };
}

const TARGETS: Record<DisappearingStage, StageTarget> = {
  sent: { opacity: 1, scale: 1, blur: 0, heightFactor: 1, duration: 1 },
  seen: {
    opacity: 1,
    scale: 1,
    blur: 0,
    heightFactor: 1,
    duration: 200,
    pulse: { peakScale: 1.02, halfDuration: 100 },
  },
  disappearing: { opacity: 0.55, scale: 0.97, blur: 4, heightFactor: 1, duration: 600 },
  'almost-gone': { opacity: 0.18, scale: 0.92, blur: 10, heightFactor: 1, duration: 600 },
  gone: { opacity: 0, scale: 0.92, blur: 10, heightFactor: 0, duration: 400 },
};

export function DisappearingMessageBubble({
  text,
  stage,
  variant = 'sent',
  onStageAnimated,
}: DisappearingMessageBubbleProps) {
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const blur = useRef(new Animated.Value(0)).current;
  const heightFactor = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const t = TARGETS[stage];
    const easing = Easing.out(Easing.cubic);

    // All four animated values share this Animated.View, and `blur` +
    // `heightFactor` (interpolated to maxHeight) can't run on the native
    // driver — they aren't transform/opacity. Mixing drivers on the same
    // view crashes with "animated node moved to native earlier" the next
    // time the JS-driven prop changes. Pinning all four to JS sidesteps
    // it; chat-bubble-rate animations don't need native-thread perf.
    if (t.pulse) {
      Animated.sequence([
        Animated.timing(scale, {
          toValue: t.pulse.peakScale,
          duration: t.pulse.halfDuration,
          easing,
          useNativeDriver: false,
        }),
        Animated.timing(scale, {
          toValue: 1,
          duration: t.pulse.halfDuration,
          easing,
          useNativeDriver: false,
        }),
      ]).start(() => onStageAnimated?.(stage));
      return;
    }

    Animated.parallel([
      Animated.timing(opacity, {
        toValue: t.opacity,
        duration: t.duration,
        easing,
        useNativeDriver: false,
      }),
      Animated.timing(scale, {
        toValue: t.scale,
        duration: t.duration,
        easing,
        useNativeDriver: false,
      }),
      Animated.timing(blur, {
        toValue: t.blur,
        duration: t.duration,
        easing,
        useNativeDriver: false,
      }),
      Animated.timing(heightFactor, {
        toValue: t.heightFactor,
        duration: t.duration,
        easing,
        useNativeDriver: false,
      }),
    ]).start(() => onStageAnimated?.(stage));
  }, [stage, opacity, scale, blur, heightFactor, onStageAnimated]);

  const isSent = variant === 'sent';
  const bubbleStyle = [
    styles.base,
    isSent ? styles.sent : styles.received,
    {
      opacity,
      transform: [{ scale }],
      // height collapses in the 'gone' stage. Using maxHeight + scaleY would be
      // cleaner with native driver, but we want predictable collapse.
      maxHeight: heightFactor.interpolate({ inputRange: [0, 1], outputRange: [0, 200] }),
    },
  ];

  return (
    <Animated.View
      style={bubbleStyle}
      // Expose the in-flight blur amount for callers that wire a real
      // BlurView / Gaussian filter — read via `bubbleRef.props.style`.
      // (When react-native-community/blur lands, swap to <BlurView blurAmount={blur._value}>.)
      accessibilityLabel={`message: ${text}`}
    >
      <Text style={[styles.text, isSent ? styles.sentText : styles.receivedText]}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    maxWidth: '78%',
    overflow: 'hidden',
    marginVertical: 4,
  },
  sent: {
    backgroundColor: colors.sentBubble,
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    borderBottomLeftRadius: radius.bubble,
    borderBottomRightRadius: radius.bubbleTail,
    alignSelf: 'flex-end',
  },
  received: {
    backgroundColor: colors.receivedBubble,
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    borderBottomLeftRadius: radius.bubbleTail,
    borderBottomRightRadius: radius.bubble,
    alignSelf: 'flex-start',
  },
  text: {
    fontFamily: fonts.inter400,
    fontSize: 15,
    lineHeight: 20,
  },
  sentText: { color: colors.cream },
  receivedText: { color: colors.ink },
});

/**
 * Convenience hook: drives a bubble through the full dissolve sequence
 * automatically after `ttlMs` from mount, then fires `onGone`.
 *
 * Useful for demos and the chat screen's TTL engine in Phase 3.
 */
export function useDissolveTimer(opts: {
  ttlMs: number;
  enabled?: boolean;
  onGone?: () => void;
}): DisappearingStage {
  const { ttlMs, enabled = true, onGone } = opts;
  const [stage, setStage] = React.useState<DisappearingStage>('sent');

  useEffect(() => {
    if (!enabled) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setStage('seen'), Math.min(800, ttlMs * 0.05)));
    timers.push(setTimeout(() => setStage('disappearing'), ttlMs));
    timers.push(setTimeout(() => setStage('almost-gone'), ttlMs + 600));
    timers.push(setTimeout(() => setStage('gone'), ttlMs + 1200));
    timers.push(
      setTimeout(() => {
        onGone?.();
      }, ttlMs + 1600),
    );
    return () => {
      timers.forEach(clearTimeout);
    };
  }, [ttlMs, enabled, onGone]);

  return stage;
}
