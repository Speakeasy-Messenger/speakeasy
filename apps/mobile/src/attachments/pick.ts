import { launchImageLibrary } from 'react-native-image-picker';
import DocumentPicker from 'react-native-document-picker';
import RNFS from 'react-native-fs';
import type { Attachment } from '@speakeasy/shared';

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
  for (const a of result.assets) {
    if (!a.base64) continue;
    if ((a.fileSize ?? 0) > PHOTO_MAX_BYTES) continue;
    out.push({
      kind: 'image',
      mime: a.type ?? 'image/jpeg',
      data: a.base64,
    });
  }
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
    if ((result.size ?? 0) > FILE_MAX_BYTES) return null;
    const path = (result.fileCopyUri ?? result.uri).replace('file://', '');
    const data = await RNFS.readFile(path, 'base64');
    return {
      kind: 'file',
      mime: result.type ?? 'application/octet-stream',
      data,
      name: result.name ?? 'file',
    };
  } catch (err) {
    // DocumentPicker throws on cancel — swallow it.
    if (DocumentPicker.isCancel(err)) return null;
    throw err;
  }
}
