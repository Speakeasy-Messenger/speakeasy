import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../theme/index.js';
import { font, scrim, space } from '../theme/tokens.js';
import { useVerifySheet } from '../store/verify-sheet.js';
import type { VerificationReason } from '../auth/verify-device-types.js';

/**
 * Branded bottom-sheet replacement for the system Alert that used to
 * gate `vouchflow.verify()`. Same imperative contract — the
 * verify-sheet store's `request(reason)` returns a Promise that
 * resolves on Continue and rejects on Not-now / scrim / back.
 *
 * Visual rules: workspace canvas, slide-up sheet, brass primary.
 * Mirrors BurnConfirmSheet so the user sees the same confirmation
 * language across the app.
 */
export function VerifyDeviceSheet(): React.ReactElement {
  const themed = useColors();
  const pending = useVerifySheet((s) => s.pending);
  const confirm = useVerifySheet((s) => s.confirm);
  const cancel = useVerifySheet((s) => s.cancel);

  return (
    <Modal
      visible={!!pending}
      transparent
      animationType="slide"
      onRequestClose={cancel}
      statusBarTranslucent
    >
      <Pressable
        style={[styles.scrim, { backgroundColor: scrim.modal }]}
        onPress={cancel}
      />
      <View style={styles.wrap} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: themed.cream, borderTopColor: themed.divider },
          ]}
          testID="verify-device-sheet"
        >
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.title, { color: themed.ink }]}>
            Verify this device
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>
          <Text style={[styles.body, { color: themed.slate }]}>
            {pending ? lineForReason(pending.reason) : ''}
          </Text>
          <Text style={[styles.hint, { color: themed.slate }]}>
            Tap Continue to confirm with your passkey.
          </Text>

          <View style={styles.actions}>
            <Pressable
              onPress={cancel}
              style={[styles.btnSecondary, { borderColor: themed.divider }]}
              testID="verify-device-cancel"
            >
              <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                Not now
              </Text>
            </Pressable>
            <Pressable
              onPress={confirm}
              style={[styles.btnPrimary, { backgroundColor: themed.primary }]}
              testID="verify-device-continue"
            >
              <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                Continue
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function lineForReason(reason: VerificationReason): string {
  switch (reason) {
    case 'launch_refresh':
      return 'Refreshing this device’s session.';
    case 'websocket_auth_failed':
      return 'Your session was dropped. Refresh to reconnect.';
    case 'missing_token':
      return 'This install needs a verified session.';
    case 'send_message':
      return 'Needed before sending this message.';
    case 'group_action':
      return 'Needed before updating this room.';
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
  body: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: space.xs,
  },
  hint: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    marginBottom: space.xl,
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
