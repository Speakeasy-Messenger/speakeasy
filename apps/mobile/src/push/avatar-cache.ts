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
import { diag } from '../diag/log.js';

const CACHE_DIR = `${RNFS.DocumentDirectoryPath}/notif-avatars`;

/**
 * Authority of the FileProvider declared in AndroidManifest.xml. Used
 * to compose `content://` URIs for notifee — both `file://` URIs (in
 * app-private storage) and `data:` URIs were silently dropped by
 * notifee's Fresco-backed image loader, leaving every MessagingStyle
 * notification falling back to the launcher icon. `content://` URIs
 * served through the FileProvider go through Fresco's content
 * resolver path, which actually loads the bitmap.
 */
const FILE_PROVIDER_AUTHORITY = 'xyz.speakeasyapp.app.fileprovider';
/**
 * Matches `<files-path name="speakeasy_internal_files" path="." />` in
 * res/xml/file_paths.xml — the URI segment that maps to the app's
 * internal `files/` directory.
 */
const FILE_PROVIDER_FILES_ROOT = 'speakeasy_internal_files';

/** Absolute PNG path for a user's cached avatar. */
export function avatarCachePath(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${CACHE_DIR}/${safe}.png`;
}

/**
 * Avatar URI for notifee, or undefined when not cached yet.
 *
 * Returns a `content://` URI through the app's FileProvider. The two
 * earlier approaches both lost the avatar to a launcher-icon fallback:
 *  - `file://` URIs (rc.117) — notifee's Fresco-backed image pipeline
 *    silently dropped them when pointed at app-private storage.
 *  - `data:image/png;base64,…` URIs (rc.118-rc.122) — same outcome;
 *    Fresco's data-URI handler in the bundled core build didn't decode
 *    the payload reliably either.
 * Content URIs go through Fresco's content-resolver path, which
 * actually loads the bitmap and surfaces the peer's portrait on the
 * MessagingStyle notification. FileProvider is already declared in
 * AndroidManifest.xml; no native changes needed.
 */
export async function cachedAvatarUri(userId: string): Promise<string | undefined> {
  const path = avatarCachePath(userId);
  try {
    if (!(await RNFS.exists(path))) {
      diag('avatar-cache', 'no cached file for userId', { userId });
      return undefined;
    }
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const uri = `content://${FILE_PROVIDER_AUTHORITY}/${FILE_PROVIDER_FILES_ROOT}/notif-avatars/${safe}.png`;
    return uri;
  } catch (err) {
    diag('avatar-cache', 'cachedAvatarUri failed', { userId, err: String(err) });
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
