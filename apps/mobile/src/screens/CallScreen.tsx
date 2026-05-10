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
import { useProfiles } from '../store/profiles.js';
import { useSettings } from '../store/settings.js';
import { space, useColors } from '../theme/index.js';
import { callPalette, font, type as typeScale } from '../theme/tokens.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

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
  const ownAnimalId =
    ownProfile?.selectedAvatarId ??
    (myUserId ? defaultAnimalForUser(myUserId) : 'fox');

  const [elapsed, setElapsed] = useState('');

  // Animated levels for the two mouths. We push the raw poll into
  // these via a 200ms timing animation — that's longer than the 80ms
  // poll cadence, so values cross-fade rather than step. The mouth
  // scale interpolation lives inside AvatarRenderer; here we only
  // have to keep the [0, 1] amplitude smooth.
  const localAmp = useRef(new Animated.Value(0)).current;
  const remoteAmp = useRef(new Animated.Value(0)).current;

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

  // Auto-dismiss after the orchestrator clears `active`.
  useEffect(() => {
    if (!active) {
      const t = setTimeout(onClosed, 1200);
      return () => clearTimeout(t);
    }
  }, [active, onClosed]);

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
              an active call attempt. */}
          <View style={styles.outgoingDoorWrap}>
            <RingingRings primary={themed.primary} />
            <BrandPulse />
          </View>
          <Text style={[styles.outgoingEyebrow, { color: themed.slate }]}>
            VOICE CALL
          </Text>
          <View style={styles.outgoingHandle}>
            <Handle value={active.peerUserId} variant="display" />
          </View>
          <Text style={[styles.outgoingState, { color: themed.slate }]}>
            {active.stage === 'outgoing_dialing'
              ? 'reaching them'
              : 'their phone is ringing'}
            <Text style={{ color: themed.primary }}>.</Text>
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
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 750,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.6,
          duration: 750,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
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
function RingingRings({ primary }: { primary: string }): React.ReactElement {
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
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
  }, [ring1, ring2, ring3]);

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
}): React.ReactElement {
  const scale = useRef(new Animated.Value(0.95)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    let running = false;
    const id = amplitude.addListener(({ value }) => {
      if (value > 0.05 && !running) {
        running = true;
        scale.setValue(0.95);
        opacity.setValue(0.5);
        Animated.parallel([
          Animated.timing(scale, {
            toValue: 1.18,
            duration: 900,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0,
            duration: 900,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]).start(() => {
          running = false;
        });
      }
    });
    return () => amplitude.removeListener(id);
  }, [amplitude, scale, opacity]);
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
    marginBottom: 28,
  },
  outgoingEyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    marginBottom: 12,
  },
  outgoingHandle: { marginBottom: 6 },
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
});
