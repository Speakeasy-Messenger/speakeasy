import React from 'react';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Handle } from '../components/Handle.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { AvatarRenderer } from '../avatars/AvatarRenderer.js';
import { useCalls } from '../store/calls.js';
import { useProfiles } from '../store/profiles.js';
import { brand, font, type as typeScale } from '../theme/tokens.js';
import { space } from '../theme/index.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

interface Props {
  orchestrator: CallOrchestrator;
  /** Called once the user has either accepted or declined. */
  onResolved: () => void;
}

/**
 * CALLS.md §03 — Incoming call.
 *
 * Brand canvas (only call surface that uses it). Big 140×140
 * portrait of the caller's animal in a brand-surface tile, large
 * display handle in bone, "wants to speak" sub-line, two equal-
 * width buttons stacked or side-by-side: Decline (transparent +
 * faint border) and Accept (brass). No green/red — brass is the
 * action color, the brand never introduces a third color for an
 * ambulance/stoplight UI convention.
 */
export function IncomingCallScreen({ orchestrator, onResolved }: Props) {
  const active = useCalls((s) => s.active);
  const peerProfile = useProfiles((s) =>
    active ? s.byUserId[active.peerUserId] : undefined,
  );

  if (!active || active.stage !== 'incoming_ringing') {
    return null;
  }

  const animalId =
    peerProfile?.selectedAvatarId ?? defaultAnimalForUser(active.peerUserId);
  const isVideo = active.kind === 'video';

  return (
    <SafeAreaView style={styles.root} testID="incoming-call-screen">
      <View style={styles.body}>
        <Text style={styles.eyebrow}>
          {isVideo ? 'VIDEO CALL · INCOMING' : 'VOICE CALL · INCOMING'}
        </Text>
        <View style={styles.portraitTile}>
          <AvatarRenderer animalId={animalId} size={Math.round(140 * 0.78)} />
        </View>
        <View style={styles.handleRow}>
          <Handle value={active.peerUserId} variant="display" color={BONE} />
        </View>
        <Text style={styles.sub}>
          {isVideo ? 'wants to video-call' : 'wants to speak'}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          testID="incoming-decline"
          onPress={() => {
            orchestrator.decline();
            onResolved();
          }}
          style={styles.btnDecline}
        >
          <Text style={styles.btnDeclineText}>Decline</Text>
        </Pressable>
        <Pressable
          testID="incoming-accept"
          onPress={() => {
            void orchestrator.accept();
            onResolved();
          }}
          style={styles.btnAccept}
        >
          <Text style={styles.btnAcceptText}>Accept</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const BRASS = '#E5A645';
const BONE = '#F2E9D8';
const INK = '#14091A';
const BRAND_SURFACE = '#1F1126';
const TEXT_MUTE = 'rgba(242,233,216,0.55)';
const TEXT_FAINT = 'rgba(242,233,216,0.18)';

const styles = StyleSheet.create({
  // Brand canvas — never themed. Incoming is a brand moment.
  root: { flex: 1, backgroundColor: brand.canvas },
  body: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: space.lg,
  },
  eyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 11,
    letterSpacing: 0.22 * 11,
    textTransform: 'uppercase',
    color: BRASS,
    marginBottom: 18,
    fontWeight: '600',
  },
  // 140×140 brand-surface tile, sharp corners, faint bone border.
  portraitTile: {
    width: 140,
    height: 140,
    backgroundColor: BRAND_SURFACE,
    borderWidth: 1,
    borderColor: TEXT_FAINT,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  handleRow: { marginBottom: 8 },
  sub: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 0.22 * 11,
    textTransform: 'uppercase',
    color: TEXT_MUTE,
  },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: space.md,
    paddingBottom: space.md,
    gap: 8,
  },
  // Decline: transparent + faint bone border. Accept: brass.
  btnDecline: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: TEXT_FAINT,
  },
  btnDeclineText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: BONE,
    letterSpacing: 0.5,
  },
  btnAccept: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
    backgroundColor: BRASS,
  },
  btnAcceptText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: INK,
    letterSpacing: 0.5,
  },
});
