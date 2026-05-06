import { Platform, PermissionsAndroid } from 'react-native';
import { CameraRoll } from '@react-native-camera-roll/camera-roll';
import RNFS from 'react-native-fs';
import type { Attachment } from '@speakeasy/shared';
import { diag } from '../diag/log.js';

/**
 * Auto-save inbound image/gif attachments to the device gallery,
 * WhatsApp-style. Files are skipped (no system "documents" gallery).
 * Best-effort — any error is swallowed and logged on Diagnostics.
 *
 * On Android <= 28 we need WRITE_EXTERNAL_STORAGE; on 29+ the
 * MediaStore API handles its own scoping. We try the runtime
 * permission once and proceed regardless — if denied, CameraRoll's
 * `save` will throw and we silently bail.
 */
export async function saveAttachmentsToGallery(attachments: Attachment[]): Promise<void> {
  const media = attachments.filter((a) => a.kind === 'image' || a.kind === 'gif');
  if (media.length === 0) return;

  if (Platform.OS === 'android' && Platform.Version <= 28) {
    try {
      // PermissionsAndroid is missing the runtime permission name on
      // some RN type stubs; cast through unknown so TS accepts it as a
      // `Permission` literal. WRITE_EXTERNAL_STORAGE is the right one
      // for legacy Android — Q+ uses scoped storage automatically.
      const writePerm = (PermissionsAndroid.PERMISSIONS as Record<string, string>)
        .WRITE_EXTERNAL_STORAGE as unknown as Parameters<
        typeof PermissionsAndroid.request
      >[0];
      if (writePerm) await PermissionsAndroid.request(writePerm);
    } catch {
      /* best-effort */
    }
  }

  for (const a of media) {
    try {
      // CameraRoll's `save` accepts file:// URIs. Write the base64
      // into a temp file first, then save → MediaStore. The temp
      // file gets cleaned up by the OS or on next cache prune.
      const ext = a.kind === 'gif' ? 'gif' : extensionFor(a.mime);
      const path = `${RNFS.CachesDirectoryPath}/sk_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}.${ext}`;
      await RNFS.writeFile(path, a.data, 'base64');
      await CameraRoll.save(`file://${path}`, {
        type: 'photo',
        album: 'Speakeasy',
      });
      diag('gallery', 'saved attachment', { kind: a.kind, mime: a.mime });
    } catch (err) {
      diag('gallery', 'save FAILED (non-fatal)', {
        kind: a.kind,
        err: String(err),
      });
    }
  }
}

function extensionFor(mime: string): string {
  if (mime.includes('jpeg')) return 'jpg';
  if (mime.includes('png')) return 'png';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  return 'bin';
}
