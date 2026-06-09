import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TtlOption } from '@speakeasy/shared';
import { useColors } from '../theme/index.js';
import { font, scrim, space } from '../theme/tokens.js';

/**
 * BURN.md §4 — whole-conversation Burn confirmation.
 *
 * Bottom sheet, half-height, workspace canvas. Three honest
 * paragraphs (immediacy, symmetry/visibility, irreversibility).
 * Two stacked buttons: "Keep it" (secondary, status-quo phrasing)
 * and "Burn" (brass primary, never red).
 *
 * Copy adapts the first paragraph's TTL reference to the
 * conversation's actual TTL ("Now, not in 7 days." / "Now, not in
 * 24 hours.") so it draws the right contrast.
 *
 * Per §11.4, an empty draft conversation gets a different first
 * paragraph: nothing has been delivered, so "dissolves on both
 * devices" would be a lie. The variant kicks in via the `isDraft`
 * prop.
 */

interface Props {
  visible: boolean;
  ttl: TtlOption;
  /** True for conversations with no messages yet — adapts the
   * first-paragraph copy per §11.4. */
  isDraft?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

export function BurnConfirmSheet({
  visible,
  ttl,
  isDraft,
  onClose,
  onConfirm,
}: Props): React.ReactElement {
  const themed = useColors();
  // Edge-to-edge: clear the nav bar so the buttons aren't behind it.
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
          testID="burn-confirm-sheet"
        >
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.title, { color: themed.ink }]}>
            Burn this conversation
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>

          {isDraft ? (
            <View style={styles.body}>
              <Text style={[styles.para, { color: themed.slate }]}>
                This draft conversation will close. They'll never see it.
              </Text>
              <Text style={[styles.para, { color: themed.slate }]}>
                This can't be undone.
              </Text>
            </View>
          ) : (
            <View style={styles.body}>
              <Text style={[styles.para, { color: themed.slate }]}>
                Every message dissolves on both your devices. Now, not in{' '}
                {ttlAdverbial(ttl)}.
              </Text>
              <Text style={[styles.para, { color: themed.slate }]}>
                <Text style={{ color: themed.ink, fontFamily: font.medium }}>
                  They'll see it dissolve too.
                </Text>{' '}
                A short note will appear in their copy:{' '}
                <Text style={styles.italic}>the conversation was burned.</Text>
              </Text>
              <Text style={[styles.para, { color: themed.slate }]}>
                This can't be undone.
              </Text>
            </View>
          )}

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              style={[styles.btnSecondary, { borderColor: themed.divider }]}
              testID="burn-keep-it"
            >
              <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                Keep it
              </Text>
            </Pressable>
            <Pressable
              onPress={onConfirm}
              style={[styles.btnPrimary, { backgroundColor: themed.primary }]}
              testID="burn-confirm"
            >
              <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                Burn
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Spec §4.2: phrase the TTL contrast naturally — "7 days", "24
 * hours", etc. Adapts to whatever the conversation's current TTL is. */
function ttlAdverbial(ttl: TtlOption): string {
  switch (ttl) {
    case 'hour':
      return '1 hour';
    case 'day':
      return '24 hours';
    case 'week':
      return '7 days';
    case 'month':
      return '30 days';
    case 'off':
      return 'whenever';
  }
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
  italic: { fontStyle: 'italic' },
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
