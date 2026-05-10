import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useColors } from '../theme/index.js';
import { font, scrim } from '../theme/tokens.js';

/**
 * CALLS.md §01 — Call type picker.
 *
 * Bottom sheet from a tap on the chat AppBar's ☎ icon. Two options:
 * Voice (lands today) and Video (deferred per Phase 5b scope —
 * disabled with a "Coming soon" caption rather than hidden, so the
 * flow matches the spec layout). Trust line at top: "Audio is
 * encrypted end-to-end and never recorded."
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  onPickVoice: () => void;
  onPickVideo: () => void;
}

export function CallTypeSheet({
  visible,
  onClose,
  onPickVoice,
  onPickVideo,
}: Props): React.ReactElement {
  const themed = useColors();
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

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grab: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    marginBottom: 18,
  },
  title: {
    fontFamily: font.bold,
    fontSize: 18,
    letterSpacing: -0.02 * 18,
    marginBottom: 6,
  },
  sub: {
    fontFamily: font.regular,
    fontSize: 12,
    marginBottom: 22,
  },
  options: {
    gap: 6,
    marginBottom: 16,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 14,
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
    marginTop: 2,
  },
  cancel: {
    fontFamily: font.regular,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 12,
  },
});
