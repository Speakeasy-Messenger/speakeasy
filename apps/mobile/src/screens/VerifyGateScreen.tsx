import { verifyReviewerCode } from '../auth/reviewer-code.js';
import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AvatarRenderer } from '../avatars/AvatarRenderer.js';
import { defaultAnimalForUser } from '../avatars/default.js';
import { vouchflow } from '../services.js';
import { useIdentity } from '../store/identity.js';
import { useProfiles } from '../store/profiles.js';
import {
  fallbackReasonFor,
  VerificationTimeoutError,
  verifyWithTimeout,
} from '../auth/claim-handle.js';
import { ReviewerVerification } from '../components/ReviewerVerification.js';
import { VouchflowClientError, type FallbackReason } from '../native/vouchflow.js';
import { accent, brand, font, motion, type as typeScale, workspace } from '../theme/tokens.js';
import { space } from '../theme/index.js';
import { diag } from '../diag/log.js';

export function VerifyGateScreen(): React.ReactElement {
  const userId = useIdentity((s) => s.userId);
  const profile = useProfiles((s) => s.byUserId[userId ?? '']);
  const animalId = profile?.selectedAvatarId ?? defaultAnimalForUser(userId ?? '');

  const [verifying, setVerifying] = useState(false);
  const [errorCopy, setErrorCopy] = useState<string | undefined>(undefined);

  const [fallbackReason, setFallbackReason] = useState<FallbackReason | undefined>(undefined);

  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(reveal, {
      toValue: 1,
      duration: motion.dissolve,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [reveal]);
  const translateY = reveal.interpolate({
    inputRange: [0, 1],
    outputRange: [8, 0],
  });

  const onVerify = async (): Promise<void> => {
    if (verifying) return;
    setErrorCopy(undefined);
    setVerifying(true);
    try {
      // `low` matches the floor onboarding and the server's validator
      // already accept — see `auth/claim-handle.ts`.
      const r = await verifyWithTimeout(vouchflow, {
        context: 'login',
        minimumConfidence: 'low',
      });
      // setDeviceToken flips the router condition; the gate unmounts
      // on the next render. No explicit navigation needed.
      useIdentity.getState().setDeviceToken(r.deviceToken);
      diag('app', 'verify gate: success', { userId });
    } catch (err) {
      diag('app', 'verify gate: failed', { userId, err: String(err) });

      setErrorCopy(undefined);
      setFallbackReason(
        err instanceof VerificationTimeoutError
          ? 'attestation_timeout'
          : err instanceof VouchflowClientError
            ? fallbackReasonFor(err.reason)
            : 'sdk_error',
      );
    } finally {
      setVerifying(false);
    }
  };

  async function handleReviewerVerified(args: { code: string }): Promise<void> {
    const { deviceToken } = await verifyReviewerCode({ code: args.code, context: 'login' });
    useIdentity.getState().setDeviceToken(deviceToken);
    diag('app', 'verify gate: success via reviewer code', { userId });
  }

  return (
    <SafeAreaView testID="verify-gate-screen" style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.body}>
          <Animated.View style={[styles.stack, { opacity: reveal, transform: [{ translateY }] }]}>
            <Text style={styles.eyebrow}>WELCOME BACK</Text>

            <View style={styles.portraitTile}>
              <AvatarRenderer animalId={animalId} size={Math.round(96 * 0.78)} />
            </View>

            {userId ? (
              <Text style={styles.copy}>
                You are{' '}
                <Text style={styles.copyEm}>
                  <Text style={styles.brass}>@</Text>
                  {userId}
                </Text>
                .
              </Text>
            ) : null}
            <Text style={styles.copy}>
              Confirm this is your device to unlock messages and calls.
            </Text>
            <Text style={styles.copyHint}>
              Speakeasy verifies once a month to keep your identity yours.
            </Text>

            {errorCopy ? (
              <Text style={styles.error} testID="verify-gate-error">
                {errorCopy}
              </Text>
            ) : null}

            {fallbackReason !== undefined ? (
              <View style={styles.fallbackBlock}>
                <ReviewerVerification
                  onSubmit={handleReviewerVerified}
                  colors={{ text: BONE, muted: TEXT_MUTE, faint: TEXT_FAINT }}
                  testIDPrefix="verify-gate-fallback"
                  renderButton={(btn) => (
                    <Pressable
                      onPress={btn.onPress}
                      disabled={btn.disabled}
                      style={[styles.btnPrimary, btn.disabled && styles.btnPrimaryDisabled]}
                      testID={btn.testID}
                    >
                      <Text style={styles.btnPrimaryText}>
                        {btn.loading ? 'Verifying…' : btn.label}
                      </Text>
                    </Pressable>
                  )}
                />
              </View>
            ) : null}
          </Animated.View>
        </View>

        {fallbackReason === undefined ? (
          <View style={styles.actions}>
            <Pressable
              onPress={onVerify}
              disabled={verifying}
              style={[styles.btnPrimary, verifying && styles.btnPrimaryDisabled]}
              testID="verify-gate-continue"
            >
              <Text style={styles.btnPrimaryText}>
                {verifying ? 'Verifying…' : 'Verify this device'}
              </Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const BRASS = accent.base;
const BONE = workspace.dark.text;
const INK = accent.foreground;
const BRAND_SURFACE = brand.surface;
const TEXT_FAINT = workspace.dark.textFaint;
const TEXT_MUTE = workspace.dark.textMute;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: brand.canvas },
  flex: { flex: 1 },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  stack: { alignItems: 'center', maxWidth: 32 * 8 },
  eyebrow: {
    fontFamily: typeScale.meta.weight,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    color: TEXT_MUTE,
    fontWeight: '500',
    marginBottom: 24,
  },
  portraitTile: {
    width: 96,
    height: 96,
    backgroundColor: BRAND_SURFACE,
    borderWidth: 1,
    borderColor: TEXT_FAINT,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xl,
  },
  copy: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: BONE,
    textAlign: 'center',
    marginBottom: space.md,
  },
  copyEm: {
    fontFamily: font.medium,
    color: BONE,
  },
  // `stack` centers its children, so a plain child would shrink-wrap
  // its TextInput instead of filling the available width — stretch
  // opts this block back into the default column-fill behavior.
  fallbackBlock: { alignSelf: 'stretch', marginTop: space.md },
  copyHint: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: TEXT_MUTE,
    textAlign: 'center',
    marginTop: space.sm,
  },
  brass: { color: BRASS, fontFamily: font.bold },
  error: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: BRASS,
    textAlign: 'center',
    marginTop: space.md,
  },
  actions: {
    paddingHorizontal: space.lg,
    paddingBottom: space.lg,
    gap: 8,
  },
  btnPrimary: {
    backgroundColor: BRASS,
    paddingVertical: space.md,
    alignItems: 'center',
  },
  btnPrimaryDisabled: { opacity: 0.6 },
  btnPrimaryText: {
    fontFamily: font.medium,
    fontSize: 14,
    color: INK,
    letterSpacing: 0.5,
  },
});
