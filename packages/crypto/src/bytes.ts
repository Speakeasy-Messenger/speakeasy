/**
 * Hermes-safe byte helpers for `@speakeasy/crypto`. Mirrors the same
 * module under `apps/mobile/src/utils/bytes.ts` and exists for the same
 * reason: Hermes (RN's release JS engine) doesn't ship `Buffer`,
 * `TextDecoder`, or `TextEncoder`. Code in this workspace package is
 * bundled into the mobile app, so it must use only Hermes-available
 * APIs even though the package ALSO runs in Node tests.
 *
 * The functions here use only `String.fromCharCode` / `s.charCodeAt(i)`
 * + a manual UTF-8 codec + `btoa`/`atob` (Hermes ships these).
 */

const CHUNK = 0x8000;

export function utf8ToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let cp = s.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
      const low = s.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + ((cp & 0x3ff) << 10) + (low & 0x3ff);
        i++;
      }
    }
    if (cp < 0x80) {
      out.push(cp);
    } else if (cp < 0x800) {
      out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

export function utf8FromBytes(b: Uint8Array): string {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const b1 = b[i++]!;
    if (b1 < 0x80) {
      s += String.fromCharCode(b1);
    } else if ((b1 & 0xe0) === 0xc0) {
      if (i >= b.length) {
        s += '�';
        break;
      }
      const b2 = b[i++]! & 0x3f;
      s += String.fromCharCode(((b1 & 0x1f) << 6) | b2);
    } else if ((b1 & 0xf0) === 0xe0) {
      if (i + 1 >= b.length) {
        s += '�';
        break;
      }
      const b2 = b[i++]! & 0x3f;
      const b3 = b[i++]! & 0x3f;
      s += String.fromCharCode(((b1 & 0x0f) << 12) | (b2 << 6) | b3);
    } else if ((b1 & 0xf8) === 0xf0) {
      if (i + 2 >= b.length) {
        s += '�';
        break;
      }
      const b2 = b[i++]! & 0x3f;
      const b3 = b[i++]! & 0x3f;
      const b4 = b[i++]! & 0x3f;
      let cp = ((b1 & 0x07) << 18) | (b2 << 12) | (b3 << 6) | b4;
      cp -= 0x10000;
      s += String.fromCharCode(0xd800 + (cp >> 10));
      s += String.fromCharCode(0xdc00 + (cp & 0x3ff));
    } else {
      s += '�';
    }
  }
  return s;
}

export function bytesToB64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    bin += String.fromCharCode(...b.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
