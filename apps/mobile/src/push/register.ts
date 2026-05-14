import { api, pushNotifications } from '../services.js';
import { useSettings } from '../store/settings.js';
import { diag } from '../diag/log.js';

/**
 * Short-lived in-flight + recency cache to collapse the burst of
 * `tryRegisterPushToken` calls that fire on warm resume. App.tsx has
 * five call sites (post-recovery, post-launch-verify, on router
 * mount, on lifecycle change to `active`, plus the unconditional one
 * inside the same useEffect as the lifecycle subscription). On a
 * cold-but-already-authed launch, the router-mount call and the
 * lifecycle 'active' callback both fire within ~50ms of each other,
 * producing the duplicate `[push] registering token` log lines and
 * two redundant POSTs to /devices/push-token.
 *
 * rc.84 — bumped from 5s to 60s. The original 5s value was sized for
 * the cold-launch burst only. In rc.84 we also re-call this on every
 * WS `authed` frame to close the post-signup "no push_token on file"
 * window (see message-router's onAuthed). A WS reconnect can fire
 * within seconds of the cold-launch register (e.g. brief network blip
 * shortly after open), and an FCM token genuinely rotates on the
 * order of hours-to-days, not seconds, so 60s of dedupe is safe.
 * Settings toggles for notificationPrivacy that *want* an immediate
 * re-register can call __resetPushRegisterDedupForTests first or
 * accept the (worst-case) 60s delay before the new privacy mode
 * propagates to the server.
 */
type RegisterResult = 'registered' | 'no_token' | 'register_failed';
const DEDUP_WINDOW_MS = 60_000;
let inFlight: Promise<RegisterResult> | null = null;
let lastResult: { at: number; result: RegisterResult; deviceToken: string } | null = null;

/**
 * Try to register the device's FCM/APNs token with the server.
 *
 * Idempotent + safe to call repeatedly. We call this on:
 *   - App cold launch after enrollment
 *   - Every AppState `active` transition (handles the case where the
 *     user denied notifications during onboarding, then later granted
 *     via system Settings — we'd otherwise never re-fetch the token)
 *   - Immediately after Vouchflow identity recovery (closes the
 *     window where the server has the device record but no FCM token)
 *
 * rc.83 — bursts within `DEDUP_WINDOW_MS` collapse to a single call
 * via the module-level `inFlight` / `lastResult` cache. Without this,
 * cold-resume produced two simultaneous registrations (visible in
 * diagnostics as duplicate `[push] registering token` lines).
 *
 * Returns:
 *   - 'registered' if the token round-tripped to the server.
 *   - 'no_token'    if pushNotifications.getToken() returned null
 *                   (denied, Firebase unlinked, no Play Services, etc.).
 *                   `pushNotifications.lastFailureReason` carries the
 *                   specific branch.
 *   - 'register_failed' if the HTTP POST itself errored.
 */
export async function tryRegisterPushToken(
  deviceToken: string,
): Promise<RegisterResult> {
  if (inFlight) {
    return inFlight;
  }
  if (
    lastResult &&
    lastResult.deviceToken === deviceToken &&
    Date.now() - lastResult.at < DEDUP_WINDOW_MS
  ) {
    return lastResult.result;
  }
  inFlight = doRegisterPushToken(deviceToken);
  try {
    const result = await inFlight;
    lastResult = { at: Date.now(), result, deviceToken };
    return result;
  } finally {
    inFlight = null;
  }
}

/** Test-only: clear the dedupe cache between cases. */
export function __resetPushRegisterDedupForTests(): void {
  inFlight = null;
  lastResult = null;
}

async function doRegisterPushToken(deviceToken: string): Promise<RegisterResult> {
  const pushResult = await pushNotifications.getToken();
  if (!pushResult) {
    const reason =
      (pushNotifications as { lastFailureReason?: string }).lastFailureReason ??
      'unknown';
    diag('push', 'no token', { reason });
    // Report the failure to the server so we can diagnose "not receiving
    // push" reports without needing the user to check their diag log.
    void api.reportPushError(deviceToken, reason).catch(() => {
      /* best-effort */
    });
    return 'no_token';
  }
  const privacy = useSettings.getState().notificationPrivacy;
  diag('push', 'registering token', {
    platform: pushResult.platform,
    tokenPreview: pushResult.pushToken.slice(0, 8) + '…',
    privacy,
  });
  try {
    await api.registerPushToken(
      deviceToken,
      pushResult.pushToken,
      pushResult.platform,
      privacy,
    );
    diag('push', 'token registered');
    return 'registered';
  } catch (err) {
    diag('push', 'register failed', { err: String(err) });
    // Report the registration failure to the server.
    const reason = `register_failed: ${(err as Error).message ?? String(err)}`;
    void api.reportPushError(deviceToken, reason).catch(() => {
      /* best-effort */
    });
    return 'register_failed';
  }
}
