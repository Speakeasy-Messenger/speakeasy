import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Handle } from '../components/Handle.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { AvatarRenderer } from '../avatars/AvatarRenderer.js';
import { useCalls } from '../store/calls.js';
import { useProfiles } from '../store/profiles.js';
import { font, space, type as typeScale } from '../theme/tokens.js';
import { useColors } from '../theme/index.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';

interface Props {
  orchestrator: CallOrchestrator;
  /** Called once the user has either accepted or declined. */
  onResolved: () => void;
}

// Brass-button text is always dark — on the brass fill, the cream
// foreground is illegible regardless of mode. Kept as a hex literal
// rather than threading themed.ink because in dark mode themed.ink is
// cream, which would invert the contrast.
const BRASS_BTN_INK = '#14091A';

/**
 * CALLS.md §03 — Incoming call.
 *
 * Big 140×140 portrait of the caller's animal in a surface-tinted
 * tile, large display handle, "wants to speak" sub-line, two equal-
 * width buttons: Decline (transparent + faint border) and Accept
 * (brass). No green/red — brass is the action color, the brand never
 * introduces a third color for an ambulance/stoplight UI convention.
 *
 * Themed (rc.54+): originally hardcoded to `brand.canvas` as a
 * "brand moment", but the user's theme preference wins on their own
 * device. Brass accent + decline outline still come from the brand
 * palette via `useColors().primary` so the action surfaces stay
 * consistent across modes.
 */
export function IncomingCallScreen({ orchestrator, onResolved }: Props) {
  const themed = useColors();
  const active = useCalls((s) => s.active);
  const peerProfile = useProfiles((s) =>
    active ? s.byUserId[active.peerUserId] : undefined,
  );

  if (!active || active.stage !== 'incoming_ringing') {
    return null;
  }

  const animalId =
    peerProfile?.selectedAvatarId ?? defaultAnimalForUser(active.peerUserId);

  // Per-kind eyebrow + sub-line. Private extends the existing grammar
  // ('VOICE CALL · INCOMING' → 'PRIVATE CALL · INCOMING') rather than
  // inventing a new visual treatment — locked in /plan-design-review
  // D3 (animal stays, eyebrow does the brand work). The animal IS the
  // identity layer in Speakeasy; swapping it for a brass mask icon
  // would read as an anonymous spam ring (rejected option B in D3).
  let eyebrow: string;
  let subLine: string;
  switch (active.kind) {
    case 'video':
      eyebrow = 'VIDEO CALL · INCOMING';
      subLine = 'wants to video-call';
      break;
    case 'private':
      eyebrow = 'PRIVATE CALL · INCOMING';
      subLine = 'wants to speak privately';
      break;
    default:
      eyebrow = 'VOICE CALL · INCOMING';
      subLine = 'wants to speak';
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: themed.cream }]}
      testID="incoming-call-screen"
    >
      <View style={styles.body}>
        <Text
          style={[styles.eyebrow, { color: themed.primary }]}
          testID="incoming-eyebrow"
        >
          {eyebrow}
        </Text>
        <View
          style={[
            styles.portraitTile,
            { backgroundColor: themed.pale, borderColor: themed.divider },
          ]}
        >
          <AvatarRenderer animalId={animalId} size={Math.round(140 * 0.78)} />
        </View>
        <View style={styles.handleRow}>
          <Handle value={active.peerUserId} variant="display" color={themed.ink} />
        </View>
        <Text style={[styles.sub, { color: themed.slate }]} testID="incoming-sub">
          {subLine}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          testID="incoming-decline"
          onPress={() => {
            orchestrator.decline();
            onResolved();
          }}
          style={[styles.btnDecline, { borderColor: themed.divider }]}
        >
          <Text style={[styles.btnDeclineText, { color: themed.ink }]}>Decline</Text>
        </Pressable>
        <Pressable
          testID="incoming-accept"
          onPress={() => {
            void orchestrator.accept();
            onResolved();
          }}
          style={[styles.btnAccept, { backgroundColor: themed.primary }]}
        >
          <Text style={[styles.btnAcceptText, { color: BRASS_BTN_INK }]}>Accept</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: {
    flex: 1,
    alignItems: 'center',
    paddingTop: space.mega,
    paddingHorizontal: space.xl,
  },
  eyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 11,
    letterSpacing: 0.22 * 11,
    textTransform: 'uppercase',
    marginBottom: space.lg,
    fontWeight: '600',
  },
  portraitTile: {
    width: 140,
    height: 140,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xl,
  },
  handleRow: { marginBottom: space.s },
  sub: {
    fontFamily: font.medium,
    fontSize: 11,
    letterSpacing: 0.22 * 11,
    textTransform: 'uppercase',
  },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: space.base,
    paddingBottom: space.base,
    gap: space.s,
  },
  btnDecline: {
    flex: 1,
    paddingVertical: space.base,
    alignItems: 'center',
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  btnDeclineText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  btnAccept: {
    flex: 1,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnAcceptText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
