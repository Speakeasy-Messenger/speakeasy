import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { EmailFallbackError, startEmailFallback } from '../auth/claim-handle.js';
import type { FallbackReason, VouchflowClient } from '../native/vouchflow.js';
import { font, space, type as typeScale } from '../theme/tokens.js';

/**
 * The email-send + code-entry UI shared by every device-verification
 * surface that can't dead-end a passkey-less device: onboarding
 * (`HandleStep`), the returning-user verify gate, and the monthly
 * re-verify sheet. Lifted out of `HandleStep.tsx`, which owned the only
 * copy of this flow before the other two surfaces could offer it.
 *
 * Owns the two-step (email → code) state machine and the network calls
 * that are the same everywhere (`startEmailFallback`); `onSubmit` is the
 * one piece that differs per surface (onboarding also enrolls a handle,
 * the gate/sheet just need the token) so it's left to the caller.
 *
 * Visual frame is intentionally NOT owned here — `colors` and
 * `renderButton` let each screen keep its own theme (brand-canvas dark
 * for onboarding/the gate, the themed light/dark sheet for the monthly
 * re-verify) and its own button chrome, matching BRANDING1.md per
 * surface rather than inventing a fourth look.
 */

export type EmailVerifyFallbackStep =
  | { kind: 'email' }
  | { kind: 'otp'; sessionId: string; email: string };

export interface EmailVerifyFallbackButtonProps {
  step: 'email' | 'otp';
  label: string;
  onPress: () => void;
  disabled: boolean;
  loading: boolean;
  testID: string;
}

export interface EmailVerifyFallbackProps {
  /** Why the passkey/attestation path couldn't complete — forwarded to Vouchflow. */
  reason: FallbackReason;
  vouchflow: VouchflowClient;
  /**
   * Called once the user submits a code. Resolve to finish — the caller
   * completes the claim/verify and unmounts this component. Reject with
   * `EmailFallbackError` (or any Error) to show an inline message and
   * let the user retry the code.
   */
  onSubmit: (args: { sessionId: string; otp: string }) => Promise<void>;
  colors: { text: string; muted: string; faint: string };
  renderButton: (button: EmailVerifyFallbackButtonProps) => React.ReactNode;
  /** testID namespace — e.g. `onboarding-fallback`, `verify-gate-fallback`. */
  testIDPrefix: string;
  /** Defaults to the copy every surface already shows for this step. */
  helpText?: string;
  /** Mirrors the internal busy flag so the host screen can disable its
   * own controls (e.g. the handle field) while a request is in flight —
   * matches the pre-extraction onboarding behavior of sharing one busy
   * flag across the whole screen. */
  onBusyChange?: (busy: boolean) => void;
}

export function EmailVerifyFallback({
  reason,
  vouchflow,
  onSubmit,
  colors,
  renderButton,
  testIDPrefix,
  helpText = DEFAULT_HELP_TEXT,
  onBusyChange,
}: EmailVerifyFallbackProps): React.ReactElement {
  const [step, setStep] = useState<EmailVerifyFallbackStep>({ kind: 'email' });
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState<string | undefined>();

  function setBusy(next: boolean) {
    setBusyState(next);
    onBusyChange?.(next);
  }

  async function handleRequestCode() {
    setBusy(true);
    setError(undefined);
    try {
      const { sessionId } = await startEmailFallback({ vouchflow }, { email, reason });
      setOtp('');
      setStep({ kind: 'otp', sessionId, email: email.trim() });
    } catch (err) {
      if (err instanceof EmailFallbackError && err.reason === 'invalid_email') {
        setError('That does not look like an email address.');
      } else {
        setError("Couldn't send the code. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmitCode() {
    if (step.kind !== 'otp') return;
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit({ sessionId: step.sessionId, otp });
    } catch (err) {
      if (err instanceof EmailFallbackError && err.reason === 'otp_rejected') {
        setError('That code did not match. Check the email and try again.');
      } else {
        setError("Couldn't verify that code. Try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.block}>
      <Text style={[styles.help, { color: colors.muted }]}>
        {step.kind === 'email' ? helpText : `We sent a code to ${step.email}. Enter it to finish.`}
      </Text>
      {step.kind === 'email' ? (
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          editable={!busy}
          style={[styles.input, { color: colors.text, borderColor: colors.faint }]}
          testID={`${testIDPrefix}-email`}
        />
      ) : (
        <TextInput
          value={otp}
          onChangeText={(t) => setOtp(t.replace(/[^0-9a-zA-Z]/g, '').slice(0, 8))}
          placeholder="123456"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="number-pad"
          editable={!busy}
          style={[styles.input, { color: colors.text, borderColor: colors.faint }]}
          testID={`${testIDPrefix}-otp`}
        />
      )}
      {error ? (
        <Text style={[styles.error, { color: colors.text }]} testID={`${testIDPrefix}-error`}>
          {error}
        </Text>
      ) : null}
      {step.kind === 'email'
        ? renderButton({
            step: 'email',
            label: 'Email me a code',
            onPress: () => void handleRequestCode(),
            disabled: email.trim().length === 0 || busy,
            loading: busy,
            testID: `${testIDPrefix}-request`,
          })
        : renderButton({
            step: 'otp',
            label: 'Verify code',
            onPress: () => void handleSubmitCode(),
            disabled: otp.trim().length === 0 || busy,
            loading: busy,
            testID: `${testIDPrefix}-verify`,
          })}
    </View>
  );
}

export const DEFAULT_HELP_TEXT =
  'Or verify by email instead. We only use it to send this one code — it is not attached to your handle.';

const styles = StyleSheet.create({
  block: { gap: space.s },
  help: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
    lineHeight: 1.5 * typeScale.caption.size,
  },
  input: {
    fontFamily: font.regular,
    fontSize: 18,
    borderBottomWidth: 1,
    paddingVertical: space.s,
    padding: 0,
  },
  error: {
    fontFamily: font.regular,
    fontSize: typeScale.caption.size,
  },
});
