import { launchCamera, launchImageLibrary } from 'react-native-image-picker';
import { Alert } from 'react-native';
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import type { Attachment } from '@speakeasy/shared';
import { ensureCameraPermission } from '../permissions/runtime.js';

/**
 * Per-attachment caps. Multi-select photo grids stack on top of each
 * other so even a 3-photo album can hit ~600KB on the wire after
 * base64 — keep individual photos slim.
 */
const PHOTO_MAX_W = 1024;
const PHOTO_MAX_H = 1024;
const PHOTO_QUALITY = 0.7;
const PHOTO_MAX_BYTES = 800_000; // pre-base64

const GIF_MAX_BYTES = 1_000_000;
const FILE_MAX_BYTES = 800_000;

function base64Bytes(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

export function readablePathFromDocumentUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const path = uri.slice('file://'.length);
  try {
    return path
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return path;
  }
}

function showFileTooLargeAlert(): void {
  Alert.alert(
    'File is too large',
    'Speakeasy can send files up to 800 KB in this build.',
  );
}

function showPhotoTooLargeAlert(): void {
  Alert.alert(
    'Photo is too large',
    'Speakeasy can send photos up to 800 KB in this build.',
  );
}

/**
 * Multi-select photos. The image-picker's `selectionLimit > 0` lets
 * the user grab N photos in one go; we resize each to the caps above
 * and base64-encode the data. Returns an empty array if the user
 * cancelled or selection failed. GIFs picked here pass through the
 * resize path and lose their animation — tell users to use the GIF
 * picker for animated content.
 */
export async function pickPhotos(opts: { selectionLimit?: number } = {}): Promise<Attachment[]> {
  const result = await launchImageLibrary({
    mediaType: 'photo',
    maxWidth: PHOTO_MAX_W,
    maxHeight: PHOTO_MAX_H,
    quality: PHOTO_QUALITY,
    includeBase64: true,
    selectionLimit: opts.selectionLimit ?? 0, // 0 = unlimited (per iOS), Android picks via system picker
  });
  if (result.didCancel || !result.assets) return [];
  const out: Attachment[] = [];
  let skippedOversize = false;
  for (const a of result.assets) {
    if (!a.base64) continue;
    if (base64Bytes(a.base64) > PHOTO_MAX_BYTES) {
      skippedOversize = true;
      continue;
    }
    out.push({
      kind: 'image',
      mime: a.type ?? 'image/jpeg',
      data: a.base64,
    });
  }
  if (out.length === 0 && skippedOversize) showPhotoTooLargeAlert();
  return out;
}

/**
 * Single GIF. The picker's resize options are skipped (would break
 * animation); we read the raw bytes via `react-native-fs` and base64
 * them. Cap at 1MB.
 */
export async function pickGif(): Promise<Attachment | null> {
  const result = await launchImageLibrary({
    mediaType: 'photo',
    includeBase64: false,
    selectionLimit: 1,
  });
  if (result.didCancel || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  if (!asset.uri) return null;
  // Filter on actual MIME — image-picker's `photo` mode can return
  // jpeg too; we only want gifs here.
  const mime = asset.type ?? '';
  if (!mime.includes('gif')) return null;
  if ((asset.fileSize ?? 0) > GIF_MAX_BYTES) return null;
  const data = await RNFS.readFile(asset.uri.replace('file://', ''), 'base64');
  return { kind: 'gif', mime: 'image/gif', data };
}

/**
 * Take a photo with the device camera. Same resize/quality envelope
 * as `pickPhotos` so an in-the-moment camera shot ends up roughly the
 * same size on the wire as a gallery photo. Returns `null` on cancel
 * or when the camera is unavailable.
 */
export async function pickFromCamera(): Promise<Attachment | null> {
  // Just-in-time camera permission — first time the user taps the
  // Camera attachment button. On denial, the helper has already
  // shown the Open Settings alert if applicable; return null so the
  // chat screen treats it the same as a cancel.
  const cam = await ensureCameraPermission();
  if (cam !== 'granted') return null;
  const result = await launchCamera({
    mediaType: 'photo',
    maxWidth: PHOTO_MAX_W,
    maxHeight: PHOTO_MAX_H,
    quality: PHOTO_QUALITY,
    includeBase64: true,
    saveToPhotos: true,
  });
  if (result.didCancel || !result.assets?.[0]) return null;
  const asset = result.assets[0];
  if (!asset.base64) return null;
  if (base64Bytes(asset.base64) > PHOTO_MAX_BYTES) {
    showPhotoTooLargeAlert();
    return null;
  }
  return {
    kind: 'image',
    mime: asset.type ?? 'image/jpeg',
    data: asset.base64,
  };
}

/**
 * Single file (non-image). Document picker — no resize, base64 the
 * raw bytes. Cap at 800KB.
 */
export async function pickFile(): Promise<Attachment | null> {
  try {
    const result = await DocumentPicker.pickSingle({
      type: [DocumentPicker.types.allFiles],
      copyTo: 'cachesDirectory',
    });
    if (!result.fileCopyUri && !result.uri) return null;
    if ((result.size ?? 0) > FILE_MAX_BYTES) {
      showFileTooLargeAlert();
      return null;
    }
    const path = readablePathFromDocumentUri(result.fileCopyUri ?? result.uri);
    const data = await RNFS.readFile(path, 'base64');
    // Some Android providers omit `size` or report the pre-copy size
    // unreliably. Enforce the wire budget on the bytes we actually read
    // so large files do not fail later during encryption or WS send.
    if (base64Bytes(data) > FILE_MAX_BYTES) {
      showFileTooLargeAlert();
      return null;
    }
    return {
      kind: 'file',
      mime: result.type ?? 'application/octet-stream',
      data,
      name: result.name ?? 'file',
    };
  } catch (err) {
    // DocumentPicker throws on cancel — swallow it.
    if (DocumentPicker.isCancel(err)) return null;
    Alert.alert(
      'Could not attach file',
      String((err as Error)?.message ?? err),
    );
    return null;
  }
}
