import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '../theme/index.js';
import { font, scrim, space } from '../theme/tokens.js';
import { useVerifySheet } from '../store/verify-sheet.js';
import type { VerificationReason } from '../auth/verify-device-types.js';
import { completeEmailFallbackVerification } from '../auth/claim-handle.js';
import { vouchflow } from '../services.js';
import { EmailVerifyFallback } from './EmailVerifyFallback.js';

/**
 * Branded bottom-sheet replacement for the system Alert that used to
 * gate `vouchflow.verify()`. Same imperative contract — the
 * verify-sheet store's `request(reason)` returns a Promise that
 * resolves on Continue and rejects on Not-now / scrim / back.
 *
 * `verify-device.ts` drives the actual passkey attempt; when it fails,
 * it calls `requestFallback(reason)` and the store's `fallback` field
 * flips this sheet — without ever closing (`pending` stays set) — into
 * the same email-send + code-entry flow onboarding uses, so the
 * monthly re-verify can complete without a passkey.
 *
 * Visual rules: workspace canvas, slide-up sheet, brass primary.
 * Mirrors BurnConfirmSheet so the user sees the same confirmation
 * language across the app.
 */
export function VerifyDeviceSheet(): React.ReactElement {
  const themed = useColors();
  // Edge-to-edge: clear the nav bar so the buttons aren't behind it.
  const insets = useSafeAreaInsets();
  const pending = useVerifySheet((s) => s.pending);
  const fallback = useVerifySheet((s) => s.fallback);
  const nonce = useVerifySheet((s) => s.nonce);
  const confirm = useVerifySheet((s) => s.confirm);
  const cancel = useVerifySheet((s) => s.cancel);
  const resolveFallback = useVerifySheet((s) => s.resolveFallback);

  // Local — purely "has Continue been tapped for this prompt yet",
  // which the store doesn't track (see verify-device.ts: `pending`
  // stays set from Continue all the way through success/fallback so
  // the sheet never flickers closed). Resets whenever a new prompt
  // (or a re-prompt of the same reason) opens.
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    setConfirmed(false);
  }, [nonce]);

  function onContinue() {
    setConfirmed(true);
    confirm();
  }

  async function handleEmailVerified(args: { sessionId: string; otp: string }): Promise<void> {
    const { deviceToken } = await completeEmailFallbackVerification(
      { vouchflow },
      { sessionId: args.sessionId, otp: args.otp, context: 'login' },
    );
    resolveFallback(deviceToken);
  }

  const verifying = confirmed && !fallback;

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
            {
              backgroundColor: themed.cream,
              borderTopColor: themed.divider,
              paddingBottom: insets.bottom + space.xxl,
            },
          ]}
          testID="verify-device-sheet"
        >
          <View style={[styles.grab, { backgroundColor: themed.divider }]} />
          <Text style={[styles.title, { color: themed.ink }]}>
            Verify this device
            <Text style={{ color: themed.primary }}>.</Text>
          </Text>

          {fallback ? (
            <>
              <Text style={[styles.body, { color: themed.slate }]}>
                Couldn’t verify with a passkey.
              </Text>
              <View style={styles.fallbackBlock}>
                <EmailVerifyFallback
                  reason={fallback.reason}
                  vouchflow={vouchflow}
                  onSubmit={handleEmailVerified}
                  colors={{ text: themed.ink, muted: themed.slate, faint: themed.divider }}
                  testIDPrefix="verify-device-fallback"
                  renderButton={(btn) => (
                    <Pressable
                      onPress={btn.onPress}
                      disabled={btn.disabled}
                      style={[
                        styles.btnPrimary,
                        { backgroundColor: themed.primary },
                        btn.disabled && styles.btnDisabled,
                      ]}
                      testID={btn.testID}
                    >
                      <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                        {btn.loading ? 'Verifying…' : btn.label}
                      </Text>
                    </Pressable>
                  )}
                />
              </View>
            </>
          ) : (
            <>
              <Text style={[styles.body, { color: themed.slate }]}>
                {pending ? lineForReason(pending.reason) : ''}
              </Text>
              <Text style={[styles.hint, { color: themed.slate }]}>
                Tap Continue to confirm with your passkey.
              </Text>

              <View style={styles.actions}>
                <Pressable
                  onPress={cancel}
                  disabled={verifying}
                  style={[
                    styles.btnSecondary,
                    { borderColor: themed.divider },
                    verifying && styles.btnDisabled,
                  ]}
                  testID="verify-device-cancel"
                >
                  <Text style={[styles.btnSecondaryText, { color: themed.ink }]}>
                    Not now
                  </Text>
                </Pressable>
                <Pressable
                  onPress={onContinue}
                  disabled={verifying}
                  style={[
                    styles.btnPrimary,
                    { backgroundColor: themed.primary },
                    verifying && styles.btnDisabled,
                  ]}
                  testID="verify-device-continue"
                >
                  <Text style={[styles.btnPrimaryText, { color: themed.cream }]}>
                    {verifying ? 'Verifying…' : 'Continue'}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
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
  fallbackBlock: { marginTop: space.s },
  actions: { gap: space.s },
  btnPrimary: {
    paddingVertical: space.base,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
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
