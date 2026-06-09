import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../theme/index.js';
import { font, scrim, space } from '../theme/tokens.js';

/**
 * BLOCK.md §4 + §8 — confirmation sheets for block / unblock.
 *
 * Both share the same bottom-sheet layout: drag handle, display
 * title with brass `@` + brass period, body of caption-style
 * paragraphs in `text-mute`, two stacked buttons. The block sheet
 * has three paragraphs (the middle one is the "they won't know"
 * privacy-property documentation), the unblock sheet has two.
 */

interface BaseProps {
  visible: boolean;
  handle: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function BlockConfirmSheet({
  visible,
  handle,
  onClose,
  onConfirm,
}: BaseProps): React.ReactElement {
  const themed = useColors();
  // Edge-to-edge: clear the nav bar so the action buttons aren't behind it.
  const insets = useSafeAreaInsets();
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
          testID="block-confirm-sheet"
        >
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.title, { color: themed.ink }]}>
            Block <Text style={{ color: themed.primary }}>@</Text>
            {handle}
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <View style={styles.body}>
            <Text style={[styles.para, { color: themed.slate }]}>
              You won't see their messages. They won't be able to find you,
              message you, or call you.
            </Text>
            <Text style={[styles.para, { color: themed.slate }]}>
              <Text style={{ color: themed.ink, fontFamily: font.medium }}>
                They won't know you blocked them.
              </Text>{' '}
              Their messages will look sent on their end. Your handle will
              appear gone to them — same as anyone they don't know.
            </Text>
            <Text style={[styles.para, { color: themed.slate }]}>
              Messages already in this conversation stay where they are until
              they expire. You can unblock anytime in Settings.
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              style={[styles.btnSecondary, { borderColor: themed.divider }]}
              testID="block-cancel"
            >
              <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                Cancel
              </Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[styles.btnPrimary, { backgroundColor: themed.primary }]}
              testID="block-confirm"
            >
              <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                Block
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

export function UnblockConfirmSheet({
  visible,
  handle,
  onClose,
  onConfirm,
}: BaseProps): React.ReactElement {
  const themed = useColors();
  // Edge-to-edge: clear the nav bar so the action buttons aren't behind it.
  const insets = useSafeAreaInsets();
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
          testID="unblock-confirm-sheet"
        >
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.title, { color: themed.ink }]}>
            Unblock <Text style={{ color: themed.primary }}>@</Text>
            {handle}
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <View style={styles.body}>
            <Text style={[styles.para, { color: themed.slate }]}>
              They'll be able to find you, message you, and call you again.
            </Text>
            <Text style={[styles.para, { color: themed.slate }]}>
              They won't get a notification about the unblock — same way they
              didn't get one when you blocked them.
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              style={[styles.btnSecondary, { borderColor: themed.divider }]}
              testID="unblock-stay"
            >
              <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                Stay blocked
              </Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[styles.btnPrimary, { backgroundColor: themed.primary }]}
              testID="unblock-confirm"
            >
              <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                Unblock
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { ...StyleSheet.absoluteFillObject },
  wrap: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    paddingHorizontal: space.xl,
    paddingTop: space.base,
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
    fontSize: 20,
    letterSpacing: -0.02 * 20,
    marginBottom: space.m,
  },
  body: { marginBottom: space.xl, gap: space.m },
  para: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 20,
  },
  actions: { gap: space.s },
  btnPrimary: {
    paddingVertical: space.base,
    alignItems: 'center',
  },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
  btnSecondary: {
    paddingVertical: space.base,
    alignItems: 'center',
    borderWidth: 1,
  },
  btnSecondaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    letterSpacing: 0.5,
  },
});
