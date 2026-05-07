import React, { useEffect, useState } from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '../components/Avatar.js';
import {
  MicIcon,
  PhoneEndIcon,
  SpeakerIcon,
} from '../components/icons/CallIcons.js';
import { useCalls } from '../store/calls.js';
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { callPalette } from '../theme/tokens.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

interface Props {
  orchestrator: CallOrchestrator;
  onClosed: () => void;
}

/**
 * In-call screen — shows the peer, ringing/connected state, and the
 * three live controls (mute / speaker / hang up). Renders for both
 * outgoing and incoming connected calls. The IncomingCallScreen
 * renders before this one for `incoming_ringing`.
 */
export function CallScreen({ orchestrator, onClosed }: Props) {
  const active = useCalls((s) => s.active);
  const [elapsed, setElapsed] = useState('');

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
      <SafeAreaView style={styles.root} testID="call-screen-ended">
        <Text style={[text.heroBody, styles.endedLabel]}>Call ended</Text>
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
    <SafeAreaView style={styles.root} testID="call-screen">
      <View style={styles.peer}>
        <Avatar userId={active.peerUserId} size={120} />
        <Text style={[text.heroBody, styles.peerHandle]}>@{active.peerUserId}</Text>
        <Text style={[text.subtitle, styles.stageLabel]}>{stageLabel[active.stage]}</Text>
      </View>

      <View style={styles.controls}>
        <Pressable
          testID="call-mute"
          onPress={() => orchestrator.setMicMuted(!active.micMuted)}
          style={[styles.controlBtn, active.micMuted && styles.controlBtnActive]}
        >
          <MicIcon
            size={26}
            muted={active.micMuted}
            color={active.micMuted ? colors.cream : colors.ink}
          />
        </Pressable>
        <Pressable
          testID="call-end"
          onPress={() => orchestrator.hangup()}
          style={styles.endBtn}
        >
          <PhoneEndIcon size={32} color={colors.cream} />
        </Pressable>
        <Pressable
          testID="call-speaker"
          onPress={() => orchestrator.setSpeakerOn(!active.speakerOn)}
          style={[styles.controlBtn, active.speakerOn && styles.controlBtnActive]}
        >
          <SpeakerIcon
            size={26}
            active={active.speakerOn}
            color={active.speakerOn ? colors.cream : colors.ink}
          />
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.cream,
    justifyContent: 'space-between',
    paddingVertical: space.xl,
  },
  peer: {
    alignItems: 'center',
    gap: space.md,
    marginTop: '20%',
  },
  peerHandle: {
    color: colors.ink,
    fontFamily: fonts.inter500,
    fontSize: 22,
  },
  stageLabel: {
    color: colors.slate,
    fontFamily: fonts.inter400,
    fontSize: 14,
    letterSpacing: 0.4,
  },
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
    borderRadius: 32,
    backgroundColor: colors.pale,
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlBtnActive: {
    backgroundColor: colors.primary,
  },
  endBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: callPalette.decline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endedLabel: {
    color: colors.slate,
    textAlign: 'center',
    marginTop: '40%',
  },
});
