import React, { useEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
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
import { pip } from '../native/pip.js';
import { diag } from '../diag/log.js';
import { useCalls } from '../store/calls.js';
import { space, useColors } from '../theme/index.js';
import { callPalette, font, type as typeScale } from '../theme/tokens.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

interface Props {
  orchestrator: CallOrchestrator;
  onClosed: () => void;
}

// iOS Picture-in-Picture: when the app backgrounds during a video call,
// auto-float the REMOTE video into a system PiP window so the user keeps
// seeing the other person after leaving the app (iOS 15+, built into
// react-native-webrtc's RTCView). Only the remote feed gets PiP — the
// local camera suspends in the background, so PiP'ing it would freeze.
const VIDEO_PIP_OPTS = {
  enabled: true,
  startAutomatically: true,
  stopAutomatically: true,
} as const;

// A PiP/floating call window is physically tiny — its smaller dimension is
// ~108–160dp (Android clamps our 9:16 request into that range), whereas the
// smallest real phone screen is ≥ 320dp in its short axis, and split-screen
// halves only ONE axis (so its short axis stays full-width). So "short side
// below this" reliably means "we're in the small floating window", with a
// wide safety margin. We collapse to just-the-video on this signal rather
// than depending solely on the native PiP-mode event reaching JS — that
// event round-trip (DeviceEventEmitter under bridgeless new-arch) has been
// unreliable, but RN's window-resize reflow on the PiP config change is not.
const PIP_COMPACT_MAX_SHORT_SIDE = 280;

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
  // Android system-PiP (the floating window after pressing Home). While in
  // it we hide the overlay chrome so only the video shows in the small frame.
  const [inPip, setInPip] = useState(false);
  // PiP window dimensions. RN reflows to the small window on PiP enter; we use
  // the live size to (a) diagnose the scaling report and (b) confirm inPip
  // actually propagated. The fullscreen RTCView is also keyed on inPip so its
  // SurfaceView re-creates at the new window size (Android SurfaceViews keep
  // their pre-resize buffer otherwise → the feed fills only part of the bubble).
  const { width: winW, height: winH } = useWindowDimensions();
  // The authoritative "collapse to just the video" signal. True when the
  // native PiP event told us so OR — the reliable fallback — when the window
  // has reflowed to the tiny floating size. Either path drives BOTH the
  // chrome-hide and the SurfaceView remount, so the bubble shows only the
  // counterparty's face even when the native event never arrives.
  const compact = inPip || Math.min(winW, winH) < PIP_COMPACT_MAX_SHORT_SIDE;
  useEffect(() => {
    diag('call', 'pip mode change', {
      inPip,
      compact,
      winW: Math.round(winW),
      winH: Math.round(winH),
    });
  }, [inPip, compact, winW, winH]);

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

  // Android PiP: mark a video call on-screen so pressing Home floats it
  // into a PiP window (iOS uses the RTCView iosPIP prop instead). Hide the
  // overlay chrome while in the small PiP frame. No-op on iOS.
  useEffect(() => {
    pip.setVideoCallActive(true);
    const unsub = pip.onPipModeChanged(setInPip);
    // Closing the PiP bubble (vs expanding it back) must END the call —
    // otherwise the camera/mic/ring keep running headless.
    const unsubClosed = pip.onPipClosed(() => orchestrator.hangup());
    return () => {
      pip.setVideoCallActive(false);
      unsub();
      unsubClosed();
    };
  }, [orchestrator]);

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
  // Mirroring: the LOCAL self-preview is mirrored (the selfie-mirror
  // convention every video app uses — you see yourself as in a mirror),
  // wherever it currently lives (full-screen while ringing, or the corner
  // bubble once connected). The REMOTE feed is never mirrored — the peer
  // must appear the right way round. We mirror whichever RTCView is showing
  // `localUrl`. (Earlier this was rendered raw/un-mirrored; the un-mirrored
  // preview reads as backwards to the user, so it's restored to mirrored.)
  // Treat the remote feed as "active" (take the full screen, push local to the
  // corner bubble) only once the call is actually CONNECTED — not the instant
  // the remote track is added during negotiation. onRemoteStreamURL fires at
  // track-add (mid-"connecting"), before any video flows, so gating on the
  // URL alone flipped to a BLACK remote full-screen with the self-preview
  // stuck in the corner while still "Connecting…" (reported on bananaman's
  // side). Keep the local feed full-screen through dialing/ringing/connecting;
  // migrate to the bubble when connected.
  const remoteActive = !!remoteUrl && active.stage === 'connected';
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
          // Remount on the PiP transition so the Android SurfaceView
          // re-creates at the new (PiP vs full) window size instead of
          // keeping its pre-resize buffer (which left the feed filling only
          // part of the bubble — the reported "narrow corner"). Keyed on
          // `compact` (window-size derived) so it remounts even when the
          // native PiP event doesn't arrive. (The ~250ms placeholder on PiP
          // entry is Android's own surface-reestablish behavior, not this
          // remount — verified identical with a stable key.)
          key={`fs-${compact}`}
          streamURL={fullscreenUrl}
          style={styles.remoteView}
          objectFit="cover"
          // Render-proof instrumentation: RTCView fires onDimensionsChange
          // only once the native view actually paints a sized frame.
          //   - iOS: if this NEVER logs, the Metal renderer never attached
          //     (the didMoveToWindow/window-gate bug the webrtc patch targets);
          //     if it logs non-zero but the screen is black → a layout issue.
          //   - Android: the {w,h} is the REAL video frame size — feed it to
          //     the native PiP params so the floating window matches the video
          //     aspect (was hardcoded 9:16 vs a 16:9 capture → "narrow corner"
          //     crop). Only the fullscreen feed is what Android PiP shows.
          onDimensionsChange={(e) => {
            const { width: w, height: h } = e.nativeEvent;
            diag('call', 'video dimensions', {
              which: fullscreenUrl === localUrl ? 'local' : 'remote',
              slot: 'fullscreen',
              w,
              h,
            });
            if (w > 0 && h > 0) pip.setVideoAspect(w, h);
          }}
          // Layout probe: the RTCView's ACTUAL measured size. In an Android PiP
          // window this disambiguates the "narrow corner" — if it stays the
          // full-screen size while floating, RN isn't re-measuring to the PiP
          // window (the view is oversized + clipped); if it's small but still
          // clipped, it's the SurfaceView keeping its pre-resize buffer.
          onLayout={(e) =>
            diag('call', 'fullscreen view layout', {
              compact,
              w: Math.round(e.nativeEvent.layout.width),
              h: Math.round(e.nativeEvent.layout.height),
            })
          }
          // Mirror only when this view is showing the local self-preview.
          mirror={fullscreenUrl === localUrl}
          // PiP the remote feed when it's the full-screen one (default,
          // not swapped) so backgrounding floats the caller.
          iosPIP={fullscreenIsLocal ? undefined : VIDEO_PIP_OPTS}
        />
      ) : (
        <View style={[styles.remoteView, { backgroundColor: '#000' }]} />
      )}

      {/* Overlay chrome (top bar + controls) — hidden whenever we're in the
          small floating window: it only has room for the video itself, and
          keeping the top-bar @handle drawn inside the bubble was the reported
          "top bar shouldn't be there" defect. Gated on `compact` so it
          collapses on the window resize even if the native PiP event is
          dropped. */}
      {!compact ? (
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
              onDimensionsChange={(e) =>
                diag('call', 'video dimensions', {
                  which: pipUrl === localUrl ? 'local' : 'remote',
                  slot: 'bubble',
                  w: e.nativeEvent.width,
                  h: e.nativeEvent.height,
                })
              }
              // Mirror only when the bubble is showing the local self-preview.
              mirror={pipUrl === localUrl}
              // When swapped, the remote feed lives in the bubble — keep
              // PiP attached to the remote feed so backgrounding still
              // floats the caller (not the suspended local camera).
              iosPIP={swapped ? VIDEO_PIP_OPTS : undefined}
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
      ) : null}
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
