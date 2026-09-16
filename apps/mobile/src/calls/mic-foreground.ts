import { Platform } from 'react-native';
import type { CallKind } from '@speakeasy/shared';
import { diag, diagImportant } from '../diag/log.js';
import { audioDiagnostics } from '../native/audio-diagnostics.js';
import { showOngoingCallNotification } from './call-notification.js';

/**
 * The mic-foreground-service capture gate.
 *
 * Android 14+ "while-in-use" privacy enforcement: when AudioRecord capture
 * STARTS while the app is backgrounded and no `microphone`-typed foreground
 * service is active, the OS hands the app a permanently-muted capture
 * stream — zeros for the whole session, never recovering, even after the
 * app returns to the foreground. Repro: call-01M2N41QF1P7BE6HSWR152SMRG
 * (diag build v1.0.74-rc.2) — the caller backgrounded during outgoing
 * ringing, capture initialized ~4s later still backgrounded,
 * microphoneForegroundService:false, and every capture sample for the call
 * was peak:0 / rms:0 while outbound RTP kept flowing (silence packets).
 *
 * Contract (load-bearing — see orchestrator.ts startOutgoing/accept):
 *   1. The notifee microphone FGS ("voice-call pill") is started BEFORE any
 *      AudioRecord capture begins for the call — outgoing dial AND incoming
 *      accept, all kinds (video included; PiP does not satisfy while-in-use).
 *   2. The service is CONFIRMED active via the native ActivityManager check
 *      (`audioDiagnostics.isMicrophoneForegroundServiceActive`) before the
 *      gate resolves — starting it is not enough, Android can silently drop
 *      a background FGS start.
 *   3. If the FGS cannot be confirmed within the deadline, the gate returns
 *      false and the orchestrator ends the call instead of capturing — a
 *      muted-forever mic call is worse than a failed one.
 *
 * Confirmation is a poll (the FGS transitions asynchronously after the
 * notification posts); the deadline bounds the added dial/accept latency.
 *
 * Steps 2 and 3 apply from API 30 up only (MIC_FGS_MIN_API_LEVEL). The
 * `microphone` foreground-service type and the while-in-use capture muting
 * it satisfies were both introduced in Android 11; on API 28/29 (minSdk is
 * 28) there is nothing to confirm — ActivityManager cannot report a
 * microphone FGS there at all, so requiring confirmation would time out and
 * fail every call on a platform the bug cannot occur on. The pill is still
 * started there; only the confirm-or-refuse contract is skipped.
 */
export const MIC_FGS_CONFIRM_TIMEOUT_MS = 4_000;
export const MIC_FGS_POLL_INTERVAL_MS = 150;
/** First Android API level with a `microphone` foreground-service type. */
export const MIC_FGS_MIN_API_LEVEL = 30;

export interface MicForegroundGateCall {
  callId: string;
  peerUserId: string;
  kind: CallKind;
}

/** Sleep helper (injectable via fake timers in tests). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start the microphone FGS and wait until it is confirmed foreground.
 * Resolves true only when a microphone FGS is verifiably active; false
 * otherwise (start threw, wrong platform state, confirmation timed out).
 * Non-Android resolves true immediately (CallKit owns the audio session),
 * as does Android below MIC_FGS_MIN_API_LEVEL.
 *
 * The pill start is deliberately the SAME notification the ongoing-call
 * pill uses (`call-notification.ts`): one id, idempotent, and the pill UI
 * falls out of the FGS for free. Video calls now get the pill too — it is
 * the FGS carrier the mic gate requires, not a UI choice.
 */
export async function ensureMicForegroundService(call: MicForegroundGateCall): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  // An unknown/NaN version confirms rather than skipping — fail closed.
  const confirmationRequired = !(Number(Platform.Version) < MIC_FGS_MIN_API_LEVEL);
  try {
    await showOngoingCallNotification({
      peerHandle: call.peerUserId,
      micMuted: false,
      kind: call.kind,
    });
  } catch (err) {
    diagImportant('call', 'mic fgs: start failed — capture gate closed', {
      callId: call.callId,
      confirmationRequired,
      err: String(err),
    });
    return !confirmationRequired;
  }
  if (!confirmationRequired) {
    diag('call', 'mic fgs: confirmation not required below API level', {
      callId: call.callId,
      apiLevel: Platform.Version,
      minApiLevel: MIC_FGS_MIN_API_LEVEL,
    });
    return true;
  }
  const deadline = Date.now() + MIC_FGS_CONFIRM_TIMEOUT_MS;
  let confirmed: boolean | null = null;
  while (Date.now() < deadline) {
    confirmed = await audioDiagnostics.isMicrophoneForegroundServiceActive();
    if (confirmed === true) {
      diag('call', 'mic fgs: confirmed active before capture', { callId: call.callId });
      return true;
    }
    await sleep(MIC_FGS_POLL_INTERVAL_MS);
  }
  diagImportant('call', 'mic fgs: NOT confirmed before capture deadline', {
    callId: call.callId,
    lastCheck: confirmed,
    timeoutMs: MIC_FGS_CONFIRM_TIMEOUT_MS,
  });
  return false;
}
