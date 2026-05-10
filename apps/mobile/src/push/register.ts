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
 *
 * The recurring "tester1 / noname has no push token registered"
 * pattern was bites of this gap: those users were on the cold-launch
 * code path that bailed at `pushResult === undefined` and never
 * retried, even after permission flipped to granted. rc.49 closes the
 * loop by re-running on every foreground.
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
    return 'register_failed';
  }
}
