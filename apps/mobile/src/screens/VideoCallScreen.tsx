import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { RTCView } from 'react-native-webrtc';
import { conversationIdForDirect, newMessageId } from '@speakeasy/shared';
import {
  MicIcon,
  PhoneEndIcon,
} from '../components/icons/CallIcons.js';
import { Handle } from '../components/Handle.js';
import { useCalls } from '../store/calls.js';
import { useConversations } from '../store/conversations.js';
import { useIdentity } from '../store/identity.js';
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
  const myUserId = useIdentity((s) => s.userId);

  const [localUrl, setLocalUrl] = useState<string | undefined>();
  const [remoteUrl, setRemoteUrl] = useState<string | undefined>();
  const [elapsed, setElapsed] = useState('');

  // CALLS.md §06 — drop a system message into the chat feed when the
  // call ends. Same shape as the audio CallScreen logic:
  //   - completed         → `video call · M:SS.`
  //   - missed incoming   → `@<peer> video-called. you missed it.`
  //   - cancelled outgoing → `you video-called. no answer.`
  const addMessage = useConversations((s) => s.add);
  const everConnectedRef = useRef(false);
  const wasIncomingRef = useRef(false);
  const wasCallerRef = useRef(false);
  const wroteEndMsgRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (active.stage === 'connected') everConnectedRef.current = true;
    if (active.stage === 'incoming_ringing') wasIncomingRef.current = true;
    if (active.isCaller) wasCallerRef.current = true;
    if (active.stage === 'ended' && !wroteEndMsgRef.current && myUserId) {
      wroteEndMsgRef.current = true;
      const cid = conversationIdForDirect(myUserId, active.peerUserId);
      let text: string | undefined;
      if (everConnectedRef.current && active.connectedAt) {
        const sec = Math.floor((Date.now() - active.connectedAt) / 1000);
        const mm = Math.floor(sec / 60);
        const ss = String(sec % 60).padStart(2, '0');
        text = `video call · ${mm}:${ss}.`;
      } else if (wasIncomingRef.current) {
        text = `@${active.peerUserId} video-called. you missed it.`;
      } else if (wasCallerRef.current) {
        text = `you video-called. no answer.`;
      }
      if (text) {
        addMessage(cid, {
          id: newMessageId(),
          from: 'system',
          text,
          kind: 'direct',
          sentAt: Date.now(),
          stage: 'sent',
        });
      }
    }
  }, [active, addMessage, myUserId]);

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

  // Auto-dismiss after the orchestrator clears `active`.
  useEffect(() => {
    if (!active) {
      const t = setTimeout(onClosed, 1200);
      return () => clearTimeout(t);
    }
  }, [active, onClosed]);

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
    connected: elapsed || '00:00',
    ended: 'Call ended',
  };

  return (
    <View style={styles.root}>
      {/* Remote stream — full-bleed black until media flows. */}
      {remoteUrl ? (
        <RTCView
          streamURL={remoteUrl}
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
          <Handle value={active.peerUserId} variant="display" />
          <Text style={styles.topStage}>{stageLabel[active.stage]}</Text>
        </View>

        {/* Local picture-in-picture — top-right. Mirrored on the front
            camera so the user sees a selfie-style preview. */}
        {localUrl ? (
          <RTCView
            streamURL={localUrl}
            style={styles.pip}
            objectFit="cover"
            mirror
            zOrder={1}
          />
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
    top: 80,
    right: space.md,
    width: 100,
    height: 140,
    backgroundColor: '#222',
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
