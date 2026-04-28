import React, { useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { Button } from '../components/Button.js';
import { IconMark } from '../components/IconMark.js';
import { Wordmark } from '../components/Wordmark.js';
import { useIdentity } from '../store/identity.js';
import { api, signalProtocol, vouchflow } from '../services.js';
import { ApiError } from '../api/client.js';
import { VouchflowClientError, type VouchflowErrorReason } from '../native/vouchflow.js';
import { SignalClientError } from '@speakeasy/crypto';
import { colors, fonts, space, text } from '../theme/index.js';

interface Props {
  onEnrolled: (userId: string) => void;
}

// Slogan is brand-WIP per spec §14. Centralised so it's easy to swap.
const SLOGAN_PLACEHOLDER = 'Say it & leave.';

// libsignal's PreKey replenish-batch convention. Server's low_water trigger
// fires when remaining drops below 10, so 100 leaves a generous buffer.
const PREKEY_BATCH_SIZE = 100;

function randomRegistrationId(): number {
  // Match the Kotlin module's range (1..16380, libsignal's reserved space).
  return 1 + Math.floor(Math.random() * 16380);
}

const PRINCIPLES = [
  'No personal info — no phone, no email.',
  'End-to-end encrypted by default.',
  'Disappears by default. 7 days, then gone.',
  'Random ID. No display name. No tracking.',
];

export function OnboardingScreen({ onEnrolled }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleContinue() {
    setBusy(true);
    setError(undefined);
    try {
      // 1. Vouchflow verify — minimumConfidence enforced inside the SDK.
      // The deviceToken returned here is the same value the SDK persists
      // to AccountManager; SpeakeasyDb derives the SQLCipher key from it
      // (Phase 5c) on the next native-store call.
      const verifyResult = await vouchflow.verify({
        context: 'signup',
        minimumConfidence: 'medium',
      });
      // 2. Mint (or restore) the device's Signal identity. The native
      // bridge persists into SQLCipher; on a re-launch this returns the
      // same key without re-prompting.
      const identityPublicKey = await signalProtocol.generateIdentityKey();
      // 3. Build the upload bundle. registrationId range matches the
      // native module: 1..16380 (libsignal's reserved space). signedPreKeyId
      // starts at 1 — the native module bumps it on each replenish round.
      const registrationId = randomRegistrationId();
      const ownBundle = await signalProtocol.generatePreKeyBundle({
        registrationId,
        signedPreKeyId: 1,
        oneTimePreKeyCount: PREKEY_BATCH_SIZE,
      });
      const { user_id } = await api.enroll({
        token: verifyResult.deviceToken,
        publicKey: identityPublicKey,
        preKeyBundle: {
          registrationId: ownBundle.registrationId,
          signedPreKeyId: ownBundle.signedPreKeyId,
          signedPreKey: ownBundle.signedPreKey,
          signedPreKeySig: ownBundle.signedPreKeySig,
          preKeys: ownBundle.preKeys,
        },
      });
      useIdentity.getState().setUserId(user_id);
      onEnrolled(user_id);
    } catch (err: unknown) {
      if (err instanceof VouchflowClientError) {
        setError(messageForVouchflowError(err.reason));
      } else if (err instanceof SignalClientError) {
        setError('Could not generate identity keys. Please try again.');
      } else if (err instanceof ApiError) {
        setError(`Enrollment failed (${err.status}${err.code ? ` ${err.code}` : ''}).`);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <IconMark size={120} />
        <Wordmark variant="hero" subtitle={SLOGAN_PLACEHOLDER} />
      </View>
      <View style={styles.principles}>
        {PRINCIPLES.map((p) => (
          <View key={p} style={styles.principleRow}>
            <View style={styles.bullet} />
            <Text style={[text.subtitle, styles.principleText]}>{p}</Text>
          </View>
        ))}
      </View>
      <View style={styles.bottom}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Button label="Continue" onPress={handleContinue} loading={busy} tone="primary" />
      </View>
    </SafeAreaView>
  );
}

function messageForVouchflowError(reason: VouchflowErrorReason): string {
  switch (reason) {
    case 'biometric_cancelled':
      return 'Biometric prompt cancelled. Tap Continue to try again.';
    case 'biometric_failed':
      return 'Biometric check failed. Try again, or use another sign-in method.';
    case 'biometric_unavailable':
      return 'Biometric authentication is not set up on this device.';
    case 'minimum_confidence_unmet':
      return 'This device cannot be verified yet. Please try again later.';
    case 'network_unavailable':
      return 'No network connection. Check connectivity and try again.';
    case 'enrollment_failed':
      return 'Device enrollment failed. We will retry on next launch.';
    default:
      return 'Verification failed. Please try again.';
  }
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.cream, padding: space.lg },
  header: { alignItems: 'center', gap: space.md, marginTop: space.xxl },
  principles: { flex: 1, justifyContent: 'center', gap: space.md, paddingHorizontal: space.md },
  principleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  bullet: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.primary,
  },
  principleText: { color: colors.ink, flex: 1 },
  bottom: { gap: space.sm },
  error: {
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 12,
    textAlign: 'center',
  },
});
