import { Alert, Platform } from 'react-native';
import RNFS from 'react-native-fs';
import type { Attachment } from '@speakeasy/shared';
import { diag, diagFingerprint } from '../diag/log.js';
import { openSavedFile } from '../native/file-opener.js';

/**
 * Tap-to-open for files received in chat. Writes the decoded attachment
 * to app-owned storage first, then opens it through a native
 * content-URI/share flow. The saved-path alert is a fallback only.
 */
export async function saveAndAnnounceFile(attachment: Attachment): Promise<void> {
  const name = sanitizeFilename(attachment.name ?? `speakeasy-file-${Date.now()}`);

  // Pick a directory that's always writable.
  // - Android: ExternalDirectoryPath  → /storage/emulated/0/Android/data/<pkg>/files
  //   This is app-specific external storage: always writable, survives
  //   app restart, and is visible in the OS Files app under the app's
  //   entry.  Scoped storage (API 29+) does NOT block writes here.
  //   The public DownloadDirectoryPath is NOT writable on API 29+,
  //   which was the source of the ENOENT bug.
  // - iOS: DocumentDirectoryPath → always writable.
  const baseDir =
    Platform.OS === 'android'
      ? RNFS.ExternalDirectoryPath
      : RNFS.DocumentDirectoryPath;

  // Ensure the directory exists (first save on a fresh install may not
  // have created it yet).
  const dirExists = await RNFS.exists(baseDir).catch(() => false);
  if (!dirExists) {
    await RNFS.mkdir(baseDir);
  }

  const dest = `${baseDir}/${name}`;

  try {
    await RNFS.writeFile(dest, attachment.data, 'base64');

    // Android: attempt to scan the file into the MediaStore so it
    // appears in the Files app immediately. Best-effort; not all
    // RNFS versions expose scanFile.
    if (Platform.OS === 'android' && typeof RNFS.scanFile === 'function') {
      try {
        await RNFS.scanFile(dest);
      } catch (_) {
        /* not all RN versions expose this — ignore */
      }
    }

    diag('attach', 'file saved', { nameFp: diagFingerprint(name) });
    try {
      await openSavedFile(dest, attachment.mime || '*/*');
      diag('attach', 'file open launched', { nameFp: diagFingerprint(name), mime: attachment.mime });
    } catch (err) {
      diag('attach', 'file open failed', { err: String(err), nameFp: diagFingerprint(name) });
      const where =
        Platform.OS === 'android'
          ? 'Android › data › Speakeasy › files'
          : 'On My iPhone › Speakeasy';
      Alert.alert(
        'Saved',
        `${name} was saved to ${where}, but no app could be opened for it.`,
      );
    }
  } catch (err) {
    diag('attach', 'file save failed', { err: String(err) });
    Alert.alert('Could not save', String((err as Error)?.message ?? err));
  }
}

/** Strip path separators and control chars; keep extension. */
function sanitizeFilename(name: string): string {
  return name.replace(/[\\/\x00-\x1f]/g, '_').slice(0, 200);
}
