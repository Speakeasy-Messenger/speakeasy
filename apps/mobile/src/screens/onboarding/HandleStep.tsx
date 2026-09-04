import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { validateHandle } from '@speakeasy/shared';
import { Button } from '../../components/Button.js';
import { isDeviceSecure, openSecuritySettings } from '../../native/lock-screen.js';
import { api, signalProtocol, vouchflow } from '../../services.js';
import { ApiError } from '../../api/client.js';
import { VouchflowClientError, type FallbackReason, type VouchflowErrorReason } from '../../native/vouchflow.js';
import {
  claimWithDeviceAttestation,
  completeEmailFallbackClaim,
  EmailFallbackError,
  startEmailFallback,
  type ClaimDeps,
  VerificationTimeoutError,
} from '../../auth/claim-handle.js';
import { SignalClientError } from '@speakeasy/crypto';
import { accent, brand, font, space, type as typeScale, workspace } from '../../theme/tokens.js';
import { generateShortHandle } from '../../utils/generate-handle.js';
import { diag } from '../../diag/log.js';

/**
 * Onboarding screen 03 — Handle.
 * Spec: ONBOARDING.md §2.3.
 *
 * Eyebrow + "You are" prefix + handle input with fixed brass `@` +
 * 5-state availability indicator + secondary "Generate one for me" +
 * primary "This one's mine".
 *
 * On accept: vouchflow.verify (biometric) → api.enroll → returns the
 * server-assigned userId + deviceToken to the parent for step 04.
 * Devices that cannot attest at all (no screen lock, or an
 * un-attestable device) are offered Vouchflow's email-OTP fallback
 * instead of an error — see `auth/claim-handle.ts`, which owns both
 * paths so they stay testable outside a React renderer.
 */

const deps: ClaimDeps = { api, signalProtocol, vouchflow, isDeviceSecure };

/** Where the email fallback is in its two-step (address → code) flow. */
type FallbackState =
  | { kind: 'none' }
  | { kind: 'email'; reason: FallbackReason }
  | { kind: 'otp'; sessionId: string; email: string };

export type AvailabilityState =
  | { kind: 'idle' }
  | { kind: 'localInvalid' }
  | { kind: 'reserved' }
  | { kind: 'checking' }
  | { kind: 'available' }
  | { kind: 'taken' }
  | { kind: 'error' };

interface Props {
  /** Called once enroll succeeds. Parent is responsible for advancing
   * to step 04 (face picker) and persisting userId/deviceToken. */
  onClaimed: (args: { userId: string; deviceToken: string }) => void;
}

export function HandleStep({ onClaimed }: Props): React.ReactElement {
  const [handle, setHandle] = useState('');
  const [availability, setAvailability] = useState<AvailabilityState>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // True when the device has no secure lock (no PIN/pattern/biometric) —
  // surfaces a "Set up screen lock" deep link, the better fix when the
  // device is otherwise capable. Shown alongside the email fallback,
  // never instead of it.
  const [needsLock, setNeedsLock] = useState(false);
  const [fallback, setFallback] = useState<FallbackState>({ kind: 'none' });
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');

  const tokenRef = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<TextInput | null>(null);

  // Spec §2.3.1 — 300ms debounced availability check, with cancellation
  // via a monotonically-increasing token so the user-typed-faster-than-
  // server-replied race lands on the latest state.
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

  function handleGenerate() {
    // Spec §2.3.6: generated handle goes straight into the input, no
    // 300ms debounce — the user expects an immediate availability
    // result for a roll. Setting handle triggers the effect above
    // which fires the check; we can't bypass the debounce there
    // without duplicating the request, so we accept a single 300ms
    // window before "available" lights up. Acceptable for MVP.
    const next = generateShortHandle();
    setHandle(next);
  }

  async function handleClaim() {
    if (availability.kind !== 'available') return;
    setBusy(true);
    setError(undefined);
    setNeedsLock(false);
    setFallback({ kind: 'none' });
    try {
      const result = await claimWithDeviceAttestation(deps, handle);
      if (result.kind === 'needs_email_fallback') {
        // Not a dead end: this device can't attest, so offer the email
        // code instead. A lockless device also gets the "Set up screen
        // lock" deep link, which is the better fix when it applies.
        setNeedsLock(result.noLock);
        setError(result.noLock ? VERIFY_SETUP_HELP : VERIFY_DEVICE_HELP);
        setFallback({ kind: 'email', reason: result.reason });
        return;
      }
      // Push token registration is intentionally NOT done here.
      //
      // `pushNotifications.getToken()` on Android 13+ internally
      // requests POST_NOTIFICATIONS, which would pop the OS prompt
      // over the Face / Avatar screen the user is about to land on
      // — directly contradicting the dedicated PermissionsStep that
      // asks for the same permission a step later. Tester feedback
      // (rc.33): "notification permissions should be granted at the
      // page that is actually requesting the permissions, but right
      // now it is being asked at the page for avatar selection."
      //
      // Push registration happens via App.tsx's `userId`-keyed
      // useEffect right after PermissionsStep flips identity — at
      // which point the user has already answered the prompt on the
      // dedicated screen and getToken() resolves without re-asking.
      onClaimed({ userId: result.userId, deviceToken: result.deviceToken });
    } catch (err: unknown) {
      reportClaimFailure(err);
    } finally {
      setBusy(false);
    }
  }

  /** Step 1 of the fallback: ask Vouchflow to email a one-time code. */
  async function handleRequestCode() {
    if (fallback.kind !== 'email') return;
    setBusy(true);
    setError(undefined);
    try {
      const { sessionId } = await startEmailFallback(deps, {
        email,
        reason: fallback.reason,
      });
      setOtp('');
      setFallback({ kind: 'otp', sessionId, email: email.trim() });
    } catch (err: unknown) {
      if (err instanceof EmailFallbackError && err.reason === 'invalid_email') {
        setError('That does not look like an email address.');
      } else {
        reportClaimFailure(err);
      }
    } finally {
      setBusy(false);
    }
  }

  /** Step 2 of the fallback: submit the code, then enroll exactly as the
   * attestation path does. */
  async function handleSubmitCode() {
    if (fallback.kind !== 'otp') return;
    setBusy(true);
    setError(undefined);
    try {
      const claimed = await completeEmailFallbackClaim(deps, {
        handle,
        sessionId: fallback.sessionId,
        otp,
      });
      onClaimed(claimed);
    } catch (err: unknown) {
      if (err instanceof EmailFallbackError) {
        setError(
          err.reason === 'otp_rejected'
            ? 'That code did not match. Check the email and try again.'
            : VERIFY_DEVICE_HELP,
        );
      } else {
        reportClaimFailure(err);
      }
    } finally {
      setBusy(false);
    }
  }

  function reportClaimFailure(err: unknown) {
    const errAny = err as { cause?: unknown; stack?: string };
    diag('onboarding', 'claim failed', {
      msg: err instanceof Error ? err.message : String(err),
      cause: String(errAny?.cause ?? ''),
    });
    const msg = err instanceof Error ? err.message : String(err);
    const name = err instanceof Error ? err.name : 'Error';
    if (err instanceof VerificationTimeoutError) {
      setError('Device verification took too long. Tap "This one\'s mine" to try again.');
    } else if (err instanceof VouchflowClientError) {
      const detail = err.message && err.message !== err.reason ? ` — ${err.message}` : '';
      setError(`${messageForVouchflowError(err.reason)} [${err.reason}]${detail}`);
    } else if (err instanceof SignalClientError) {
      setError(
        `Identity key gen failed: ${err.reason}${err.message && err.message !== err.reason ? ` — ${err.message}` : ''}`,
      );
    } else if (err instanceof ApiError && err.status === 409 && err.code === 'taken') {
      // Spec §2.3.7 — race with another claim. Drop indicator to
      // empty + reset focus so the user types again.
      setAvailability({ kind: 'idle' });
      setHandle('');
      setFallback({ kind: 'none' });
      setError('Someone else just took that one.');
      inputRef.current?.focus();
    } else if (err instanceof ApiError && err.status === 409 && err.code === 'reserved') {
      setAvailability({ kind: 'reserved' });
      setError('That handle is reserved.');
    } else if (err instanceof ApiError) {
      setError(`Enrollment failed (${err.status}${err.code ? ` ${err.code}` : ''}).`);
    } else {
      setError(`Unexpected: ${name} — ${msg}`);
    }
  }

  return (
    <SafeAreaView testID="onboarding-screen" style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <View style={styles.content}>
          <Text style={styles.eyebrow}>YOUR NAME IN THE ROOM</Text>
          <Text style={styles.prefix}>You are</Text>
          <View style={[styles.inputRow, focusBorderFor(availability)]}>
            <Text style={styles.atGlyph}>@</Text>
            <TextInput
              ref={inputRef}
              value={handle}
              onChangeText={(t) =>
                // Spec §2.3.2: lowercase + restrict to allowed set
                // (a-z 0-9 . - _) on every keystroke.
                setHandle(t.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 20))
              }
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              editable={!busy}
              style={styles.input}
              testID="onboarding-handle"
            />
          </View>
          <View style={styles.indicatorRow}>
            {availability.kind === 'available' ? (
              <View style={styles.indicatorSquareBrass} />
            ) : availability.kind === 'taken' ||
              availability.kind === 'reserved' ||
              availability.kind === 'localInvalid' ? (
              <View style={styles.indicatorSquareMute} />
            ) : null}
            <Text
              style={[styles.indicatorText, availabilityColor(availability)]}
              testID="onboarding-handle-status"
            >
              {indicatorMessage(availability, handle)}
            </Text>
          </View>
          <Text style={styles.explainer}>
            Pick anything. Or let us pick one. Nothing about you needs to be in it.
          </Text>
        </View>

        <View style={styles.bottom}>
          {error ? (
            <Text testID="onboarding-error" style={styles.error}>
              {error}
            </Text>
          ) : null}
          {fallback.kind !== 'none' ? (
            <View style={styles.fallbackBlock}>
              <Text style={styles.fallbackHelp}>
                {fallback.kind === 'email'
                  ? 'Or verify by email instead. We only use it to send this one code — it is not attached to your handle.'
                  : `We sent a code to ${fallback.email}. Enter it to finish.`}
              </Text>
              {fallback.kind === 'email' ? (
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="you@example.com"
                  placeholderTextColor={TEXT_FAINT}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  editable={!busy}
                  style={styles.fallbackInput}
                  testID="onboarding-fallback-email"
                />
              ) : (
                <TextInput
                  value={otp}
                  onChangeText={(t) => setOtp(t.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8))}
                  placeholder="123456"
                  placeholderTextColor={TEXT_FAINT}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="number-pad"
                  editable={!busy}
                  style={styles.fallbackInput}
                  testID="onboarding-fallback-otp"
                />
              )}
            </View>
          ) : null}
          <View style={styles.buttonStack}>
            {needsLock ? (
              <Button
                label="Set up screen lock"
                onPress={() => void openSecuritySettings()}
                variant="secondary"
                disabled={busy}
                testID="onboarding-setup-lock"
              />
            ) : null}
            {fallback.kind === 'email' ? (
              <Button
                label="Email me a code"
                onPress={() => void handleRequestCode()}
                loading={busy}
                disabled={email.trim().length === 0 || busy}
                testID="onboarding-fallback-request"
              />
            ) : fallback.kind === 'otp' ? (
              <Button
                label="Verify code"
                onPress={() => void handleSubmitCode()}
                loading={busy}
                disabled={otp.trim().length === 0 || busy}
                testID="onboarding-fallback-verify"
              />
            ) : null}
            <Button
              label="Generate one for me"
              onPress={handleGenerate}
              variant="secondary"
              disabled={busy}
              testID="onboarding-generate"
            />
            <Button
              label={fallback.kind === 'none' ? "This one's mine" : 'Try this device again'}
              onPress={() => void handleClaim()}
              loading={busy && fallback.kind === 'none'}
              variant={fallback.kind === 'none' ? 'primary' : 'secondary'}
              disabled={availability.kind !== 'available' || busy}
              testID="onboarding-continue"
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function indicatorMessage(s: AvailabilityState, handle: string): string {
  switch (s.kind) {
    case 'idle':
      return 'letters, numbers, dots, hyphens, underscores';
    case 'localInvalid':
      return invalidReason(handle);
    case 'reserved':
      return `that one's reserved`;
    case 'checking':
      return 'checking…';
    case 'available':
      return 'available';
    case 'taken':
      return 'already taken';
    case 'error':
      return 'could not check — retry in a moment';
  }
}

function invalidReason(handle: string): string {
  // Spec §2.3.1 — specific reason copy. We don't compute the full
  // Phase-3 menu yet (length / consecutive / edge separator); fold
  // them under one umbrella line for MVP. Phase 6 sweep can split.
  if (handle.length < 3) return 'at least 3 characters';
  if (handle.length > 20) return '20 characters max';
  if (/^[._-]|[._-]$/.test(handle)) return `can't start or end with a symbol`;
  if (/[._-]{2}/.test(handle)) return 'no double symbols';
  return 'letters, numbers, dots, hyphens, underscores only';
}

function availabilityColor(s: AvailabilityState) {
  if (s.kind === 'available') return { color: BONE };
  return { color: TEXT_MUTE };
}

function focusBorderFor(s: AvailabilityState) {
  if (s.kind === 'available') return { borderColor: BRASS };
  if (s.kind === 'taken' || s.kind === 'reserved' || s.kind === 'localInvalid') {
    return { borderColor: TEXT_MUTE };
  }
  return { borderColor: TEXT_FAINT };
}

/**
 * Shown when the device has NO secure lock — the fixable case. We detect
 * this directly via `isDeviceSecure()` (a lock is exactly the "passkey"
 * Vouchflow needs), so it's surfaced proactively before the biometric
 * prompt and paired with a "Set up screen lock" deep link. The email
 * fallback is offered alongside it, so a user who won't add a lock is
 * still never stuck.
 */
export const VERIFY_SETUP_HELP =
  'This device has no screen lock. Set up a PIN, pattern, or fingerprint/face unlock in your phone’s settings, then try again.';

/**
 * Shown when a lock IS present but verification still failed — i.e. the
 * device itself can't be attested (too old, modified/rooted, or missing
 * Google Play services). "Set up a lock" would be wrong here, so this
 * pairs with the email fallback instead.
 */
export const VERIFY_DEVICE_HELP =
  Platform.OS === 'ios'
    ? 'Couldn’t verify this device. It may be too old, jailbroken, or unable to complete a security check.'
    : 'Couldn’t verify this device. It may be too old, modified, or missing Google Play services.';

function messageForVouchflowError(reason: VouchflowErrorReason): string {
  switch (reason) {
    case 'biometric_cancelled':
      return 'Biometric prompt cancelled. Tap "This one\'s mine" to try again.';
    case 'biometric_failed':
      return 'Biometric check failed. Try again, or use another sign-in method.';
    case 'biometric_unavailable':
    case 'attestation_unavailable':
    case 'minimum_confidence_unmet':
      // No-lock is caught proactively before verify(), so reaching here
      // means a lock is present but the device still couldn't attest.
      return VERIFY_DEVICE_HELP;
    case 'network_unavailable':
      return `Can't reach the room. Try again.`;
    case 'enrollment_failed':
      return 'Device enrollment failed. We will retry on next launch.';
    default:
      return 'Verification failed. Please try again.';
  }
}

const BONE = workspace.dark.text;
const BRASS = accent.base;
const TEXT_MUTE = workspace.dark.textMute;
const TEXT_FAINT = workspace.dark.textFaint;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: brand.canvas },
  flex: { flex: 1 },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 48,
  },
  eyebrow: {
    fontFamily: font.medium,
    fontSize: 10,
    letterSpacing: 0.22 * 10,
    textTransform: 'uppercase',
    color: TEXT_MUTE,
    marginBottom: 24,
  },
  prefix: {
    fontFamily: font.medium,
    fontSize: 18,
    color: TEXT_MUTE,
    letterSpacing: -0.005 * 18,
    marginBottom: 12,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    borderBottomWidth: 1,
    paddingBottom: space.s,
    marginBottom: 8,
  },
  atGlyph: {
    fontFamily: font.bold,
    fontSize: 30,
    color: BRASS,
    lineHeight: 36,
  },
  input: {
    flex: 1,
    fontFamily: font.bold,
    fontSize: 30,
    color: BONE,
    letterSpacing: -0.035 * 30,
    padding: 0,
  },
  indicatorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 18,
    marginBottom: 16,
  },
  indicatorSquareBrass: { width: 6, height: 6, backgroundColor: BRASS },
  indicatorSquareMute: { width: 6, height: 6, backgroundColor: TEXT_MUTE },
  indicatorText: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
  },
  explainer: {
    fontFamily: font.regular,
    fontSize: 13,
    color: TEXT_MUTE,
    lineHeight: 1.5 * 13,
    maxWidth: 32 * 8,
  },
  bottom: { paddingHorizontal: 24, paddingBottom: 24, gap: 8 },
  fallbackBlock: { gap: 8 },
  fallbackHelp: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: TEXT_MUTE,
    lineHeight: 1.5 * typeScale.caption.size,
  },
  fallbackInput: {
    fontFamily: font.regular,
    fontSize: 18,
    color: BONE,
    borderBottomWidth: 1,
    borderColor: TEXT_FAINT,
    paddingVertical: space.s,
    padding: 0,
  },
  error: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: BONE,
  },
  buttonStack: { gap: 8 },
});
