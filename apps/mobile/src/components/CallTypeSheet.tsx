import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../theme/index.js';
import { font, scrim, space } from '../theme/tokens.js';
import { useCallCapabilities } from '../store/call-capabilities.js';

/**
 * CALLS.md §01 — Call type picker (#13 unified entry).
 *
 * Two rows now: **Call** (audio, masked by default) and **Video**.
 *  - "Call" carries the speakeasy identity — the outline cipher-S mark,
 *    a brass period, and the observational microcopy "Voice masked. Your
 *    animal speaks for you." It does NOT get the old brass BORDER: that
 *    border existed to out-rank the retired voice/video siblings, and
 *    with no masked sibling left it's noise (design review DD1). Masking
 *    is caller-local, so the row always shows — there's nothing about the
 *    peer to gate on.
 *  - "Video" is plain, and is HIDDEN when we have FRESH capability data
 *    saying the peer refuses video (#13 "Refuse video calls"). When the
 *    cache is stale/absent we show it and let the server enforce
 *    (a video offer to a refusing peer is rejected with `video_refused`,
 *    and the caller sees a quiet "No video here." notice with a one-tap
 *    fall-back to a masked Call).
 */

interface Props {
  visible: boolean;
  /** Peer being called — capability is looked up against this id. */
  peerUserId: string;
  onClose: () => void;
  /** Masked audio call (the speakeasy default). */
  onPickCall: () => void;
  onPickVideo: () => void;
}

export function CallTypeSheet({
  visible,
  peerUserId,
  onClose,
  onPickCall,
  onPickVideo,
}: Props): React.ReactElement {
  const themed = useColors();
  // Edge-to-edge: pad the sheet's bottom past the gesture/3-button nav
  // bar so the Cancel row never sits behind it (matches AcquireSheet).
  const insets = useSafeAreaInsets();
  // Hide Video only when we have FRESH capability data that excludes it
  // (the peer refuses video). Stale/absent → show it; the server is the
  // authoritative gate.
  const peerSupportsVideo = useCallCapabilities((s) =>
    s.supports(peerUserId, 'video'),
  );
  const capsFresh = useCallCapabilities((s) => s.isFresh(peerUserId));
  const showVideo = !(capsFresh && !peerSupportsVideo);

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
            {
              backgroundColor: themed.cream,
              borderTopColor: themed.divider,
              paddingBottom: insets.bottom + space.xxl,
            },
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
            {/* Call — masked-by-default audio, the speakeasy identity.
                Cipher-S + brass period + observational microcopy, but NO
                brass border (DD1: nothing left to out-rank). Always shown;
                masking is caller-local. */}
            <Pressable
              onPress={() => {
                onClose();
                onPickCall();
              }}
              style={({ pressed }) => [
                styles.option,
                {
                  backgroundColor: pressed ? themed.soft : themed.pale,
                  borderColor: themed.divider,
                },
              ]}
              testID="call-type-call"
              accessibilityLabel="Call. Voice masked. Your animal speaks for you."
              accessibilityHint="Starts a call where your voice is masked before it reaches the other person."
            >
              <View
                style={[styles.optionIcon, { borderColor: themed.divider }]}
              >
                <CipherSIcon color={themed.primary} />
              </View>
              <View style={styles.optionText}>
                <Text style={[styles.optionName, { color: themed.ink }]}>
                  Call
                  <Text style={{ color: themed.primary }}>.</Text>
                </Text>
                <Text style={[styles.optionDesc, { color: themed.slate }]}>
                  Voice masked. Your animal speaks for you.
                </Text>
              </View>
            </Pressable>

            {showVideo && (
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
            )}
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
