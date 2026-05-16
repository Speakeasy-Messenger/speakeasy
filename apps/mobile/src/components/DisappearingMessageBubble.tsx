import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text } from 'react-native';
import type { Attachment } from '@speakeasy/shared';
import { AttachmentView } from './AttachmentView.js';
import { RichMessageText } from './RichMessageText.js';
import { radius, space, useColors } from '../theme/index.js';
import { accent, font } from '../theme/tokens.js';

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
  /** Optional attachments rendered ABOVE the caption text. */
  attachments?: Attachment[];
  /** Handles @mentioned in this message — enables highlighted rendering. */
  mentions?: string[];
  /** Tap a photo/gif → host opens fullscreen viewer. */
  onTapPhoto?: (attachment: Attachment) => void;
  /** Tap a file → host writes to Downloads / opens externally. */
  onTapFile?: (attachment: Attachment) => void;
  /** Tap "See more" on a long message → host opens the full-text screen. */
  onSeeMore?: () => void;
  /** Fires when the current stage's animation completes. */
  onStageAnimated?: (stage: DisappearingStage) => void;
  /**
   * Sent-bubble delivery state — undefined for received bubbles.
   * `false` = sent but not yet acked across all recipient devices
   * (renders a single `✓`). `true` = all recipient devices have
   * acked (renders a `✓✓`). 1:1 only — group/community don't emit
   * `delivered` per spec §5.
   */
  delivered?: boolean;
  /**
   * Sent-bubble read state — `true` once the original recipient has
   * opened the chat with this message in view (Phase 6 read receipts,
   * `read` WS frame). Renders a brass-tinted `✓✓` instead of the slate
   * delivered glyph. Implies delivered. Undefined for received
   * bubbles.
   */
  read?: boolean;
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
  attachments,
  mentions,
  onTapPhoto,
  onTapFile,
  onSeeMore,
  onStageAnimated,
  delivered,
  read,
}: DisappearingMessageBubbleProps) {
  const themed = useColors();
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
    // themed.receivedBubble varies with the OS mode; the static
    // `colors.receivedBubble` we used to bake into StyleSheet was
    // hardcoded to dark-mode surface, which made received bubbles
    // appear pitch-black on the cream light-mode canvas.
    isSent ? null : { backgroundColor: themed.receivedBubble },
    {
      opacity,
      transform: [{ scale }],
      // height collapses in the 'gone' stage. Using maxHeight + scaleY would be
      // cleaner with native driver, but we want predictable collapse.
      // 600 covers a single 220-height photo grid + caption + padding;
      // the previous 200 cap clipped image bubbles vertically.
      maxHeight: heightFactor.interpolate({ inputRange: [0, 1], outputRange: [0, 600] }),
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
      {attachments && attachments.length > 0 ? (
        <AttachmentView
          attachments={attachments}
          variant={isSent ? 'me' : 'them'}
          onTapPhoto={onTapPhoto}
          onTapFile={onTapFile}
        />
      ) : null}
      {text ? (
        <RichMessageText
          text={text}
          mentions={mentions}
          onSeeMore={onSeeMore}
          style={[
            styles.text,
            isSent ? styles.sentText : { color: themed.ink },
          ]}
        />
      ) : null}
      {/* Read-receipt glyph — only on sent 1:1 bubbles. ✓ = sent +
          buffered server-side; ✓✓ = recipient acked across all
          devices. The receipt sits at the trailing edge of the
          bubble, slightly faded so it never competes with the
          content. */}
      {isSent && delivered !== undefined ? (
        <Text
          testID="bubble-receipt"
          style={[
            styles.receipt,
            read
              ? styles.receiptRead
              : delivered
                ? styles.receiptDelivered
                : styles.receiptSent,
          ]}
        >
          {delivered || read ? '✓✓' : '✓'}
        </Text>
      ) : null}
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
  // Sent bubble keeps its brass colour (mode-invariant) baked in;
  // received bubble's `backgroundColor` is overridden inline at render
  // time so it varies with the OS theme.
  sent: {
    backgroundColor: accent.base,
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    borderBottomLeftRadius: radius.bubble,
    borderBottomRightRadius: radius.bubbleTail,
    alignSelf: 'flex-end',
  },
  received: {
    borderTopLeftRadius: radius.bubble,
    borderTopRightRadius: radius.bubble,
    borderBottomLeftRadius: radius.bubbleTail,
    borderBottomRightRadius: radius.bubble,
    alignSelf: 'flex-start',
  },
  text: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 20,
  },
  sentText: { color: accent.foreground },
  // Read receipt — small + low-contrast so it never competes with
  // the message content. Cream-on-brass would blend; we go ink at
  // ~55% opacity for a "barely there" footprint that's still
  // legible against the brass sent-bubble.
  receipt: {
    fontFamily: font.medium,
    fontSize: 10,
    alignSelf: 'flex-end',
    marginTop: 2,
    marginRight: -2,
    letterSpacing: 0.5,
  },
  // Mode-invariant ink (= `accent.foreground` = `#14091A`) at 55% / 85%
  // opacity. Keeps the receipt legible against the brass sent-bubble
  // in both dark and light modes — the bubble is brand-invariant per
  // §6.3 ("brass + ink in dark, brass + ink in light"), so the receipt
  // stays put too.
  // Visual contrast tuned so the sent/delivered transition is
  // unmistakable at-a-glance. Was 55% ↔ 85% opacity (too subtle —
  // tested as "the receipt doesn't change"). Now 35% ↔ 100% with a
  // weight bump on delivered so ✓ → ✓✓ reads as a real state shift.
  receiptSent: { color: `${accent.foreground}59` }, // 0x59 ≈ 35%
  receiptDelivered: { color: accent.foreground, fontWeight: '700' as const },
  // Read = bone-on-brass (cream foreground) so the glyph visibly
  // shifts hue when the recipient opens the chat. Distinct enough
  // from delivered's ink-on-brass to read at a glance without an
  // extra glyph or motion.
  receiptRead: { color: '#F2E9D8', fontWeight: '700' as const },
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
