import { Alert, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type { Attachment } from '@speakeasy/shared';
import { diag } from '../diag/log.js';

/**
 * Tap-to-open for files received in chat.
 *
 * Android scoped storage + RN's lack of FileProvider plumbing makes
 * launching an external viewer with a `content://` URI impractical
 * without adding a native dep. The pragmatic alpha behaviour: copy
 * the bytes into the device's public Downloads folder so the user can
 * find the file in their Files app, and surface the destination via
 * an Alert. The OS Files app handles the "open with…" picker from
 * there.
 *
 * On iOS, the public Downloads dir doesn't exist; we write to the
 * app's Documents dir and tell the user to open the Files app.
 */
export async function saveAndAnnounceFile(attachment: Attachment): Promise<void> {
  const name = sanitizeFilename(attachment.name ?? `speakeasy-file-${Date.now()}`);
  const baseDir =
    Platform.OS === 'android'
      ? RNFS.DownloadDirectoryPath
      : RNFS.DocumentDirectoryPath;
  const dest = `${baseDir}/${name}`;

  try {
    await RNFS.writeFile(dest, attachment.data, 'base64');
    // Make Android's media store / Files app see the new file
    // immediately. Best-effort; failures are silent.
    if (Platform.OS === 'android' && typeof RNFS.scanFile === 'function') {
      try {
        await RNFS.scanFile(dest);
      } catch (_) {
        /* not all RN versions expose this — ignore */
      }
    }
    diag('attach', 'file saved', { name, dest });
    const where = Platform.OS === 'android' ? 'Downloads' : 'On My iPhone › Speakeasy';
    Alert.alert(
      'Saved',
      `${name} was saved to ${where}. Open it from your Files app.`,
    );
  } catch (err) {
    diag('attach', 'file save failed', { err: String(err) });
    Alert.alert('Could not save', String((err as Error)?.message ?? err));
  }
}

/** Strip path separators and control chars; keep extension. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200);
}
