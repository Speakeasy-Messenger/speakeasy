import React from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '../components/Avatar.js';
import { PhoneEndIcon, PhoneIcon } from '../components/icons/CallIcons.js';
import { useCalls } from '../store/calls.js';
import { colors, fonts, space, text } from '../theme/index.js';
import { callPalette } from '../theme/tokens.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

interface Props {
  orchestrator: CallOrchestrator;
  /** Called once the user has either accepted or declined. */
  onResolved: () => void;
}

/**
 * Full-screen incoming-call overlay. Mounted by App.tsx when the
 * orchestrator's active state is `incoming_ringing`. Two big buttons:
 * accept (green, bottom-right) and decline (red, bottom-left).
 */
export function IncomingCallScreen({ orchestrator, onResolved }: Props) {
  const active = useCalls((s) => s.active);

  if (!active || active.stage !== 'incoming_ringing') {
    return null;
  }

  return (
    <SafeAreaView style={styles.root} testID="incoming-call-screen">
      <View style={styles.peer}>
        <Avatar userId={active.peerUserId} size={120} />
        <Text style={[text.subtitle, styles.label]}>SPEAKEASY CALL</Text>
        <Text style={[text.heroBody, styles.peerHandle]}>@{active.peerUserId}</Text>
        <Text style={[text.subtitle, styles.subLabel]}>is calling…</Text>
      </View>
      <View style={styles.controls}>
        <Pressable
          testID="incoming-decline"
          onPress={() => {
            orchestrator.decline();
            onResolved();
          }}
          style={styles.declineBtn}
        >
          <PhoneEndIcon size={32} color={colors.cream} />
        </Pressable>
        <Pressable
          testID="incoming-accept"
          onPress={() => {
            void orchestrator.accept();
            onResolved();
          }}
          style={styles.acceptBtn}
        >
          <PhoneIcon size={32} color={colors.cream} />
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
    gap: space.sm,
    marginTop: '20%',
  },
  label: {
    color: colors.primary,
    fontFamily: fonts.inter500,
    fontSize: 11,
    letterSpacing: 2,
  },
  peerHandle: {
    color: colors.ink,
    fontFamily: fonts.inter500,
    fontSize: 26,
  },
  subLabel: {
    color: colors.slate,
    fontFamily: fonts.inter400,
    fontSize: 14,
  },
  controls: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: space.xl,
    paddingBottom: space.xl,
  },
  declineBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: callPalette.decline,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptBtn: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: callPalette.accept,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
