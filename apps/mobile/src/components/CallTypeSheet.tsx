import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useColors } from '../theme/index.js';
import { font, scrim, space } from '../theme/tokens.js';
import { useCallCapabilities } from '../store/call-capabilities.js';
import { isPrivateCallAvailable } from '../native/voice-filter.js';

/**
 * CALLS.md §01 — Call type picker.
 *
 * Phase 5j Private Call: third row "Private call" lands at position 1
 * (the speakeasy-native default) with a brass 1px border and a brass
 * period on the title. The row only renders when (the peer's capability
 * set includes 'private') AND (this device's native filter reports
 * isPrivateCallAvailable). On a peer who can't answer Private, the
 * row never appears — the brand promise is "the option only shows when
 * it actually works." Both halves are independent: a stale capability
 * cache or a missing native filter both fail closed.
 *
 * Locked design decisions from /plan-design-review (D2–D9): Private
 * first + brass border + brass period + outline cipher-S icon +
 * observational microcopy 'Voice masked. Your animal speaks for you.'
 */

interface Props {
  visible: boolean;
  /** Peer being called — capability is looked up against this id. */
  peerUserId: string;
  onClose: () => void;
  onPickVoice: () => void;
  onPickVideo: () => void;
  onPickPrivate: () => void;
}

export function CallTypeSheet({
  visible,
  peerUserId,
  onClose,
  onPickVoice,
  onPickVideo,
  onPickPrivate,
}: Props): React.ReactElement {
  const themed = useColors();
  const peerSupportsPrivate = useCallCapabilities((s) =>
    s.supports(peerUserId, 'private'),
  );
  // RC-4 ONLY: bypass the peer-supports check so the Private row
  // appears even when the callee is on a pre-rc.3 build that didn't
  // advertise `'private'` in its `supported_call_kinds`. Tightens
  // back to `peerSupportsPrivate && ...` for any production cut.
  // Real end-to-end testing still requires the peer on rc.3 because
  // the server-side fan-out filter (call-router.ts) also gates on
  // capability — a Private offer to a non-rc.3 peer routes to zero
  // devices and the caller rings out at the 45s timeout. This
  // bypass exists so the founder can visually verify the row +
  // local filter install path before scheduling peer upgrades.
  void peerSupportsPrivate; // intentionally unused under the bypass
  const showPrivate = isPrivateCallAvailable();

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        style={[styles.scrim, { backgroundColor: scrim.modal }]}
        onPress={onClose}
        testID="call-type-scrim"
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
          testID="call-type-sheet"
        >
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.title, { color: themed.ink }]}>
            Open the channel
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <Text style={[styles.sub, { color: themed.slate }]}>
            Audio is encrypted end-to-end and never recorded.
          </Text>

          <View style={styles.options}>
            {showPrivate && (
              <Pressable
                onPress={() => {
                  onClose();
                  onPickPrivate();
                }}
                style={({ pressed }) => [
                  styles.option,
                  {
                    backgroundColor: pressed ? themed.soft : themed.pale,
                    // Brass border (themed.primary) is the brass-tint
                    // mechanism locked in Pass 5 — uses existing color,
                    // no new opacity token.
                    borderColor: themed.primary,
                  },
                ]}
                testID="call-type-private"
                accessibilityLabel="Private call. Voice masked. Your animal speaks for you."
                accessibilityHint="Starts a private call where your voice is filtered before reaching the other person."
              >
                <View
                  style={[styles.optionIcon, { borderColor: themed.divider }]}
                >
                  <CipherSIcon color={themed.primary} />
                </View>
                <View style={styles.optionText}>
                  <Text style={[styles.optionName, { color: themed.ink }]}>
                    Private call
                    <Text style={{ color: themed.primary }}>.</Text>
                  </Text>
                  <Text style={[styles.optionDesc, { color: themed.slate }]}>
                    Voice masked. Your animal speaks for you.
                  </Text>
                </View>
              </Pressable>
            )}

            <Pressable
              onPress={() => {
                onClose();
                onPickVoice();
              }}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed ? themed.soft : themed.pale,
                  borderColor: themed.divider,
                },
              ]}
              testID="call-type-voice"
              accessibilityLabel="Voice call. Just voices."
            >
              <View
                style={[styles.optionIcon, { borderColor: themed.divider }]}
              >
                <PhoneOutlineIcon color={themed.primary} />
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.optionName, { color: themed.ink }]}>
                  Voice call
                </Text>
                <Text style={[styles.optionDesc, { color: themed.slate }]}>
                  Just voices. Animals stay small.
                </Text>
              </View>
            </Pressable>

            <Pressable
              onPress={() => {
                onClose();
                onPickVideo();
              }}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed ? themed.soft : themed.pale,
                  borderColor: themed.divider,
                },
              ]}
              testID="call-type-video"
              accessibilityLabel="Video call. Camera and voice."
            >
              <View
                style={[styles.optionIcon, { borderColor: themed.divider }]}
              >
                <SquareIcon color={themed.primary} />
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.optionName, { color: themed.ink }]}>
                  Video call
                </Text>
                <Text style={[styles.optionDesc, { color: themed.slate }]}>
                  Camera + voice. Front camera by default.
                </Text>
              </View>
            </Pressable>
          </View>

          <Pressable
            onPress={onClose}
            hitSlop={8}
            testID="call-type-cancel"
          >
            <Text style={[styles.cancel, { color: themed.slate }]}>
              Cancel
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function PhoneOutlineIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Path
        d="M5 4 L9 4 L11 9 L9 11 Q11 15 13 15 L15 13 L20 15 L20 19 Q15 20 10 16 Q5 11 5 5 Z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinejoin="miter"
        fill="none"
      />
    </Svg>
  );
}

function SquareIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Rect
        x={4}
        y={4}
        width={16}
        height={16}
        stroke={color}
        strokeWidth={1.6}
        fill="none"
      />
    </Svg>
  );
}

/**
 * Outline cipher-S — the speakeasy mark, drawn as a 1px stroked S
 * inside a circle. Sibling grammar with the outline phone and outline
 * square: same 20×20 SVG, same 1.6 stroke width. The brass row border
 * does the "this is the speakeasy-native one" signaling — the icon
 * itself stays a quiet sibling per Pass 4 (D10) locked decision.
 */
function CipherSIcon({ color }: { color: string }): React.JSX.Element {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.6} fill="none" />
      <Path
        // Hand-tuned S that fits comfortably inside the 9-radius circle.
        d="M15 8 Q13 7 11 7 Q8 7 8 9 Q8 11 11 11.5 Q14 12 14 14.5 Q14 17 11 17 Q9 17 7 16"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xxl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginBottom: space.lg,
  },
  title: {
    fontFamily: font.bold,
    fontSize: 18,
    letterSpacing: -0.02 * 18,
    marginBottom: space.s,
  },
  sub: {
    fontFamily: font.regular,
    fontSize: 12,
    marginBottom: space.xl,
  },
  options: {
    gap: space.s,
    marginBottom: space.base,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.base,
    paddingHorizontal: space.base,
    paddingVertical: space.base,
    borderWidth: 1,
  },
  optionDisabled: { opacity: 0.5 },
  optionIcon: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  optionText: { flex: 1 },
  optionName: {
    fontFamily: font.medium,
    fontSize: 15,
    letterSpacing: -0.005 * 15,
  },
  optionDesc: {
    fontFamily: font.regular,
    fontSize: 11,
    lineHeight: 16,
    marginTop: space.xs,
  },
  cancel: {
    fontFamily: font.regular,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: space.m,
  },
});
