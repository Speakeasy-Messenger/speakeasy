import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import InCallManager from 'react-native-incall-manager';
import {
  MicIcon,
  PhoneEndIcon,
  SpeakerIcon,
} from '../components/icons/CallIcons.js';
import { CipherS } from '../brand/CipherS.js';
import { Handle } from '../components/Handle.js';
import { PortraitTile } from '../components/PortraitTile.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { useCalls } from '../store/calls.js';
import { useIdentity } from '../store/identity.js';
import {
  selectPeerAnimation,
  usePeerAnimation,
} from '../store/peer-animation.js';
import { useProfiles } from '../store/profiles.js';
import { useSettings } from '../store/settings.js';
import { space, useColors } from '../theme/index.js';
import { callPalette, font, motion, type as typeScale } from '../theme/tokens.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import { useReducedMotion } from '../a11y/useReducedMotion.js';

interface Props {
  orchestrator: CallOrchestrator;
  onClosed: () => void;
}

/**
 * In-call screen — shows the peer + self animal portraits, the
 * ringing/connected state, and the three live controls (mute /
 * speaker / hang up). Renders for both outgoing and incoming
 * connected calls. The IncomingCallScreen renders before this one
 * for `incoming_ringing`.
 *
 * Spec §5: each portrait's mouth animates from the matching audio
 * level. Local portrait reads the mic; peer portrait reads the
 * incoming RTP. Levels are sampled by the orchestrator from
 * `pc.getStats()` at ~12 Hz; we tween them over 200ms inside the JS
 * value so the mouth doesn't snap on every poll.
 */
export function CallScreen({ orchestrator, onClosed }: Props) {
  const themed = useColors();
  const active = useCalls((s) => s.active);
  const myUserId = useIdentity((s) => s.userId);

  const peerProfile = useProfiles((s) =>
    active ? s.byUserId[active.peerUserId] : undefined,
  );
  const ownProfile = useProfiles((s) =>
    myUserId ? s.byUserId[myUserId] : undefined,
  );
  const peerAnimalId =
    peerProfile?.selectedAvatarId ??
    (active ? defaultAnimalForUser(active.peerUserId) : 'fox');
  // Phase 5j Private Call — pull the peer's latest decoded emotion
  // state from the animation store (set by the orchestrator's
  // onPeerAnimationFrame, fed by the WebRTC data channel). Only
  // applies on kind='private'; for audio/video the store stays at
  // 'baseline' and the avatar renders neutrally.
  const peerAnimation = usePeerAnimation((s) =>
    active ? selectPeerAnimation(s, active.peerUserId) : undefined,
  );
  const peerEmotionState =
    active?.kind === 'private' ? peerAnimation?.emotionState : undefined;
  const ownAnimalId =
    ownProfile?.selectedAvatarId ??
    (myUserId ? defaultAnimalForUser(myUserId) : 'fox');

  const [elapsed, setElapsed] = useState('');

  /**
   * Capture the call's last `endedReason` so the inline failure UI can
   * survive the orchestrator clearing `active` to undefined (which
   * happens ~immediately after the 'ended' stage fires). Without this
   * the failure copy flashes for one frame, then snaps to the generic
   * "Call ended" placeholder. See /plan-design-review D6 — failure-UI
   * placement: inline on CallScreen, NOT a modal that auto-dismisses.
   */
  const [lastEndedReason, setLastEndedReason] = useState<
    NonNullable<typeof active>['endedReason'] | undefined
  >(undefined);
  const wasPrivateCall = useRef(false);
  useEffect(() => {
    if (active?.kind === 'private') wasPrivateCall.current = true;
    if (active?.stage === 'ended' && active.endedReason) {
      setLastEndedReason(active.endedReason);
    }
    if (active && active.stage !== 'ended') {
      // New call started — wipe stale failure state from a prior call.
      setLastEndedReason(undefined);
      wasPrivateCall.current = active.kind === 'private';
    }
  }, [active]);

  // Animated levels for the two mouths. We push the raw poll into
  // these via a 200ms timing animation — that's longer than the 80ms
  // poll cadence, so values cross-fade rather than step. The mouth
  // scale interpolation lives inside AvatarRenderer; here we only
  // have to keep the [0, 1] amplitude smooth.
  const localAmp = useRef(new Animated.Value(0)).current;
  const remoteAmp = useRef(new Animated.Value(0)).current;

  /**
   * Tick once the Private Call init window (1s after entering
   * outgoing_dialing) elapses, so the caption swaps from
   * "Initializing private mode…" to the standard ringback line. The
   * comparison `Date.now() - stageEnteredAt < 1000` is otherwise
   * frozen at render time and never re-evaluates without a state
   * change to trigger the re-render.
   */
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (
      active?.kind !== 'private' ||
      active.stage !== 'outgoing_dialing'
    ) {
      return undefined;
    }
    const elapsed = Date.now() - active.stageEnteredAt;
    if (elapsed >= 1000) return undefined;
    const t = setTimeout(() => forceTick((n) => n + 1), 1000 - elapsed);
    return () => clearTimeout(t);
  }, [active?.kind, active?.stage, active?.stageEnteredAt]);

  // CALLS.md §06 — chat-history system bubble for call end.
  // Moved (rc.55) to the orchestrator's `onCallFinished` deps
  // callback in App.tsx so it fires once per terminal call regardless
  // of whether this screen is still mounted, and isn't fragile to
  // back-to-back calls where a fresh outgoing call replaces `active`
  // before the intermediate `undefined` render commits.

  useEffect(() => {
    if (active?.stage !== 'connected' || !active.connectedAt) {
      setElapsed('');
      return;
    }
    const tick = () => {
      const sec = Math.floor((Date.now() - active.connectedAt!) / 1000);
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      setElapsed(`${mm}:${ss}`);
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [active?.stage, active?.connectedAt]);

  // Subscribe to audio levels only while connected. Before that the
  // peer connection is still negotiating and stats are noisy; after
  // close the orchestrator unsubscribes us anyway, but the explicit
  // gate keeps the JS poll quiet during ring.
  // SETTINGS.md §4.1: when "Animate avatar mouth" is off, skip the
  // audio-level subscription entirely — the mouths hold at idle and
  // the speech-ring is suppressed. Cheaper than running the poll
  // and ignoring it.
  const animateMouth = useSettings((s) => s.animateAvatarMouth);
  useEffect(() => {
    if (active?.stage !== 'connected' || !animateMouth) return;
    const unsubscribe = orchestrator.onAudioLevels(({ local, remote }) => {
      // Mute zeros the local amplitude — the spec mouth-at-rest pose
      // matches "I'm not speaking" so this is the natural cue.
      const localTarget = active.micMuted ? 0 : local;
      Animated.timing(localAmp, {
        toValue: localTarget,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
      Animated.timing(remoteAmp, {
        toValue: remote,
        duration: 200,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
    return unsubscribe;
  }, [active?.stage, active?.micMuted, animateMouth, orchestrator, localAmp, remoteAmp]);

  // Auto-dismiss after the orchestrator clears `active` — EXCEPT when
  // the call ended with a filter-failure variant. The brand promise is
  // failure-closed: the user must explicitly tap "Back to chat" so the
  // failure copy is unambiguously seen (no silent fallback to voice).
  const isFilterFailure =
    lastEndedReason === 'filter_failure' ||
    lastEndedReason === 'peer_filter_failure';
  useEffect(() => {
    if (!active && !isFilterFailure) {
      const t = setTimeout(onClosed, 1200);
      return () => clearTimeout(t);
    }
  }, [active, isFilterFailure, onClosed]);

  // CALLS.md §02 — outgoing pre-connect view shows a pulsing brass
  // brand mark in place of the peer portrait. The peer's animal
  // doesn't surface until the call connects (then it dissolves into
  // the connected layout).
  // Computed BEFORE the `if (!active) return` guard below so the
  // ringback effect (which depends on it) is called unconditionally
  // — React requires hook order be stable across renders, and an
  // ended call drops `active` to undefined which would otherwise
  // skip a hook.
  const isOutgoingPreConnect =
    active?.stage === 'outgoing_dialing' || active?.stage === 'outgoing_ringing';

  // Ringback while we're calling — `incallmanager_ringback.mp3` is
  // bundled in android raw resources. Passing `_BUNDLE_` to InCallManager
  // resolves to that filename specifically (the lib hardcodes the
  // lookup key); arbitrary names silently fall back to the system
  // default ringtone, which is what the rc.23 attempt did.
  useEffect(() => {
    if (isOutgoingPreConnect) {
      try {
        InCallManager.startRingback('_BUNDLE_');
      } catch {
        /* InCallManager unavailable in non-native test envs — fine */
      }
      return () => {
        try {
          InCallManager.stopRingback();
        } catch {
          /* ignore */
        }
      };
    }
    return undefined;
  }, [isOutgoingPreConnect]);

  if (!active) {
    if (isFilterFailure) {
      // Inline Private Call failure UI — /plan-design-review D6 + D7.
      // Same chrome as outgoing pre-connect (cream background, static
      // brass mark in place of BrandPulse), distinct copy depending on
      // which side's filter failed, single 'Back to chat' button. No
      // auto-dismiss — user reads then taps. Locked from
      // /plan-design-review's locked decisions table.
      const failureCopy =
        lastEndedReason === 'peer_filter_failure'
          ? 'Private Call ended due to a technical issue on the other end.'
          : "Couldn't start Private Call on this device.";
      return (
        <SafeAreaView
          style={[styles.root, { backgroundColor: themed.cream }]}
          testID="call-screen-private-failure"
        >
          <View style={styles.outgoing}>
            <View style={styles.outgoingDoorWrap}>
              {/* Static brass mark — same diameter as BrandPulse's
                  inner mark, no motion. The failure-closed posture is
                  the brand promise; nothing pulses here because nothing
                  is happening. */}
              <CipherS size={56} color={themed.primary} />
            </View>
            <Text style={[styles.outgoingEyebrow, { color: themed.slate }]}>
              PRIVATE CALL
            </Text>
            <Text
              style={[styles.outgoingState, { color: themed.slate }]}
              testID="private-failure-caption"
            >
              {failureCopy}
            </Text>
          </View>
          <View style={styles.outgoingActions}>
            <Pressable
              testID="private-failure-back"
              onPress={onClosed}
              accessibilityLabel="Back to chat"
              style={[styles.backBtn, { borderColor: themed.divider }]}
            >
              <Text style={[styles.backBtnText, { color: themed.ink }]}>
                Back to chat
              </Text>
            </Pressable>
          </View>
        </SafeAreaView>
      );
    }
    return (
      <SafeAreaView
        style={[styles.root, { backgroundColor: themed.cream }]}
        testID="call-screen-ended"
      >
        <Text style={[styles.endedLabel, { color: themed.slate }]}>Call ended</Text>
      </SafeAreaView>
    );
  }

  const stageLabel: Record<typeof active.stage, string> = {
    idle: '',
    outgoing_dialing: 'Calling…',
    outgoing_ringing: 'Ringing',
    incoming_ringing: 'Incoming',
    connecting: 'Connecting',
    connected: elapsed || '00:00',
    ended: 'Call ended',
  };

  if (isOutgoingPreConnect) {
    const isPrivate = active.kind === 'private';
    // Private init window: first second after entering outgoing_dialing
    // shows "Initializing private mode…" instead of the standard
    // ringback caption. Cap mirrors the plan's 1s init budget.
    // Locked /plan-design-review D4 + D9: reuse BrandPulse (existing
    // motion.pulse, 750ms) + caption "Initializing private mode…".
    const inPrivateInit =
      isPrivate &&
      active.stage === 'outgoing_dialing' &&
      Date.now() - active.stageEnteredAt < 1000;
    const eyebrowText = isPrivate ? 'PRIVATE CALL' : 'VOICE CALL';
    let stateText: string;
    if (inPrivateInit) {
      stateText = 'Initializing private mode…';
    } else if (isPrivate) {
      stateText =
        active.stage === 'outgoing_dialing'
          ? 'reaching them privately'
          : 'their phone is ringing';
    } else {
      stateText =
        active.stage === 'outgoing_dialing'
          ? 'reaching them'
          : 'their phone is ringing';
    }
    return (
      <SafeAreaView
        style={[styles.root, { backgroundColor: themed.cream }]}
        testID="call-screen"
      >
        <View style={styles.outgoing}>
          {/* Ringing rings emanate from the Door mark while the call
              is dialing or ringing. Three staggered concentric brass
              rings expand outward and fade — the classic "we're
              trying to reach them" visual. Earlier alphas had only
              the Door pulse, which tested as too subtle to read as
              an active call attempt.
              Private init: skip the RingingRings (no peer ring yet),
              keep just the BrandPulse to read as "something's
              happening" without over-promising a ringback in flight. */}
          <View style={styles.outgoingDoorWrap}>
            {!inPrivateInit && <RingingRings primary={themed.primary} />}
            <BrandPulse />
          </View>
          <Text style={[styles.outgoingEyebrow, { color: themed.slate }]}>
            {eyebrowText}
          </Text>
          <View style={styles.outgoingHandle}>
            <Handle value={active.peerUserId} variant="display" />
          </View>
          <Text
            style={[styles.outgoingState, { color: themed.slate }]}
            testID="outgoing-state"
          >
            {stateText}
            {!inPrivateInit && <Text style={{ color: themed.primary }}>.</Text>}
          </Text>
        </View>
        <View style={styles.outgoingActions}>
          <Pressable
            testID="call-end"
            onPress={() => orchestrator.hangup()}
            style={[styles.endBtn, { backgroundColor: callPalette.decline }]}
            hitSlop={4}
          >
            <PhoneEndIcon size={32} color={themed.cream} />
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="call-screen"
    >
      <View style={styles.peer}>
        {/* Private Call connected eyebrow — persistent "this voice is
            masked" cue throughout the call. Reuses meta type from the
            incoming ring eyebrow grammar (locked /plan-design-review
            D5). Voice/video calls show no eyebrow here; only Private
            needs the constant reminder. */}
        {active.kind === 'private' && active.stage === 'connected' && (
          <Text
            style={[styles.connectedEyebrow, { color: themed.primary }]}
            testID="private-connected-eyebrow"
          >
            PRIVATE CALL · CONNECTED
          </Text>
        )}
        {/* Brass speech-ring per CALLS.md §04: a 1px brass ring
            expands outward from the peer tile when their voice is
            audible. Driven by remoteAmp; opacity fades to 0 while
            scale runs to 1.18 over 1s, so loud speech leaves a
            trail of expanding rings. */}
        <SpeechRing amplitude={remoteAmp} primary={themed.primary} />
        <PortraitTile
          kind="animal"
          id={peerAnimalId}
          size={120}
          amplitude={remoteAmp}
          emotionState={peerEmotionState}
        />
        <Handle value={active.peerUserId} variant="display" />
        <Text style={[styles.stageLabel, { color: themed.slate }]}>
          {stageLabel[active.stage]}
        </Text>
      </View>

      {/* Self-view — small portrait next to the controls. Spec §5:
          shows the local mouth animating from the mic so the user
          gets feedback that audio is going out (and a clear visual
          when muted: the mouth stops). */}
      {myUserId ? (
        <View style={styles.selfStrip}>
          <PortraitTile
            kind="animal"
            id={ownAnimalId}
            size={44}
            amplitude={localAmp}
          />
          <Text style={[styles.selfLabel, { color: themed.slate }]}>
            {active.micMuted ? 'MIC MUTED' : 'YOU'}
          </Text>
        </View>
      ) : null}

      <View style={styles.controls}>
        <Pressable
          testID="call-mute"
          onPress={() => orchestrator.setMicMuted(!active.micMuted)}
          style={[
            styles.controlBtn,
            { backgroundColor: themed.pale },
            active.micMuted && { backgroundColor: themed.primary },
          ]}
        >
          <MicIcon
            size={26}
            muted={active.micMuted}
            color={active.micMuted ? themed.cream : themed.ink}
          />
        </Pressable>
        <Pressable
          testID="call-end"
          onPress={() => orchestrator.hangup()}
          style={[styles.endBtn, { backgroundColor: callPalette.decline }]}
        >
          <PhoneEndIcon size={32} color={themed.cream} />
        </Pressable>
        <Pressable
          testID="call-speaker"
          onPress={() => orchestrator.setSpeakerOn(!active.speakerOn)}
          style={[
            styles.controlBtn,
            { backgroundColor: themed.pale },
            active.speakerOn && { backgroundColor: themed.primary },
          ]}
        >
          <SpeakerIcon
            size={26}
            active={active.speakerOn}
            color={active.speakerOn ? themed.cream : themed.ink}
          />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

/**
 * Pulsing brand mark — the loading state for an outgoing call. Was
 * the Door mark per CALLS.md §02; swapped to the CipherS glyph in
 * rc.19 for visual continuity with the app icon and splash screen
 * (the Door mark only appears in onboarding/IdReveal and tested as
 * out-of-place here). Opacity loops 60% ↔ 100% over 1.5s.
 */
function BrandPulse(): React.ReactElement {
  const opacity = useRef(new Animated.Value(0.6)).current;
  // Phase 5j Private Call — soft-honor reduce-motion (locked
  // /plan-design-review D12): static brass mark, no pulse.
  // Mouth amplitude + emotion-state changes still apply elsewhere;
  // BrandPulse is decorative ambient motion that triggers
  // vestibular issues for some users.
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) {
      opacity.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: motion.pulse,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.6,
          duration: motion.pulse,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reducedMotion]);
  return (
    <Animated.View
      style={{ opacity }}
      testID="call-brand-pulse"
    >
      <CipherS size={84} />
    </Animated.View>
  );
}

/**
 * Three concentric brass rings emanating from the Door mark on the
 * outgoing pre-connect view. Each ring expands from scale 1.0 → 1.8
 * and fades opacity 0.5 → 0 over 1.6s; the three are staggered by
 * 533ms so the cycle reads as a continuous wave of waves. Pure
 * decorative — the call state's actual live data lives in the eyebrow
 * label one row down.
 */
function RingingRings({ primary }: { primary: string }): React.ReactElement | null {
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  // Pure decorative sweeping motion — soft-honor reduce-motion by
  // rendering nothing (locked /plan-design-review D12). The eyebrow
  // + state caption still tell the user the call is in flight.
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (reducedMotion) return undefined;
    const period = 1600;
    const stagger = period / 3;
    function animate(v: Animated.Value, delay: number) {
      v.setValue(0);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, {
            toValue: 1,
            duration: period,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
      );
      loop.start();
      return loop;
    }
    const l1 = animate(ring1, 0);
    const l2 = animate(ring2, stagger);
    const l3 = animate(ring3, stagger * 2);
    return () => {
      l1.stop();
      l2.stop();
      l3.stop();
    };
  }, [ring1, ring2, ring3, reducedMotion]);

  if (reducedMotion) return null;

  function ringStyle(v: Animated.Value) {
    return {
      position: 'absolute' as const,
      width: 144,
      height: 144,
      borderWidth: 1,
      borderColor: primary,
      transform: [
        {
          scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }),
        },
      ],
      opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
    };
  }

  return (
    <>
      <Animated.View pointerEvents="none" style={ringStyle(ring1)} />
      <Animated.View pointerEvents="none" style={ringStyle(ring2)} />
      <Animated.View pointerEvents="none" style={ringStyle(ring3)} />
    </>
  );
}

/**
 * Brass 1px ring that expands outward from the peer portrait when
 * the remote speaker is audible. Sized to circumscribe the 120×120
 * portrait tile; runs continuously while amplitude > 0.05. Opacity
 * fades from 0.5 → 0 across the expansion so loud speech leaves a
 * brief comet-trail.
 */
function SpeechRing({
  amplitude,
  primary,
}: {
  amplitude: Animated.Value;
  primary: string;
}): React.ReactElement | null {
  const scale = useRef(new Animated.Value(0.95)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  // Soft-honor reduce-motion: skip the speech ring entirely. The
  // mouth amplitude on the avatar itself continues to drive from
  // the same `amplitude` value, which is the LOAD-bearing visual
  // ("avatar is speaking"); the ring is decorative atmosphere.
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (reducedMotion) return undefined;
    let running = false;
    const id = amplitude.addListener(({ value }) => {
      if (value > 0.05 && !running) {
        running = true;
        scale.setValue(0.95);
        opacity.setValue(0.5);
        Animated.parallel([
          Animated.timing(scale, {
            toValue: 1.18,
            duration: motion.ripple,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0,
            duration: motion.ripple,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]).start(() => {
          running = false;
        });
      }
    });
    return () => amplitude.removeListener(id);
  }, [amplitude, scale, opacity, reducedMotion]);
  if (reducedMotion) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: 132,
        height: 132,
        borderWidth: 1,
        borderColor: primary,
        opacity,
        transform: [{ scale }],
      }}
    />
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'space-between',
    paddingVertical: space.xl,
  },
  peer: {
    alignItems: 'center',
    gap: space.md,
    marginTop: '20%',
  },
  // Outgoing pre-connect (CALLS.md §02) — Door mark + eyebrow +
  // handle + state caption stacked centered.
  outgoing: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  // Wraps the Door mark + the RingingRings overlay so the rings
  // emanate centered on the Door without affecting siblings' layout.
  outgoingDoorWrap: {
    width: 144,
    height: 144,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xl,
  },
  outgoingEyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  outgoingHandle: { marginBottom: space.sm },
  outgoingState: {
    fontFamily: font.regular,
    fontSize: 14,
  },
  outgoingActions: {
    paddingBottom: space.xl,
    alignItems: 'center',
  },
  stageLabel: {
    fontFamily: font.regular,
    fontSize: 14,
    letterSpacing: 0.4,
  },
  selfStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xl,
  },
  selfLabel: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
  },
  // Sharp 64×64 squares (no pill) — call controls follow brand restraint.
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
  },
  controlBtn: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endedLabel: {
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
    textAlign: 'center',
    marginTop: '40%',
  },
  // Private Call connected eyebrow — same meta-type values as the
  // ring-screen eyebrow ('VOICE CALL · INCOMING'), positioned above the
  // peer portrait so it reads as continuous with the existing grammar.
  connectedEyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    marginBottom: space.sm,
  },
  // 'Back to chat' button on the inline Private Call failure screen.
  // Same transparent + 1px-border treatment as the IncomingCallScreen
  // Decline button so the action vocabulary stays consistent.
  backBtn: {
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderWidth: 1,
    backgroundColor: 'transparent',
  },
  backBtnText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
