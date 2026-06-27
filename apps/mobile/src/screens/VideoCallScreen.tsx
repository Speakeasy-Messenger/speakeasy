import React, { useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RTCView } from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import {
  MicIcon,
  PhoneEndIcon,
  SpeakerIcon,
} from '../components/icons/CallIcons.js';
import { Handle } from '../components/Handle.js';
import { useCalls } from '../store/calls.js';
import { space, useColors } from '../theme/index.js';
import { callPalette, font, type as typeScale } from '../theme/tokens.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

interface Props {
  orchestrator: CallOrchestrator;
  onClosed: () => void;
}

/**
 * Live video call surface — full-bleed remote stream, picture-in-picture
 * local preview, three controls (mute, hang up, flip camera).
 *
 * Diverges deliberately from the audio CallScreen brand treatment:
 * audio calls show animal portraits + speech rings; video calls fill
 * the screen with the peer's actual face. The brand mark surfaces
 * only as the connecting-state placeholder before the remote stream
 * arrives.
 */
export function VideoCallScreen({ orchestrator, onClosed }: Props) {
  const themed = useColors();
  const active = useCalls((s) => s.active);

  const [localUrl, setLocalUrl] = useState<string | undefined>();
  const [remoteUrl, setRemoteUrl] = useState<string | undefined>();
  const [elapsed, setElapsed] = useState('');
  // Picture-in-picture swap: false = remote full-screen / local in the
  // corner bubble (default once connected); true = local full-screen /
  // remote in the bubble. Tapping the bubble toggles it.
  const [swapped, setSwapped] = useState(false);

  // Chat-history bubble for call end is emitted from the orchestrator's
  // onCallFinished deps callback in App.tsx (rc.55). Was previously a
  // screen-side useEffect keyed on `prev && !active`, which dropped
  // bubbles when a new outgoing call replaced `active` before React
  // committed the intermediate undefined render.

  // Subscribe to the local + remote stream URLs from the peer. The
  // orchestrator exposes the active peer reference; calling
  // `getLocalStreamURL()` after the local stream is ensured returns
  // the toURL() string we hand to RTCView.
  useEffect(() => {
    if (!active) return;
    setLocalUrl(orchestrator.getLocalStreamURL());
    const unsub = orchestrator.onRemoteStreamURL((url) => {
      setRemoteUrl(url);
    });
    // Some platforms surface the local URL slightly after first paint
    // (camera warmup). Re-poll once after 600ms to catch that case.
    const t = setTimeout(() => {
      setLocalUrl((prev) => prev ?? orchestrator.getLocalStreamURL());
    }, 600);
    return () => {
      clearTimeout(t);
      unsub();
    };
  }, [orchestrator, active?.callId]);

  // Live duration counter once connected.
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

  // Auto-dismiss after the orchestrator clears `active`. 300ms to match
  // CallScreen: 1200ms made a user-initiated hangup feel broken (the screen
  // lingered ~1.2s after End, so testers re-called thinking it failed). The
  // call_end propagates + tears down both sides in ~0.3s.
  useEffect(() => {
    if (!active) {
      const t = setTimeout(onClosed, 300);
      return () => clearTimeout(t);
    }
  }, [active, onClosed]);

  // Outgoing-pre-connect ringback. Mirrors the audio CallScreen path
  // — same incallmanager_ringback.mp3 (owl-with-forest-ambient bed)
  // bundled in res/raw via _BUNDLE_. Hook is run unconditionally with
  // the gate inside, same shape as the rc.28 fix in CallScreen, so
  // the hook count stays stable across the active=null teardown.
  const isOutgoingPreConnect =
    active?.stage === 'outgoing_dialing' || active?.stage === 'outgoing_ringing';
  useEffect(() => {
    if (isOutgoingPreConnect) {
      try {
        InCallManager.startRingback('_BUNDLE_');
      } catch {
        /* ignore — non-native test env */
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
      <SafeAreaView style={[styles.root, { backgroundColor: themed.cream }]}>
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
    // While an ICE flap is recovering, show "Reconnecting…" rather than a
    // timer that keeps ticking as if the call were healthy.
    connected: active.reconnecting ? 'Reconnecting…' : elapsed || '00:00',
    ended: 'Call ended',
  };

  // Layout: the remote video only fills the screen once it's actually
  // flowing. Until then (dialing / ringing / connecting) the user's OWN
  // feed is full-screen; when the peer's video arrives it migrates to the
  // corner bubble. Tapping the bubble swaps which feed is full-screen.
  //
  // Mirroring: neither feed is mirrored. A tester reported her own
  // self-preview looked left-right flipped ("sides inverted") — the
  // conventional selfie-mirror. She wants it un-mirrored (as a photo /
  // as the peer sees her), so we render the local feed raw. The remote
  // feed was never mirrored.
  const remoteActive = !!remoteUrl;
  const fullscreenIsLocal = !remoteActive || swapped;
  const fullscreenUrl = fullscreenIsLocal ? localUrl : remoteUrl;
  // The bubble only exists once both feeds are present (i.e. connected).
  const pipUrl = remoteActive ? (swapped ? remoteUrl : localUrl) : undefined;

  return (
    <View style={styles.root}>
      {/* Full-screen feed — local while waiting, remote once it flows
          (or local again when swapped). Black until any media exists. */}
      {fullscreenUrl ? (
        <RTCView
          streamURL={fullscreenUrl}
          style={styles.remoteView}
          objectFit="cover"
        />
      ) : (
        <View style={[styles.remoteView, { backgroundColor: '#000' }]} />
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        {/* Top bar: peer handle + stage label. Translucent over the
            video stream so the user can read it without it taking
            real-estate from the picture. */}
        <View style={styles.topBar}>
          {/* Force a light handle color: the top bar is always over
              the video stream + a dark scrim, so themed.ink (dark in
              light mode) renders the handle invisible. Matches the
              hardcoded white of the stage label below. */}
          <Handle
            value={active.peerUserId}
            variant="display"
            color={callPalette.fg}
          />
          <Text style={styles.topStage}>{stageLabel[active.stage]}</Text>
        </View>

        {/* Corner bubble — the non-full-screen feed. Tap to swap which
            feed is full-screen. Only shown once the peer's video is
            flowing (before that, the local feed owns the full screen). */}
        {pipUrl ? (
          <Pressable
            testID="video-call-pip"
            style={styles.pip}
            onPress={() => setSwapped((s) => !s)}
          >
            <RTCView
              streamURL={pipUrl}
              style={StyleSheet.absoluteFill}
              objectFit="cover"
              zOrder={1}
            />
          </Pressable>
        ) : null}

        {/* Bottom controls. Mute / hang up / flip camera. */}
        <View style={styles.controls}>
          <Pressable
            testID="video-call-mute"
            onPress={() => orchestrator.setMicMuted(!active.micMuted)}
            style={[
              styles.controlBtn,
              active.micMuted && { backgroundColor: themed.primary },
            ]}
          >
            <MicIcon
              size={26}
              muted={active.micMuted}
              color={active.micMuted ? themed.cream : '#FFF'}
            />
          </Pressable>
          <Pressable
            testID="video-call-speaker"
            onPress={() => orchestrator.setSpeakerOn(!active.speakerOn)}
            style={[
              styles.controlBtn,
              active.speakerOn && { backgroundColor: themed.primary },
            ]}
          >
            <SpeakerIcon
              size={26}
              active={active.speakerOn}
              color={active.speakerOn ? themed.cream : '#FFF'}
            />
          </Pressable>
          <Pressable
            testID="video-call-end"
            onPress={() => orchestrator.hangup()}
            style={[styles.endBtn, { backgroundColor: callPalette.decline }]}
          >
            <PhoneEndIcon size={32} color={themed.cream} />
          </Pressable>
          <Pressable
            testID="video-call-flip"
            onPress={() => void orchestrator.flipCamera()}
            style={styles.controlBtn}
          >
            <Text style={styles.flipGlyph}>↺</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  remoteView: { ...StyleSheet.absoluteFillObject },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'space-between' },
  topBar: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    alignItems: 'center',
    gap: 4,
    // Subtle scrim to keep handle readable on bright backgrounds.
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  topStage: {
    fontFamily: typeScale.meta.weight,
    fontSize: typeScale.meta.size,
    letterSpacing: typeScale.meta.size * typeScale.meta.letterSpacingEm,
    textTransform: 'uppercase',
    color: '#FFFFFFCC',
  },
  pip: {
    position: 'absolute',
    // Sits below the top bar (handle + stage label) so the bubble no
    // longer clips into it. Was 80, which slightly overlapped.
    top: 116,
    right: space.md,
    width: 100,
    height: 140,
    backgroundColor: '#222',
    overflow: 'hidden',
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
    backgroundColor: 'rgba(0,0,0,0.4)',
    paddingTop: space.lg,
  },
  controlBtn: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  endBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flipGlyph: {
    fontFamily: font.bold,
    fontSize: 26,
    color: '#FFF',
  },
  endedLabel: {
    fontFamily: font.medium,
    fontSize: typeScale.subtitle.size,
    letterSpacing: typeScale.subtitle.size * typeScale.subtitle.letterSpacingEm,
    textAlign: 'center',
    marginTop: '40%',
  },
});
