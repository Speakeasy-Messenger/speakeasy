import { PermissionsAndroid, Platform } from 'react-native';
import { diag } from '../diag/log.js';

/**
 * Notifications permission catch-up at app launch.
 *
 * POST_NOTIFICATIONS (Android 13+) has no natural moment-of-use the
 * way mic and camera do (the only signal that "you'd want a banner
 * right now" is a banner trying to fire — too late), so it stays as
 * an upfront ask: surfaced once in onboarding (rc.50+: `PermissionsStep`
 * row) and re-checked on every launch in case a prior install never
 * saw the dedicated step.
 *
 * Mic and camera moved to just-in-time prompts as of rc.51 — see
 * `permissions/runtime.ts`. The user gets asked at the moment they
 * make a call (mic) or send a photo / start a video call (camera),
 * which both reads better and yields higher grant rates.
 *
 * Idempotent: OS suppresses the prompt for any permission already
 * decided on, so this is safe to call every launch.
 */
export async function requestStartupPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (Platform.Version < 33) return;
  const perm = (PermissionsAndroid.PERMISSIONS as Record<string, string | undefined>)
    .POST_NOTIFICATIONS;
  if (!perm) return;
  try {
    const already = await PermissionsAndroid.check(
      perm as Parameters<typeof PermissionsAndroid.check>[0],
    );
    if (already) {
      diag('perm', 'notifications: already granted');
      return;
    }
    const result = await PermissionsAndroid.request(
      perm as Parameters<typeof PermissionsAndroid.request>[0],
    );
    diag('perm', 'notifications: requested', { result });
  } catch (err) {
    diag('perm', 'notifications: request threw (continuing)', {
      err: String(err),
    });
  }
}
