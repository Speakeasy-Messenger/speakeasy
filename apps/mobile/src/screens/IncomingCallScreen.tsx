import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Handle } from '../components/Handle.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { AvatarRenderer } from '../avatars/AvatarRenderer.js';
import { useCalls } from '../store/calls.js';
import { useProfiles } from '../store/profiles.js';
import { refreshProfile } from '../store/refresh-profile.js';
import { font, space, type as typeScale } from '../theme/tokens.js';
import { useColors } from '../theme/index.js';
import type { CallOrchestrator } from '../calls/orchestrator.js';
import {
  permissionErrorKind,
  showOpenSettingsAlert,
} from '../permissions/runtime.js';

interface Props {
  orchestrator: CallOrchestrator;
  /** Called once the user has either accepted or declined. */
  onResolved: () => void;
  /**
   * Set when arriving from a tapped call push whose offer hasn't landed
   * over the (cold-reconnecting) WS yet. We render a "Connecting…"
   * placeholder for this peer instead of nothing; once the offer lands
   * and `active` populates, the normal incoming-call UI takes over.
   */
  connectingPeerId?: string;
  /** Dismiss the connecting placeholder (user cancelled, or it timed
   *  out because the offer never arrived). */
  onCancelConnecting?: () => void;
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
export function IncomingCallScreen({
  orchestrator,
  onResolved,
  connectingPeerId,
  onCancelConnecting,
}: Props) {
  const themed = useColors();
  const active = useCalls((s) => s.active);
  // Guard against a double-tap (or tapping both buttons) racing two
  // accept/decline calls before the screen dismisses.
  const [resolving, setResolving] = useState(false);
  const ringing = active?.stage === 'incoming_ringing' ? active : undefined;
  // Peer is the live caller when ringing, else the pending push peer.
  const peerId = ringing?.peerUserId ?? connectingPeerId;
  const peerProfile = useProfiles((s) =>
    peerId ? s.byUserId[peerId] : undefined,
  );

  // Connecting placeholder shows only while we have a pending peer and
  // no live ringing call yet. Auto-dismiss if the offer never arrives
  // (stale push / call already ended) so the user can't get stuck.
  const showConnecting = !ringing && !!connectingPeerId;
  useEffect(() => {
    if (!showConnecting) return undefined;
    // 8s, down from 15s: if the offer hasn't drained over the WS by now the
    // caller has almost certainly hung up (a pre-offer cancel is dropped by
    // the orchestrator's no-active-call guard, so it can't dismiss this
    // placeholder for us). Shorter = less time stuck "connecting…" on an
    // abandoned call. The orchestrator separately drops any offer that does
    // drain late for a cancelled callId, so this won't cut off a real call.
    const t = setTimeout(() => onCancelConnecting?.(), 8000);
    return () => clearTimeout(t);
  }, [showConnecting, onCancelConnecting]);

  // Force-refresh the caller's avatar so a recently-changed one shows
  // (the cache TTL would otherwise leave it stale).
  useEffect(() => {
    if (peerId) void refreshProfile(peerId, true);
  }, [peerId]);

  if (!peerId) {
    return null;
  }
  const animalId =
    peerProfile?.selectedAvatarId ?? defaultAnimalForUser(peerId);

  if (showConnecting) {
    return (
      <SafeAreaView
        style={[styles.root, { backgroundColor: themed.cream }]}
        testID="incoming-call-connecting"
      >
        <View style={styles.body}>
          <Text style={[styles.eyebrow, { color: themed.primary }]}>
            PRIVATE CALL · CONNECTING
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
            <Handle value={peerId} variant="display" color={themed.ink} />
          </View>
          <Text style={[styles.sub, { color: themed.slate }]}>connecting…</Text>
        </View>
        <View style={styles.actions}>
          <Pressable
            testID="incoming-connecting-cancel"
            onPress={() => onCancelConnecting?.()}
            style={[styles.btnDecline, { borderColor: themed.divider }]}
          >
            <Text style={[styles.btnDeclineText, { color: themed.ink }]}>Cancel</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!ringing) {
    return null;
  }

  // Per-kind eyebrow + sub-line. Private extends the existing grammar
  // ('VOICE CALL · INCOMING' → 'PRIVATE CALL · INCOMING') rather than
  // inventing a new visual treatment — locked in /plan-design-review
  // D3 (animal stays, eyebrow does the brand work). The animal IS the
  // identity layer in Speakeasy; swapping it for a brass mask icon
  // would read as an anonymous spam ring (rejected option B in D3).
  let eyebrow: string;
  let subLine: string;
  switch (ringing.kind) {
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
          <Handle value={ringing.peerUserId} variant="display" color={themed.ink} />
        </View>
        <Text style={[styles.sub, { color: themed.slate }]} testID="incoming-sub">
          {subLine}
        </Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          testID="incoming-decline"
          disabled={resolving}
          onPress={() => {
            if (resolving) return;
            setResolving(true);
            orchestrator.decline();
            onResolved();
          }}
          style={[
            styles.btnDecline,
            { borderColor: themed.divider },
            resolving && styles.btnResolving,
          ]}
        >
          <Text style={[styles.btnDeclineText, { color: themed.ink }]}>Decline</Text>
        </Pressable>
        <Pressable
          testID="incoming-accept"
          disabled={resolving}
          onPress={() => {
            if (resolving) return;
            setResolving(true);
            // Don't fire-and-forget: if mic permission is denied, accept()
            // rejects and the call ends — without this .catch the rejection
            // is swallowed and the call silently vanishes with no reason.
            // Surface the settings alert on a plain 'denied'
            // (never_ask_again is already alerted inside ensure()).
            orchestrator.accept().catch((err: unknown) => {
              const perr = permissionErrorKind(err);
              if (perr && perr.result === 'denied') {
                showOpenSettingsAlert(perr.kind);
              }
            });
            onResolved();
          }}
          style={[
            styles.btnAccept,
            { backgroundColor: themed.primary },
            resolving && styles.btnResolving,
          ]}
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
  btnResolving: { opacity: 0.5 },
});
