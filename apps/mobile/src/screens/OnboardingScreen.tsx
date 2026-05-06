import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { validateHandle } from '@speakeasy/shared';
import { Button } from '../components/Button.js';
import { IconMark } from '../components/IconMark.js';
import { Wordmark } from '../components/Wordmark.js';
import { useIdentity } from '../store/identity.js';
import { api, signalProtocol, vouchflow } from '../services.js';
import { pushNotifications } from '../services.js';
import { ApiError } from '../api/client.js';
import { VouchflowClientError, type VouchflowErrorReason } from '../native/vouchflow.js';
import { SignalClientError } from '@speakeasy/crypto';
import { colors, fonts, radius, space, text } from '../theme/index.js';
import { brand } from '../theme/tokens.js';

type AvailabilityState =
  | { kind: 'idle' }
  | { kind: 'localInvalid' }
  | { kind: 'reserved' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken' }
  | { kind: 'error' };

interface Props {
  onEnrolled: (userId: string) => void;
}

// Tagline per BRANDING1.md §11 (rebrand): "Say it. Leave nothing."
const SLOGAN_PLACEHOLDER = 'Say it. Leave nothing.';

// libsignal's PreKey replenish-batch convention. Server's low_water trigger
// fires when remaining drops below 10, so 100 leaves a generous buffer.
const PREKEY_BATCH_SIZE = 100;

function randomRegistrationId(): number {
  // Match the Kotlin module's range (1..16380, libsignal's reserved space).
  return 1 + Math.floor(Math.random() * 16380);
}

const PRINCIPLES = [
  'No phone, no email.',
  'End-to-end encrypted.',
  'Disappears in 7 days.',
];

export function OnboardingScreen({ onEnrolled }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [handle, setHandle] = useState('');
  const [availability, setAvailability] = useState<AvailabilityState>({ kind: 'idle' });
  const [focused, setFocused] = useState(false);
  // Drives the hero/principles slide-up. 1 = full hero shown,
  // 0 = collapsed so the handle input + Continue dominate. Animated
  // with opacity + translateY (-40px) over `motion.screen` (240ms);
  // we can't animate height with the native driver but the
  // collapsed Animated.View also gets pointerEvents="none" so it
  // doesn't intercept taps.
  const heroAnim = useRef(new Animated.Value(1)).current;
  // Bumped on every input change; the in-flight check ignores its
  // response when its token is no longer current. Kills the "user
  // typed faster than the server replied → stale state lands" race.
  const tokenRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    Animated.timing(heroAnim, {
      toValue: focused ? 0 : 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [focused, heroAnim]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (handle.length === 0) {
      setAvailability({ kind: 'idle' });
      return;
    }
    const localReason = validateHandle(handle);
    if (localReason === 'invalid') {
      setAvailability({ kind: 'localInvalid' });
      return;
    }
    if (localReason === 'reserved') {
      setAvailability({ kind: 'reserved' });
      return;
    }
    setAvailability({ kind: 'checking' });
    const myToken = ++tokenRef.current;
    debounceRef.current = setTimeout(() => {
      api
        .checkAvailability(handle)
        .then((r) => {
          if (myToken !== tokenRef.current) return;
          if (r.available) {
            setAvailability({ kind: 'available' });
          } else if (r.reason === 'taken') {
            setAvailability({ kind: 'taken' });
          } else if (r.reason === 'reserved') {
            setAvailability({ kind: 'reserved' });
          } else {
            setAvailability({ kind: 'localInvalid' });
          }
        })
        .catch(() => {
          if (myToken !== tokenRef.current) return;
          setAvailability({ kind: 'error' });
        });
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [handle]);

  async function handleContinue() {
    if (availability.kind !== 'available') return;
    setBusy(true);
    setError(undefined);
    try {
      // 1. Vouchflow verify — minimumConfidence enforced inside the SDK.
      // Tier B builds use sandbox keys against sandbox.api.vouchflow.dev;
      // sandbox supports emulators per Vouchflow docs and records a
      // confidence: medium verify. The 60s ceiling allows for a real
      // biometric prompt + sandbox round-trip while still surfacing a
      // hung SDK as a real error rather than a frozen UI.
      const verifyResult = await Promise.race([
        vouchflow.verify({
          context: 'signup',
          minimumConfidence: 'medium',
        }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new VouchflowClientError('biometric_unavailable', 'Timeout: verify did not complete in 60s')),
            60_000,
          ),
        ),
      ]);
      const deviceToken = verifyResult.deviceToken;
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
        token: deviceToken,
        user_id: handle,
        publicKey: identityPublicKey,
        preKeyBundle: {
          registrationId: ownBundle.registrationId,
          signedPreKeyId: ownBundle.signedPreKeyId,
          signedPreKey: ownBundle.signedPreKey,
          signedPreKeySig: ownBundle.signedPreKeySig,
          preKeys: ownBundle.preKeys,
        },
      });
      // Persist the deviceToken alongside the userId. Every authenticated
      // request (WS auth, prekey fetch, send) reads it back from the
      // identity store — no further vouchflow.verify() calls until sign out
      // or the server invalidates the token.
      useIdentity.getState().setDeviceToken(deviceToken);
      useIdentity.getState().setUserId(user_id);
      onEnrolled(user_id);

      // Phase 5d: best-effort push token registration. If the device
      // doesn't support push (no Play Services, permission denied), we
      // simply skip — messages still arrive via the buffered-delivery
      // path on next WS connect.
      try {
        const pushResult = await pushNotifications.getToken();
        if (pushResult) {
          await api.registerPushToken(
            deviceToken,
            pushResult.pushToken,
            pushResult.platform,
          );
        }
      } catch {
        // Non-fatal — push is a convenience, not a requirement.
      }
    } catch (err: unknown) {
      // Mirror the full error to logcat so Tier B post-mortem captures
      // it via the ReactNativeJS tag (the on-screen string is necessarily
      // truncated and loses cause chain / stack).
      const errAny = err as { cause?: unknown; stack?: string };
      console.error(
        '[onboarding] verify+enroll failed',
        err,
        'cause:', errAny?.cause,
        'stack:', errAny?.stack,
      );
      // Surface the actual error reason on screen — debugging on a real
      // device without USB/adb is otherwise opaque.
      const msg = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : 'Error';
      if (err instanceof VouchflowClientError) {
        // Surface the SDK's underlying message alongside the friendly
        // reason so device-only debugging (no adb access) can see what
        // the native SDK actually rejected on.
        const detail = err.message && err.message !== err.reason ? ` — ${err.message}` : '';
        setError(`${messageForVouchflowError(err.reason)} [${err.reason}]${detail}`);
      } else if (err instanceof SignalClientError) {
        setError(`Identity key gen failed: ${err.reason}${err.message && err.message !== err.reason ? ` — ${err.message}` : ''}`);
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'taken') {
        // Lost the race between `checkAvailability` and `tryCreate`.
        setAvailability({ kind: 'taken' });
        setError('That handle was just claimed — try another.');
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'reserved') {
        setAvailability({ kind: 'reserved' });
        setError('That handle is reserved.');
      } else if (err instanceof ApiError) {
        setError(`Enrollment failed (${err.status}${err.code ? ` ${err.code}` : ''}).`);
      } else {
        setError(`Unexpected: ${name} — ${msg}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView testID="onboarding-screen" style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        {/* Top section scrolls when the keyboard pinches the screen, so the
            handle input + status text + Continue button never overlap each
            other (alpha-0.4.8 had a `flex: 1, justifyContent: 'flex-end'`
            on the bottom row that drew Continue on top of the status). */}
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
        >
          <Animated.View
            pointerEvents={focused ? 'none' : 'auto'}
            style={{
              opacity: heroAnim,
              transform: [
                {
                  translateY: heroAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-40, 0],
                  }),
                },
              ],
              // Collapse the hero block to zero height when focused
              // so the handle section rises to the top of the visible
              // area. `height: 0 + overflow: hidden` is the cheapest
              // collapse that still respects flex layout below it.
              height: focused ? 0 : undefined,
              overflow: 'hidden',
            }}
          >
            <View style={styles.header}>
              <IconMark size={120} animate />
              <Wordmark variant="hero" tagline={SLOGAN_PLACEHOLDER} />
            </View>
            <View style={styles.principles}>
              {PRINCIPLES.map((p) => (
                <View key={p} style={styles.principleRow}>
                  <View style={styles.bullet} />
                  <Text style={[text.subtitle, styles.principleText]}>{p}</Text>
                </View>
              ))}
            </View>
          </Animated.View>
          <View style={styles.handleSection}>
            <Text style={styles.handleLabel}>Choose your handle</Text>
            <View
              style={[
                styles.handleRow,
                availability.kind === 'available' && styles.handleRowOk,
                (availability.kind === 'taken' ||
                  availability.kind === 'reserved' ||
                  availability.kind === 'localInvalid') &&
                  styles.handleRowBad,
              ]}
            >
              <Text style={styles.atPrefix}>@</Text>
              <TextInput
                value={handle}
                onChangeText={(t) =>
                  setHandle(t.toLowerCase().replace(/[^a-z0-9_]/g, ''))
                }
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                placeholder="yourname"
                placeholderTextColor={colors.slate}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                maxLength={20}
                editable={!busy}
                style={styles.handleInput}
                testID="onboarding-handle"
              />
            </View>
            <Text
              style={[styles.handleStatus, statusColor(availability)]}
              testID="onboarding-handle-status"
            >
              {statusMessage(availability, handle)}
            </Text>
          </View>
        </ScrollView>
        <View style={styles.bottom}>
          {error ? <Text testID="onboarding-error" style={styles.error}>{error}</Text> : null}
          <Button
            label="Continue"
            onPress={handleContinue}
            loading={busy}
            disabled={availability.kind !== 'available' || busy}
            tone="primary"
            testID="onboarding-continue"
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function statusMessage(s: AvailabilityState, handle: string): string {
  switch (s.kind) {
    case 'idle':
      return 'Letters, digits, underscores. 3–20 chars. Start with a letter.';
    case 'localInvalid':
      return 'Letters, digits, underscores. 3–20 chars. Start with a letter.';
    case 'reserved':
      return `@${handle} is reserved.`;
    case 'checking':
      return 'Checking…';
    case 'available':
      return `@${handle} is available.`;
    case 'taken':
      return `@${handle} is taken.`;
    case 'error':
      return 'Could not check availability — retry in a moment.';
  }
}

function statusColor(s: AvailabilityState) {
  // Spec §1: only one accent on screen. Available = brass-positive.
  // Unhappy states fall back to ink (foreground) so they don't compete
  // with the brass affirmation; the ROW border still flips to mute on
  // bad input, which is enough to surface "wrong".
  if (s.kind === 'available') return { color: colors.primary };
  if (
    s.kind === 'taken' ||
    s.kind === 'reserved' ||
    s.kind === 'localInvalid' ||
    s.kind === 'error'
  ) {
    return { color: colors.ink };
  }
  return { color: colors.slate };
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
  // Spec §7: onboarding renders on the brand canvas (aubergine), not
  // the workspace canvas. Mode-invariant.
  root: { flex: 1, backgroundColor: brand.canvas },
  flex: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.md,
  },
  header: { alignItems: 'center', gap: space.md, marginTop: space.lg },
  principles: { gap: space.sm, paddingHorizontal: space.md, marginTop: space.lg },
  principleRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // Spec §10: no circular badges. Bullets are 6×6 brass squares —
  // same gesture as the StatusSquare, scaled identically.
  bullet: {
    width: 6,
    height: 6,
    backgroundColor: colors.primary,
  },
  principleText: { color: colors.ink, flex: 1 },
  handleSection: { gap: space.xs, marginTop: space.lg, paddingHorizontal: space.md },
  handleLabel: {
    fontFamily: fonts.inter500,
    fontSize: 13,
    color: colors.slate,
  },
  // Onboarding sits on the brand canvas — the handle input uses the
  // brand-side surface so it reads against the aubergine, not the
  // workspace surface (which would near-vanish on aubergine).
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: brand.surface,
    borderRadius: radius.avatar,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  // Spec §1: two colors do everything. We don't introduce a separate
  // error red — the unhappy paths use text-mute / accent treatments.
  handleRowOk: { borderColor: colors.primary },
  handleRowBad: { borderColor: colors.slate },
  atPrefix: {
    fontFamily: fonts.inter500,
    fontSize: 18,
    color: colors.slate,
    marginRight: 2,
  },
  handleInput: {
    flex: 1,
    fontFamily: fonts.inter500,
    fontSize: 18,
    color: colors.ink,
    padding: 0,
  },
  handleStatus: {
    fontFamily: fonts.inter400,
    fontSize: 12,
    paddingHorizontal: space.xs,
  },
  bottom: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.lg,
    gap: space.sm,
  },
  error: {
    color: colors.ink,
    fontFamily: fonts.inter400,
    fontSize: 12,
    textAlign: 'center',
  },
});
