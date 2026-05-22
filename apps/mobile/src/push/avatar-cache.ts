/**
 * On-disk cache of rasterized user avatars, for notifications.
 *
 * The app's avatars are `react-native-svg` animal portraits — there are
 * no image files. Android's MessagingStyle notification needs a bitmap
 * for each `Person`, and the headless push handler can't render SVG. So
 * the foreground app rasterizes peer avatars to PNGs here (see
 * `AvatarCacheWarmer`), and the headless handler reads them back.
 */

import RNFS from 'react-native-fs';

const CACHE_DIR = `${RNFS.DocumentDirectoryPath}/notif-avatars`;

/** Absolute PNG path for a user's cached avatar. */
export function avatarCachePath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${CACHE_DIR}/${safe}.png`;
}

/**
 * Avatar URI for notifee, or undefined when not cached yet.
 *
 * Returns a `data:image/png;base64,…` URI rather than a `file://` URI:
 * notifee's image loader silently drops `file://` URIs that live in
 * app-private storage (rc.117 alpha shipped with `file://` and every
 * MessagingStyle notification fell back to the launcher icon). Data
 * URIs are decoded directly by notifee's bitmap pipeline, no filesystem
 * access required, so the avatar actually lands on the notification.
 */
export async function cachedAvatarUri(userId: string): Promise<string | undefined> {
  const path = avatarCachePath(userId);
  try {
    if (!(await RNFS.exists(path))) return undefined;
    const base64 = await RNFS.readFile(path, 'base64');
    if (!base64) return undefined;
    return `data:image/png;base64,${base64}`;
  } catch {
    return undefined;
  }
}

/** Write a rasterized avatar PNG (base64, no data: prefix) to the cache. */
export async function writeAvatarPng(userId: string, base64: string): Promise<void> {
  if (!(await RNFS.exists(CACHE_DIR))) {
    await RNFS.mkdir(CACHE_DIR);
  }
  await RNFS.writeFile(avatarCachePath(userId), base64, 'base64');
}

/** Delete the whole avatar cache — used by account deletion. Best-effort. */
export async function clearAvatarCache(): Promise<void> {
  try {
    if (await RNFS.exists(CACHE_DIR)) {
      await RNFS.unlink(CACHE_DIR);
    }
  } catch {
    /* best-effort — a leftover cache dir is harmless */
  }
}
