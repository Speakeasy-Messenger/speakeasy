import { PermissionsAndroid, Platform } from 'react-native';
import { diag } from '../diag/log.js';

/**
 * Request the runtime permissions Speakeasy needs to function smoothly.
 *
 * - POST_NOTIFICATIONS (Android 13+) — push notifications. Without it,
 *   FCM-delivered banners are silently dropped (rc.27→rc.32 reproducer).
 * - CAMERA — video calls + the chat composer's "Camera" attachment
 *   button. Without it, getUserMedia({ video: true }) silently fails.
 * - RECORD_AUDIO — voice + video calls. The first call would otherwise
 *   raise the system prompt mid-dial; pre-asking at onboarding keeps
 *   that moment clean.
 *
 * Idempotent: the OS only shows a prompt for permissions the user
 * hasn't decided on yet. Already-granted = no-op; already-denied =
 * no-op (the OS suppresses the second ask after the user picked
 * "Don't ask again"). Safe to call at app launch + at the end of
 * onboarding.
 */
export async function requestStartupPermissions(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const perms: Array<{ name: string; key: string }> = [];
  const P = PermissionsAndroid.PERMISSIONS as Record<string, string | undefined>;
  if (Platform.Version >= 33 && P.POST_NOTIFICATIONS) {
    perms.push({ name: 'notifications', key: P.POST_NOTIFICATIONS });
  }
  if (P.CAMERA) perms.push({ name: 'camera', key: P.CAMERA });
  if (P.RECORD_AUDIO) perms.push({ name: 'mic', key: P.RECORD_AUDIO });

  for (const p of perms) {
    try {
      const already = await PermissionsAndroid.check(
        p.key as Parameters<typeof PermissionsAndroid.check>[0],
      );
      if (already) {
        diag('perm', `${p.name}: already granted`);
        continue;
      }
      const result = await PermissionsAndroid.request(
        p.key as Parameters<typeof PermissionsAndroid.request>[0],
      );
      diag('perm', `${p.name}: requested`, { result });
    } catch (err) {
      diag('perm', `${p.name}: request threw (continuing)`, {
        err: String(err),
      });
    }
  }
}
