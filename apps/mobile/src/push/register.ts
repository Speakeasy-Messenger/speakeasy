import { api, pushNotifications } from '../services.js';
import { useSettings } from '../store/settings.js';
import { diag } from '../diag/log.js';

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
): Promise<'registered' | 'no_token' | 'register_failed'> {
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
