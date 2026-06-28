import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Attachment } from '@speakeasy/shared';
import { AttachmentView } from './AttachmentView.js';
import { isEdgeToEdgeMedia } from './attachment-layout.js';
import { RichMessageText } from './RichMessageText.js';
import { radius, space, useColors } from '../theme/index.js';
import { accent, font } from '../theme/tokens.js';
import { formatMessageTime } from '../utils/time.js';

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

// DisappearingStage moved to ./disappearing-stage.ts so the type can
// be imported by modules outside React (e.g. the conversations store)
// without dragging react-native's Flow-laced ESM into their parse
// graph. Re-export here for back-compat with existing call sites.
export type { DisappearingStage } from './disappearing-stage.js';
import type { DisappearingStage } from './disappearing-stage.js';

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
  /** Tap an @mention → host opens a chat with that handle (bare, no `@`). */
  onMentionPress?: (handle: string) => void;
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
  /**
   * Wall-clock send time (ms). When present, the bubble shows a small
   * trailing timestamp ("3:04 PM"). Optional so older call-sites
   * that don't pass it just render without one.
   */
  timestamp?: number;
  /**
   * Outbound send failed for this bubble. When set, the bubble renders
   * muted (lower opacity, no receipt glyph) with a "Tap to resend" cue
   * underneath. Tapping the bubble fires `onTapResend`. Cleared on
   * retry; receipts attach to the original bubble because the wire id
   * is preserved across attempts. Only meaningful on sent bubbles.
   */
  sendFailure?: string;
  /**
   * Fires when the user taps a `sendFailure` bubble to resend it.
   * Only wired by ChatScreen for sent bubbles.
   */
  onTapResend?: () => void;
  /**
   * When this message is a quote-reply, the quoted context to render as
   * a block above the body. `from` is the display label the host already
   * resolved ("you" for self-quotes, else the author handle).
   */
  replyTo?: { from: string; preview: string };
  /**
   * Enables swipe-to-reply on this bubble. Fires once when the user pulls
   * the bubble past the trigger threshold and releases. Omit to disable
   * the gesture (e.g. failed/own-pending bubbles).
   */
  onReply?: () => void;
}

/** Rightward pull (px) needed to commit a reply on release. */
const REPLY_TRIGGER_PX = 56;
/** Max pull (px) — clamps the drag so the bubble never slides off-screen. */
const REPLY_MAX_PULL_PX = 80;

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
  onMentionPress,
  onStageAnimated,
  delivered,
  read,
  timestamp,
  sendFailure,
  onTapResend,
  replyTo,
  onReply,
}: DisappearingMessageBubbleProps) {
  const themed = useColors();
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const blur = useRef(new Animated.Value(0)).current;
  const heightFactor = useRef(new Animated.Value(1)).current;

  // Swipe-to-reply. Drives a horizontal translate that follows the
  // finger (rightward only, clamped) and fires `onReply` once when the
  // pull crosses the trigger and the finger lifts. The Animated.Value
  // and PanResponder are stable across renders; `onReply` is read
  // through a ref so an inline host callback doesn't rebuild the
  // responder mid-gesture. Driven on the JS thread to match the
  // dissolve animations sharing this view (mixing drivers crashes).
  const translateX = useRef(new Animated.Value(0)).current;
  const replyArmed = useRef(false);
  const onReplyRef = useRef(onReply);
  onReplyRef.current = onReply;
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Only claim the gesture for a clearly-horizontal rightward drag,
        // so the inverted FlatList keeps owning vertical scroll.
        onMoveShouldSetPanResponder: (_e, g) =>
          !!onReplyRef.current &&
          g.dx > 8 &&
          Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
        onPanResponderMove: (_e, g) => {
          const dx = Math.max(0, Math.min(g.dx, REPLY_MAX_PULL_PX));
          translateX.setValue(dx);
          replyArmed.current = dx >= REPLY_TRIGGER_PX;
        },
        onPanResponderRelease: () => {
          const fire = replyArmed.current;
          replyArmed.current = false;
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: false,
            bounciness: 6,
            speed: 18,
          }).start();
          if (fire) onReplyRef.current?.();
        },
        onPanResponderTerminate: () => {
          replyArmed.current = false;
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: false,
          }).start();
        },
      }),
    [translateX],
  );

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
  const isFailed = isSent && !!sendFailure;
  // A media-only message (photo/gif, no caption) drops the bubble's text
  // padding so the image fills the bubble edge-to-edge. Files are excluded
  // — see isEdgeToEdgeMedia for the why (it fixes the cut-off-filename bug).
  const mediaOnly = isEdgeToEdgeMedia(attachments, !!text);
  const bubbleStyle = [
    styles.base,
    mediaOnly ? styles.mediaOnly : null,
    isSent ? styles.sent : styles.received,
    // themed.receivedBubble varies with the OS mode; the static
    // `colors.receivedBubble` we used to bake into StyleSheet was
    // hardcoded to dark-mode surface, which made received bubbles
    // appear pitch-black on the cream light-mode canvas.
    isSent ? null : { backgroundColor: themed.receivedBubble },
    isFailed ? styles.sentFailed : null,
    {
      opacity,
      transform: [{ translateX }, { scale }],
      // height collapses in the 'gone' stage. Using maxHeight + scaleY would be
      // cleaner with native driver, but we want predictable collapse.
      // 600 covers a single 220-height photo grid + caption + padding;
      // the previous 200 cap clipped image bubbles vertically.
      maxHeight: heightFactor.interpolate({ inputRange: [0, 1], outputRange: [0, 600] }),
    },
  ];

  const bubble = (
    <Animated.View
      style={bubbleStyle}
      // Swipe-to-reply pan handlers. No-op when `onReply` is absent (the
      // responder declines the gesture), so non-reply bubbles keep normal
      // scroll behavior.
      {...panResponder.panHandlers}
      // Expose the in-flight blur amount for callers that wire a real
      // BlurView / Gaussian filter — read via `bubbleRef.props.style`.
      // (When react-native-community/blur lands, swap to <BlurView blurAmount={blur._value}>.)
      accessibilityLabel={`message: ${text}`}
    >
      {/* Quoted block — the message this one is replying to. A left accent
          rule + the author label + a one-line preview. Tinted for legibility
          on each bubble colour. Static (no jump-to-original in v1). */}
      {replyTo ? (
        <View
          style={[
            styles.replyQuote,
            isSent
              ? styles.replyQuoteOnSent
              : { backgroundColor: themed.pale, borderLeftColor: accent.base },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[
              styles.replyQuoteAuthor,
              { color: isSent ? accent.foreground : accent.base },
            ]}
          >
            {replyTo.from}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              styles.replyQuotePreview,
              isSent ? styles.replyQuoteTextOnSent : { color: themed.slate },
            ]}
          >
            {replyTo.preview || ' '}
          </Text>
        </View>
      ) : null}
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
          // Brass "See more" on the dark received bubble so it stands out
          // from the body text; omitted on the brass sent bubble (would be
          // brass-on-brass) where bold+underline carries it.
          seeMoreColor={isSent ? undefined : accent.base}
          onMentionPress={onMentionPress}
          style={[
            styles.text,
            isSent ? styles.sentText : { color: themed.ink },
          ]}
        />
      ) : null}
      {/* Trailing meta line: send time and (sent-bubble only) the
          read-receipt glyph. ✓ = buffered server-side; ✓✓ = acked /
          read. Both sit at the trailing edge, slightly faded so they
          never compete with the content. The row only renders when
          there's something to show. Failed bubbles swap the receipt
          for a small "!" — the resend affordance lives below. */}
      {timestamp !== undefined || (isSent && delivered !== undefined) || isFailed ? (
        <View style={[styles.metaRow, mediaOnly ? styles.metaRowMediaOnly : null]}>
          {timestamp !== undefined ? (
            <Text
              testID="bubble-time"
              style={[
                styles.time,
                isSent ? styles.timeSent : { color: themed.slate },
              ]}
            >
              {formatMessageTime(timestamp)}
            </Text>
          ) : null}
          {isFailed ? (
            <Text testID="bubble-failed-glyph" style={styles.failedGlyph}>
              !
            </Text>
          ) : isSent && delivered !== undefined ? (
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
        </View>
      ) : null}
    </Animated.View>
  );

  // Failed bubbles get a hint cue below — meta-style small caps,
  // slate so it reads as a hint and not a system error.
  //
  // `too_long` failures are non-retryable (the message will fail
  // for the same reason on every retry — see SEND_TEXT_MAX_CHARS in
  // rich-message-text.ts). Render with a different label and NO
  // tap-to-resend wrapper, so the user knows to shorten the text
  // instead of mashing "tap to resend" forever.
  //
  // All other failures (network blip, encrypt error, server 5xx)
  // are retryable — Pressable wraps the bubble + cue together so
  // the entire failed message area is tappable.
  if (isFailed) {
    const isTooLong = sendFailure === 'too_long';
    if (isTooLong) {
      return (
        <View style={styles.failedWrap}>
          {bubble}
          <Text style={[styles.resendCue, { color: themed.slate }]}>
            TOO LONG TO SEND · SHORTEN AND TRY AGAIN
          </Text>
        </View>
      );
    }
    if (onTapResend) {
      return (
        <Pressable
          onPress={onTapResend}
          accessibilityRole="button"
          accessibilityLabel={`Couldn't send. Tap to resend: ${text}`}
          style={styles.failedWrap}
        >
          {bubble}
          <Text style={[styles.resendCue, { color: themed.slate }]}>
            COULDN'T SEND · TAP TO RESEND
          </Text>
        </Pressable>
      );
    }
  }

  return bubble;
}

const styles = StyleSheet.create({
  base: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    maxWidth: '78%',
    overflow: 'hidden',
    marginVertical: 4,
  },
  // Media-only bubble: image fills edge-to-edge (radius clip via the
  // base `overflow: 'hidden'`). The trailing meta line gets its own
  // inset (metaRowMediaOnly) so the timestamp isn't jammed in the corner.
  mediaOnly: {
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  metaRowMediaOnly: {
    paddingHorizontal: space.md,
    paddingTop: space.xs,
    paddingBottom: space.sm,
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
  // Quoted-reply block at the top of a bubble. Left accent rule + tinted
  // surface so it reads as "this is the message being answered" without
  // competing with the body below it.
  replyQuote: {
    borderLeftWidth: 3,
    borderLeftColor: accent.base,
    borderRadius: 8,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    marginBottom: space.xs,
  },
  replyQuoteOnSent: {
    // Translucent dark wash reads as "inset" on the brass sent bubble.
    backgroundColor: 'rgba(0,0,0,0.16)',
    borderLeftColor: accent.foreground,
  },
  replyQuoteAuthor: {
    fontFamily: font.medium,
    fontSize: 12,
    marginBottom: 1,
  },
  replyQuotePreview: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 17,
  },
  replyQuoteTextOnSent: { color: 'rgba(255,255,255,0.85)' },
  // Read receipt — small + low-contrast so it never competes with
  // the message content. Cream-on-brass would blend; we go ink at
  // ~55% opacity for a "barely there" footprint that's still
  // legible against the brass sent-bubble.
  receipt: {
    fontFamily: font.medium,
    fontSize: 10,
    // alignSelf + marginTop intentionally omitted: the receipt now
    // lives inside `metaRow` which owns alignment + top spacing.
    marginRight: -2,
    letterSpacing: 0.5,
  },
  // Three distinct receipt states — the canonical messenger triad:
  //   sent       → single ✓, faded ink (server has it, peer doesn't yet)
  //   delivered  → double ✓✓, faded ink (peer device has it, unread)
  //   read       → double ✓✓, bold ink (peer opened the chat with it
  //                in view)
  //
  // Previously delivered and read shared the bold style, so the
  // delivered → read transition was invisible — the user couldn't
  // tell whether the peer had merely received the message or had
  // actually opened the conversation. Delivered now keeps the faded
  // 35% ink (mirroring the sent style) so it reads as "in transit on
  // the peer's side". Read keeps the full-weight bold ink as the
  // payoff state.
  //
  // Mode-invariant ink (`accent.foreground` = `#14091A`) holds against
  // the brass sent-bubble in both dark and light modes per brand §6.3.
  receiptSent: { color: `${accent.foreground}59` }, // 0x59 ≈ 35%
  receiptDelivered: { color: `${accent.foreground}59` }, // same fade — ✓✓ shape carries the state
  receiptRead: { color: accent.foreground, fontWeight: '700' as const },
  // Trailing meta row: holds the timestamp and (on sent bubbles) the
  // read-receipt glyph. Aligned to the bubble's trailing edge, small
  // gap between the two so they read as paired metadata not as part
  // of the message body.
  metaRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    alignSelf: 'flex-end',
    marginTop: space.xs,
    gap: 6,
  },
  time: {
    fontFamily: font.regular,
    fontSize: 10,
    letterSpacing: 0.3,
  },
  // Sent-bubble time picks up the same low-contrast ink as the receipt
  // so the brass background reads cleanly. Received-bubble time falls
  // back to the themed `slate` (set inline at the render site).
  timeSent: { color: `${accent.foreground}99` },
  // Send-failure treatment. The bubble keeps its brass identity but
  // sits at ~60% opacity so it reads as "in-limbo" without leaving the
  // palette (no red, no system-error chrome). The leading edge picks
  // up a thin ink border — a quiet "this needs your attention" cue
  // that mirrors the meta-row glyph rather than shouting.
  sentFailed: {
    opacity: 0.62,
    borderLeftWidth: 2,
    borderLeftColor: accent.foreground,
  },
  // Outer Pressable for a failed bubble — right-aligned so the bubble +
  // resend cue track the sent-bubble trailing edge instead of jumping
  // to the conversation's leading edge.
  failedWrap: {
    alignSelf: 'flex-end',
    alignItems: 'flex-end',
  },
  // "!" replaces the receipt glyph on a failed bubble. Ink at 100% so
  // it reads against the muted brass without borrowing the alarming
  // weight of a red icon.
  failedGlyph: {
    fontFamily: font.medium,
    fontSize: 11,
    fontWeight: '700' as const,
    color: accent.foreground,
    letterSpacing: 0.5,
    marginRight: -2,
  },
  // Resend cue beneath the bubble — meta-style small caps, slate so
  // the affordance reads as a hint, not a system error. Matches the
  // tagline microcopy used elsewhere on the chat screen.
  resendCue: {
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
    marginTop: 4,
    marginRight: 4,
  },
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
