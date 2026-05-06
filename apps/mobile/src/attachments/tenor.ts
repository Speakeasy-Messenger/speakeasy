import RNFS from 'react-native-fs';
import type { Attachment } from '@speakeasy/shared';
import { diag } from '../diag/log.js';

/**
 * Tenor v2 client. Returns trending or search results, then downloads
 * the chosen GIF and base64-encodes it for the message envelope.
 *
 * The `LIVDSRZULELA` API key is Google's documented public-test key
 * for Tenor — no quota for alpha-volume traffic, fine for a sandbox
 * release. A prod key (rate-limited per app) would slot in here when
 * we ship outside alpha.
 */
const TENOR_API_KEY = 'LIVDSRZULELA';
const TENOR_BASE = 'https://tenor.googleapis.com/v2';

export interface TenorGifSummary {
  id: string;
  /** Short preview/thumbnail URL — small enough to render in a grid. */
  previewUrl: string;
  /** Full-quality GIF URL — fetched + encoded only on selection. */
  gifUrl: string;
  /** Pixel width of the preview (for grid aspect ratio). */
  width: number;
  height: number;
}

interface TenorMediaFormats {
  tinygif?: { url: string; dims: [number, number] };
  nanogif?: { url: string; dims: [number, number] };
  gif?: { url: string; dims: [number, number] };
  mediumgif?: { url: string; dims: [number, number] };
}

interface TenorResult {
  id: string;
  media_formats: TenorMediaFormats;
}

/** Fetch the Tenor "featured" (trending) feed. */
export async function fetchTenorTrending(): Promise<TenorGifSummary[]> {
  return fetchTenor(`${TENOR_BASE}/featured?key=${TENOR_API_KEY}&limit=24&media_filter=tinygif,gif`);
}

export async function fetchTenorSearch(query: string): Promise<TenorGifSummary[]> {
  const q = encodeURIComponent(query.trim());
  return fetchTenor(
    `${TENOR_BASE}/search?key=${TENOR_API_KEY}&q=${q}&limit=24&media_filter=tinygif,gif`,
  );
}

async function fetchTenor(url: string): Promise<TenorGifSummary[]> {
  try {
    const r = await fetch(url);
    if (!r.ok) {
      diag('tenor', 'http error', { status: r.status });
      return [];
    }
    const j = (await r.json()) as { results?: TenorResult[] };
    const results = j.results ?? [];
    return results
      .map((res) => {
        const tiny = res.media_formats.tinygif ?? res.media_formats.nanogif;
        const full = res.media_formats.gif ?? res.media_formats.mediumgif;
        if (!tiny || !full) return null;
        return {
          id: res.id,
          previewUrl: tiny.url,
          gifUrl: full.url,
          width: tiny.dims[0],
          height: tiny.dims[1],
        } satisfies TenorGifSummary;
      })
      .filter((g): g is TenorGifSummary => g !== null);
  } catch (err) {
    diag('tenor', 'fetch failed', { err: String(err) });
    return [];
  }
}

/**
 * Download a GIF and produce an `Attachment` ready to embed in the
 * message envelope. Goes through RNFS so we get base64 without
 * needing a binary-to-base64 polyfill on Hermes.
 */
export async function downloadTenorGif(summary: TenorGifSummary): Promise<Attachment | null> {
  const tmpPath = `${RNFS.CachesDirectoryPath}/tenor-${summary.id}.gif`;
  try {
    const { promise } = RNFS.downloadFile({
      fromUrl: summary.gifUrl,
      toFile: tmpPath,
    });
    const result = await promise;
    if (result.statusCode !== 200) {
      diag('tenor', 'download non-200', { status: result.statusCode });
      return null;
    }
    const data = await RNFS.readFile(tmpPath, 'base64');
    // Best-effort cleanup — Caches dir is OS-managed.
    try {
      await RNFS.unlink(tmpPath);
    } catch {
      /* ignore */
    }
    return {
      kind: 'gif',
      mime: 'image/gif',
      data,
      name: `tenor-${summary.id}.gif`,
    };
  } catch (err) {
    diag('tenor', 'download failed', { err: String(err) });
    return null;
  }
}
