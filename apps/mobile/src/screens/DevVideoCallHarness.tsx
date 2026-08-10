import React, { useEffect, useRef, useState } from 'react';
import { AppState, Platform, StyleSheet, Text, View } from 'react-native';
import {
  mediaDevices,
  RTCPeerConnection,
  type MediaStream,
} from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { VideoCallScreen } from './VideoCallScreen.js';
import { useCalls } from '../store/calls.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import {
  showOngoingCallNotification,
  dismissOngoingCallNotification,
} from '../calls/call-notification.js';
import { pip } from '../native/pip.js';

/**
 * __DEV__-only test harness for the video-call UI — NOT shipped.
 *
 * Renders the REAL VideoCallScreen fed by this device's own camera (the
 * Android emulator's fake camera works fine) plus a fake "connected" call
 * in the store and a mock orchestrator. That lets PiP behavior — the
 * background-bubble resize and the return-to-call transition — be tested
 * on a device WITHOUT standing up a real two-peer WebRTC call.
 *
 * The local camera stream is wired as BOTH the local and the "remote"
 * feed, so the full-screen remote view (what fills the PiP bubble once
 * connected) shows live video to resize. Gated behind __DEV__ + a flag in
 * App.tsx; flip that flag, reload, and the call screen comes up standalone.
 */
export function DevVideoCallHarness({ onClosed }: { onClosed: () => void }) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backgroundVideoResult, setBackgroundVideoResult] = useState('not-run');
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const senderRef = useRef<RTCPeerConnection | null>(null);
  const receiverRef = useRef<RTCPeerConnection | null>(null);
  const backgroundBaselineRef = useRef<{ bytes: number; frames: number } | null>(null);
  const latestStatsRef = useRef<{ bytes: number; frames: number } | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A real call activates the AVAudioSession (playAndRecord + videoChat mode)
    // via InCallManager / WebRTC. iOS only auto-starts Picture-in-Picture from
    // inline when an audio session is ACTIVE — the mock orchestrator never did
    // this, so the first device run never triggered PiP. Activate it here so the
    // harness faithfully exercises the iosPIP auto-start path. Request audio in
    // getUserMedia too (an audio track is part of a real call's session).
    try {
      InCallManager.start({ media: 'video', auto: true });
      InCallManager.setForceSpeakerphoneOn(true);
    } catch {
      /* non-native test env */
    }
    void mediaDevices
      .getUserMedia({ audio: true, video: { facingMode: 'user' } })
      .then(async (s) => {
        const ms = s as MediaStream;
        if (cancelled) {
          ms.getTracks().forEach((t) => t.stop());
          return;
        }
        localStreamRef.current = ms;
        setLocalStream(ms);

        // Encode/decode the camera through two real RTCPeerConnections instead
        // of painting the local stream twice. The displayed "remote" feed is
        // therefore proof that camera capture -> WebRTC sender -> receiver ->
        // renderer is alive. This is still an on-device loopback (no TURN), but
        // it exercises the exact media pipeline that used to freeze when the
        // calling app backgrounded.
        const sender = new RTCPeerConnection({ iceServers: [] });
        const receiver = new RTCPeerConnection({ iceServers: [] });
        senderRef.current = sender;
        receiverRef.current = receiver;
        ms.getTracks().forEach((track) => sender.addTrack(track, ms));

        const remotePromise = new Promise<MediaStream>((resolve) => {
          const handler = (event: any) => {
            const remote = event.streams?.[0] as MediaStream | undefined;
            if (remote) resolve(remote);
          };
          (receiver as any).addEventListener('track', handler);
        });

        const offer = await sender.createOffer();
        await sender.setLocalDescription(offer);
        await waitForIceGathering(sender);
        await receiver.setRemoteDescription(sender.localDescription!);
        const answer = await receiver.createAnswer();
        await receiver.setLocalDescription(answer);
        await waitForIceGathering(receiver);
        await sender.setRemoteDescription(receiver.localDescription!);

        const remote = await remotePromise;
        if (cancelled) return;
        remoteStreamRef.current = remote;
        setRemoteStream(remote);
        // Keep a fresh pre-background baseline. AppState's background callback
        // gets only a short execution window on iOS; starting getStats there can
        // be suspended before its promise resolves, so snapshot the last
        // completed native counters synchronously instead.
        statsTimerRef.current = setInterval(() => {
          void readInboundVideoStats(receiver).then((stats) => {
            latestStatsRef.current = stats;
          });
        }, 500);
        useCalls.getState().setActive({
          callId: 'dev-harness',
          peerUserId: 'dev-peer',
          isCaller: true,
          stage: 'connected',
          stageEnteredAt: Date.now(),
          connectedAt: Date.now(),
          micMuted: false,
          speakerOn: true,
          kind: 'video',
        });
        // Also show the ongoing-call pill so it can be screencapped (the
        // real lifecycle shows it on background; here we show it eagerly).
        void showOngoingCallNotification({
          peerHandle: 'dev-peer',
          connectedAtMs: Date.now(),
          micMuted: false,
          kind: 'audio',
        });
      })
      .catch((e) => setError(String(e?.message ?? e)));

    const beginBackgroundMeasurement = () => {
      const baseline = latestStatsRef.current;
      if (!baseline) return;
      backgroundBaselineRef.current = baseline;
      setBackgroundVideoResult('measuring');
    };
    const finishBackgroundMeasurement = () => {
      const receiver = receiverRef.current;
      if (!receiver) return;
      const baseline = backgroundBaselineRef.current;
      if (!baseline) return;
      // Read after native foreground restoration has settled. If RTP/video
      // continued while JS was suspended, these native counters jump forward.
      setTimeout(() => {
        void readInboundVideoStats(receiver).then((after) => {
          const passed = after.bytes > baseline.bytes && after.frames > baseline.frames;
          setBackgroundVideoResult(passed ? 'pass' : 'fail');
        });
      }, 1000);
    };
    const appStateSub = AppState.addEventListener('change', (state) => {
      // Android can keep React Native's AppState "active" while the Activity is
      // in system PiP. Its native PiP callback below is authoritative there.
      if (Platform.OS === 'android') return;
      if (state !== 'active') beginBackgroundMeasurement();
      else finishBackgroundMeasurement();
    });
    const removePipModeListener = pip.onPipModeChanged((inPip) => {
      if (inPip) beginBackgroundMeasurement();
      else finishBackgroundMeasurement();
    });
    return () => {
      cancelled = true;
      appStateSub.remove();
      removePipModeListener();
      if (statsTimerRef.current) clearInterval(statsTimerRef.current);
      useCalls.getState().setActive(undefined);
      void dismissOngoingCallNotification();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      remoteStreamRef.current?.getTracks().forEach((t) => t.stop());
      senderRef.current?.close();
      receiverRef.current?.close();
      try {
        InCallManager.stop();
      } catch {
        /* non-native test env */
      }
    };
  }, []);

  if (error) {
    return (
      <View style={styles.fill}>
        <Text style={styles.msg}>camera failed: {error}</Text>
      </View>
    );
  }
  if (!localStream || !remoteStream) {
    return (
      <View style={styles.fill}>
        <Text style={styles.msg}>DEV harness — starting camera…</Text>
      </View>
    );
  }

  const localUrl = localStream.toURL();
  const remoteUrl = remoteStream.toURL();
  // Minimal stand-in for the CallOrchestrator surface VideoCallScreen uses.
  const mock = {
    getLocalStreamURL: () => localUrl,
    onRemoteStreamURL: (cb: (u: string | undefined) => void) => {
      cb(remoteUrl);
      return () => {};
    },
    hangup: () => {
      useCalls.getState().setActive(undefined);
      onClosed();
    },
    setMicMuted: () => {},
    setSpeakerOn: () => {},
    flipCamera: async () => {},
  } as unknown as CallOrchestrator;

  return (
    <View style={styles.fill}>
      <VideoCallScreen orchestrator={mock} onClosed={onClosed} />
      <Text
        testID={`harness-background-video-${backgroundVideoResult}`}
        accessibilityLabel={`harness-background-video-${backgroundVideoResult}`}
        style={styles.probe}
      >
        {backgroundVideoResult}
      </Text>
    </View>
  );
}

async function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve) => {
    const handler = () => {
      if (pc.iceGatheringState !== 'complete') return;
      (pc as any).removeEventListener('icegatheringstatechange', handler);
      resolve();
    };
    (pc as any).addEventListener('icegatheringstatechange', handler);
    // Close the small race between the pre-listener check and subscription.
    handler();
  });
}

async function readInboundVideoStats(
  pc: RTCPeerConnection,
): Promise<{ bytes: number; frames: number }> {
  let bytes = 0;
  let frames = 0;
  const report = await pc.getStats();
  report.forEach((stat: any) => {
    if (
      stat.type !== 'inbound-rtp' ||
      (stat.kind ?? stat.mediaType) !== 'video'
    ) return;
    bytes += Number(stat.bytesReceived ?? 0);
    frames += Number(stat.framesDecoded ?? stat.framesReceived ?? 0);
  });
  return { bytes, frames };
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  msg: { color: '#fff', fontSize: 16, padding: 24, textAlign: 'center' },
  // Accessible to Maestro after returning from PiP, visually negligible in
  // screenshots so it cannot mask the pixels being evaluated.
  probe: { position: 'absolute', width: 1, height: 1, opacity: 0.01, top: 0, left: 0 },
});
