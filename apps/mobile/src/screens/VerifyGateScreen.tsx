import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
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
  accent,
  brand,
  font,
  motion,
  type as typeScale,
  workspace,
} from '../theme/tokens.js';
import { space } from '../theme/index.js';
import { diag } from '../diag/log.js';

/**
 * Full-screen verify gate. Mounted by the router when an authed user
 * (userId set) has no cached Vouchflow device token — i.e. the
 * cryptographic credentials the rest of the app depends on are
 * absent. Two scenarios reach here:
 *
 *   1. Fresh install of an account that already exists on the server
 *      (the userId hydrated from disk on a reinstall, but the token —
 *      stored separately in the native keystore — did not).
 *   2. Token explicitly cleared (account reset attempt, error recovery
 *      path that wiped the token but not the userId).
 *
 * The monthly-expiry case does NOT route here: the launch-refresh
 * effect handles a stale-but-present token via the bottom sheet so
 * the app can stay usable on cached identity if the user dismisses
 * the prompt (see App.tsx launch verify useEffect + the "lunchboxxx
 * incident" reason comment). The gate fires only when the token is
 * GENUINELY missing — there is no usable identity to fall back on.
 *
 * Unlike VerifyDeviceSheet, this is non-dismissible. The user MUST
 * verify (or close the app). That's the point — half-working state
 * is worse UX than a clean welcome-back gate.
 *
 * Brand canvas. AvatarRenderer at the top frames the moment as
 * "welcome back" rather than "authenticate." Single primary action.
 * Tap → vouchflow.verify directly (no sheet — the screen itself is
 * the explanation). On success, setDeviceToken flips the router
 * condition and the gate unmounts. On failure, retry inline.
 */
export function VerifyGateScreen(): React.ReactElement {
  const userId = useIdentity((s) => s.userId);
  const profile = useProfiles((s) => s.byUserId[userId ?? '']);
  const animalId =
    profile?.selectedAvatarId ?? defaultAnimalForUser(userId ?? '');

  const [verifying, setVerifying] = useState(false);
  const [errorCopy, setErrorCopy] = useState<string | undefined>(undefined);

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
      const r = await vouchflow.verify({ context: 'login' });
      // setDeviceToken flips the router condition; the gate unmounts
      // on the next render. No explicit navigation needed.
      useIdentity.getState().setDeviceToken(r.deviceToken);
      diag('app', 'verify gate: success', { userId });
    } catch (err) {
      diag('app', 'verify gate: failed', { userId, err: String(err) });
      setErrorCopy(
        "Couldn't verify. Try again — make sure your screen lock is set up.",
      );
    } finally {
      setVerifying(false);
    }
  };

  return (
    <SafeAreaView testID="verify-gate-screen" style={styles.root}>
      <View style={styles.body}>
        <Animated.View
          style={[
            styles.stack,
            { opacity: reveal, transform: [{ translateY }] },
          ]}
        >
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
        </Animated.View>
      </View>

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
