import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { validateHandle } from '@speakeasy/shared';
import { Button } from '../../components/Button.js';
import { useSettings } from '../../store/settings.js';
import { api, signalProtocol, vouchflow, pushNotifications } from '../../services.js';
import { ApiError } from '../../api/client.js';
import { VouchflowClientError, type VouchflowErrorReason } from '../../native/vouchflow.js';
import { SignalClientError } from '@speakeasy/crypto';
import { brand, font, type as typeScale } from '../../theme/tokens.js';
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
 *
 * Identity-key generation is kicked off in step 02; this screen calls
 * `signalProtocol.generateIdentityKey()` again — the native module is
 * idempotent and returns the same SQLCipher-backed key, so the
 * second call is cheap.
 */

const PREKEY_BATCH_SIZE = 100;
function randomRegistrationId(): number {
  return 1 + Math.floor(Math.random() * 16380);
}

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
    try {
      const verifyResult = await Promise.race([
        vouchflow.verify({ context: 'signup', minimumConfidence: 'medium' }),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new VouchflowClientError('biometric_unavailable', 'Timeout: verify did not complete in 60s')),
            60_000,
          ),
        ),
      ]);
      const deviceToken = verifyResult.deviceToken;
      const identityPublicKey = await signalProtocol.generateIdentityKey();
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

      // Best-effort push token registration. Same path as the legacy
      // OnboardingScreen; deferred to a fire-and-forget so we don't
      // gate the Face step on FCM availability.
      void (async () => {
        try {
          const pushResult = await pushNotifications.getToken();
          if (pushResult) {
            await api.registerPushToken(
              deviceToken,
              pushResult.pushToken,
              pushResult.platform,
              useSettings.getState().notificationPrivacy,
            );
          }
        } catch {
          /* non-fatal */
        }
      })();

      onClaimed({ userId: user_id, deviceToken });
    } catch (err: unknown) {
      const errAny = err as { cause?: unknown; stack?: string };
      diag('onboarding', 'claim failed', {
        msg: err instanceof Error ? err.message : String(err),
        cause: String(errAny?.cause ?? ''),
      });
      const msg = err instanceof Error ? err.message : String(err);
      const name = err instanceof Error ? err.name : 'Error';
      if (err instanceof VouchflowClientError) {
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
          <View style={styles.buttonStack}>
            <Button
              label="Generate one for me"
              onPress={handleGenerate}
              variant="secondary"
              disabled={busy}
              testID="onboarding-generate"
            />
            <Button
              label="This one's mine"
              onPress={() => void handleClaim()}
              loading={busy}
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

function messageForVouchflowError(reason: VouchflowErrorReason): string {
  switch (reason) {
    case 'biometric_cancelled':
      return 'Biometric prompt cancelled. Tap "This one\'s mine" to try again.';
    case 'biometric_failed':
      return 'Biometric check failed. Try again, or use another sign-in method.';
    case 'biometric_unavailable':
      return 'Biometric authentication is not set up on this device.';
    case 'minimum_confidence_unmet':
      return 'This device cannot be verified yet. Please try again later.';
    case 'network_unavailable':
      return `Can't reach the room. Try again.`;
    case 'enrollment_failed':
      return 'Device enrollment failed. We will retry on next launch.';
    default:
      return 'Verification failed. Please try again.';
  }
}

const BONE = '#F2E9D8';
const BRASS = '#E5A645';
const TEXT_MUTE = 'rgba(242,233,216,0.55)';
const TEXT_FAINT = 'rgba(242,233,216,0.12)';

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
    paddingBottom: 6,
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
  error: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    color: BONE,
  },
  buttonStack: { gap: 8 },
});
