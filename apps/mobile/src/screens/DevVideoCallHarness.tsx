import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { mediaDevices, type MediaStream } from 'react-native-webrtc';
import InCallManager from 'react-native-incall-manager';
import { VideoCallScreen } from './VideoCallScreen.js';
import { useCalls } from '../store/calls.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import {
  showOngoingCallNotification,
  dismissOngoingCallNotification,
} from '../calls/call-notification.js';

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
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

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
      .then((s) => {
        const ms = s as MediaStream;
        if (cancelled) {
          ms.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = ms;
        setStream(ms);
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
    return () => {
      cancelled = true;
      useCalls.getState().setActive(undefined);
      void dismissOngoingCallNotification();
      streamRef.current?.getTracks().forEach((t) => t.stop());
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
  if (!stream) {
    return (
      <View style={styles.fill}>
        <Text style={styles.msg}>DEV harness — starting camera…</Text>
      </View>
    );
  }

  const url = stream.toURL();
  // Minimal stand-in for the CallOrchestrator surface VideoCallScreen uses.
  const mock = {
    getLocalStreamURL: () => url,
    onRemoteStreamURL: (cb: (u: string | undefined) => void) => {
      cb(url);
      return () => {};
    },
    hangup: () => onClosed(),
    setMicMuted: () => {},
    setSpeakerOn: () => {},
    flipCamera: async () => {},
  } as unknown as CallOrchestrator;

  return <VideoCallScreen orchestrator={mock} onClosed={onClosed} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  msg: { color: '#fff', fontSize: 16, padding: 24, textAlign: 'center' },
});
