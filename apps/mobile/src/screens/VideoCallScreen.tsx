import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  AppState,
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

// Auto-hide the call chrome (top status bar + bottom controls) after this
// long with no interaction, video-player style. A tap toggles it back.
const CHROME_IDLE_MS = 3000;
// Fade duration for the chrome show/hide transition.
const CHROME_FADE_MS = 200;

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
  // Measured size of the PiP/compact window. Tapping the floating bubble makes
  // Android grow the window; the SurfaceViewRenderer keeps its old buffer
  // (video stays small, black fills the rest) unless we recreate it. We key the
  // compact RTCView on this so it remounts — a fresh surface at the new size —
  // whenever the window's measured size changes.
  const [pipSize, setPipSize] = useState<{ w: number; h: number } | null>(null);
  // Authoritative PiP window size from native (dp), pushed on PiP enter + every
  // bubble resize. Preferred over `pipSize` (RN onLayout) for keying the
  // compact RTCView, because onLayout often reports a stale size in a PiP
  // window → the SurfaceView kept its old buffer → "video fills only a corner".
  const [nativePipSize, setNativePipSize] = useState<{ w: number; h: number } | null>(null);
  // Android system-PiP (the floating window after pressing Home). While in
  // it we hide the overlay chrome so only the video shows in the small frame.
  const [inPip, setInPip] = useState(false);
  // PiP window dimensions. RN reflows to the small window on PiP enter; we use
  // the live size to (a) diagnose the scaling report and (b) confirm inPip
  // actually propagated. The fullscreen RTCView is also keyed on inPip so its
  // SurfaceView re-creates at the new window size (Android SurfaceViews keep
  // their pre-resize buffer otherwise → the feed fills only part of the bubble).
  const { width: winW, height: winH } = useWindowDimensions();
  // Backgrounded → the video call is floating in a PiP bubble. Track it so we
  // can collapse to the bubble-only view IMMEDIATELY on background, without
  // waiting for the native PiP-mode event (which lands ~1–2 s later). Without
  // this, the full call UI — top bar and all — briefly renders inside the tiny
  // PiP window on entry, and the bubble shows a cropped corner of it (the
  // reported "top bar shows in the bubble").
  const [appBackgrounded, setAppBackgrounded] = useState(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppBackgrounded(s !== 'active'));
    return () => sub.remove();
  }, []);
  // The authoritative "collapse to just the video" signal. True when the native
  // PiP event told us so, OR the app is backgrounded (about to be / already in
  // PiP), OR the window has reflowed to the tiny floating size. Any path drives
  // BOTH the chrome-hide and the SurfaceView remount.
  const compact =
    inPip || appBackgrounded || Math.min(winW, winH) < PIP_COMPACT_MAX_SHORT_SIDE;
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
    const unsubClosed = pip.onPipClosed(() => {
      diag('call', 'pip closed → hangup');
      orchestrator.hangup();
    });
    // Diagnostic breadcrumb for the X-dismiss path (see MainActivity.onStop).
    const unsubLifecycle = pip.onPipLifecycle((info) => diag('call', 'pip lifecycle', { info }));
    // Authoritative bubble size from native (dp) — drives the compact
    // SurfaceView remount at the true size on enter + every resize.
    const unsubResize = pip.onPipResize((s) => {
      setNativePipSize((prev) =>
        prev && prev.w === s.width && prev.h === s.height ? prev : { w: s.width, h: s.height },
      );
      diag('call', 'pip native resize', { w: s.width, h: s.height });
    });
    return () => {
      pip.setVideoCallActive(false);
      unsub();
      unsubClosed();
      unsubResize();
      unsubLifecycle();
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

  // ── Chrome auto-hide state machine ───────────────────────────────────
  // The top status bar + bottom control bar behave like a video player's
  // chrome: they fade away so the call fills the screen, and a tap brings
  // them back. Two visible states — SHOWN / HIDDEN — driven by:
  //   • tap on the video backdrop:  SHOWN → HIDDEN, HIDDEN → SHOWN
  //   • 3s with no interaction while SHOWN → auto-hide
  //   • touching a control resets the 3s timer (so muting / flipping the
  //     camera doesn't make the bar vanish from under your finger)
  // ACTIVE only once the call is connected and we're NOT in the compact PiP
  // bubble: before connect chrome is forced on (you need "Calling…" + End),
  // and in the floating window the `compact` gate hides it entirely. `active`
  // is non-null past the early return below, but hooks must run every render,
  // so guard on it here.
  const autoHideActive =
    !!active && active.stage === 'connected' && !compact;
  const [chromeShown, setChromeShown] = useState(true);
  // Bumped on every control interaction to restart the idle countdown.
  const [activityNonce, setActivityNonce] = useState(0);
  const chromeOpacity = useRef(new Animated.Value(1)).current;

  // Reveal chrome whenever the auto-hide layout (re)activates — on connect,
  // and on expanding back out of the PiP bubble — then the idle timer below
  // fades it again.
  useEffect(() => {
    if (autoHideActive) setChromeShown(true);
  }, [autoHideActive]);

  // Idle auto-hide: while SHOWN + active, hide after CHROME_IDLE_MS with no
  // interaction. Re-arms on a show or an activity bump; no timer when hidden
  // or inactive (so it can't fire over the dialing/PiP UI).
  useEffect(() => {
    if (!autoHideActive || !chromeShown) return undefined;
    const t = setTimeout(() => setChromeShown(false), CHROME_IDLE_MS);
    return () => clearTimeout(t);
  }, [autoHideActive, chromeShown, activityNonce]);

  // Effective visibility: forced ON until connected, then the machine decides.
  const chromeVisible = autoHideActive ? chromeShown : true;

  // Fade the chrome whenever effective visibility flips.
  useEffect(() => {
    Animated.timing(chromeOpacity, {
      toValue: chromeVisible ? 1 : 0,
      duration: CHROME_FADE_MS,
      useNativeDriver: true,
    }).start();
  }, [chromeVisible, chromeOpacity]);

  // Tap on the video backdrop toggles chrome (no-op until the call is the
  // full active layout). Touching a control instead keeps chrome up and
  // restarts the countdown.
  const onBackdropTap = useCallback(() => {
    if (autoHideActive) setChromeShown((s) => !s);
  }, [autoHideActive]);
  const bumpActivity = useCallback(() => {
    if (autoHideActive) setActivityNonce((n) => n + 1);
  }, [autoHideActive]);

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

  // Android PiP / floating window: render ONLY the remote video, full-bleed,
  // and nothing else. This is the proven react-native-webrtc PiP recipe ("show
  // only the video") — the tiny window has no room for chrome, and the simpler
  // the view tree, the cleaner the SurfaceView fills the window. Switching into
  // this branch unmounts the full call UI and mounts a fresh single RTCView, so
  // the surface is (re)created at the PiP window size instead of resizing a
  // stale full-screen one. iOS never hits this branch — its PiP is the
  // iosPIP/AVPictureInPicture path on the full view; `compact` only flips on
  // Android's window-size reflow.
  if (compact) {
    const pipFeed = remoteUrl ?? localUrl;
    // Which feed is showing — part of the RTCView key below. Without this the
    // view is keyed only on window size, so the local→remote switch at answer
    // (same bubble size) never remounts it: react-native-webrtc's Android
    // SurfaceView keeps painting the OLD stream (your own face) until some
    // unrelated resize forces a remount. Device logs confirmed the feed went
    // local→remote with no view refresh until the bubble was tapped/resized.
    const pipFeedTag = pipFeed && pipFeed === remoteUrl ? 'r' : 'l';
    return (
      // onLayout on the ROOT measures the actual window size (ground truth,
      // unlike the often-stale Dimensions API in a PiP window). When the user
      // taps the bubble and Android grows it, this fires with the new size →
      // pipSize changes → the RTCView's key changes → its SurfaceView is
      // recreated at the new size instead of staying small.
      <View
        style={styles.root}
        onLayout={(e) => {
          const w = Math.round(e.nativeEvent.layout.width);
          const h = Math.round(e.nativeEvent.layout.height);
          setPipSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
          diag('call', 'pip view layout', { w, h });
        }}
      >
        {pipFeed ? (
          <RTCView
            // Remount only on the feed switch (local→remote at answer), NOT on
            // resize: the Android renderer is now a TextureViewRenderer (see the
            // react-native-webrtc patch), which scales its content to the view
            // bounds on every window resize without recreating the surface. So
            // the bubble fills correctly as it grows/shrinks with no remount —
            // that's the whole reason for the TextureView swap.
            key={`pip-${pipFeedTag}`}
            streamURL={pipFeed}
            style={StyleSheet.absoluteFill}
            objectFit="cover"
            mirror={pipFeed === localUrl}
            // Ground-truth video frame size — pairs with the 'pip native
            // resize'/'pip view layout' logs so one device test shows whether
            // a corner-crop is a window-size mismatch or the frame itself.
            onDimensionsChange={(e) =>
              diag('call', 'pip feed dimensions', {
                w: e.nativeEvent.width,
                h: e.nativeEvent.height,
                nativeW: nativePipSize?.w,
                nativeH: nativePipSize?.h,
              })
            }
          />
        ) : (
          <View style={[styles.remoteView, { backgroundColor: '#000' }]} />
        )}
      </View>
    );
  }

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
          // Passive render probe: RTCView fires onDimensionsChange only once
          // the native view actually paints a sized frame. iOS — if this never
          // logs, the Metal renderer never attached (the webrtc window-gate
          // patch); if it logs non-zero but the screen is black, it's a layout
          // issue. This only LOGS — it must not drive any native window state
          // (an earlier version fed these dims into the Android PiP aspect
          // ratio, which oscillated the bubble as the frame rotation flipped
          // the reported w/h portrait↔landscape).
          onDimensionsChange={(e) =>
            diag('call', 'video dimensions', {
              which: fullscreenUrl === localUrl ? 'local' : 'remote',
              slot: 'fullscreen',
              w: e.nativeEvent.width,
              h: e.nativeEvent.height,
            })
          }
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

      {/* Backdrop tap target — toggles the chrome. Sits ABOVE the video but
          BELOW the overlay so the control buttons still win their own taps,
          and a tap on the bare video (or where hidden controls were) falls
          through the box-none overlay to here. No-op until connected. */}
      {!compact ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onBackdropTap}
        />
      ) : null}

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
        {/* Top bar is display-only (no buttons), so it never captures
            touches — pointerEvents none lets taps over it reach the backdrop
            and toggle. Fades with the rest of the chrome. */}
        <Animated.View
          style={[styles.topBar, { opacity: chromeOpacity }]}
          pointerEvents="none"
        >
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
        </Animated.View>

        {/* Corner bubble — the non-full-screen feed. Tap to swap which
            feed is full-screen. Only shown once the peer's video is
            flowing (before that, the local feed owns the full screen). */}
        {pipUrl ? (
          <Pressable
            testID="video-call-pip"
            style={styles.pip}
            onPress={() => {
              bumpActivity();
              setSwapped((s) => !s);
            }}
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

        {/* Bottom controls. Mute / hang up / flip camera. Fades with the
            chrome; while hidden, pointerEvents none lets taps fall to the
            backdrop (which re-shows it). Any touch here restarts the idle
            countdown so adjusting controls doesn't hide the bar mid-tap. */}
        <Animated.View
          style={[styles.controls, { opacity: chromeOpacity }]}
          pointerEvents={chromeVisible ? 'auto' : 'none'}
          onTouchStart={bumpActivity}
        >
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
        </Animated.View>
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
