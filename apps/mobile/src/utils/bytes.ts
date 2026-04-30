/**
 * Hermes-safe byte / string / base64 helpers.
 *
 * Why this exists: shipping to Hermes (the RN release JS engine) keeps
 * surfacing Node/Web APIs that aren't actually present:
 *
 *   - 0.2.1: `Buffer.from(...)` — a Node global Hermes doesn't ship.
 *     Crashed `[send failed: Buffer doesn't exist]`.
 *   - 0.2.4: `new TextDecoder('utf-8').decode(b)` — supposedly in
 *     Hermes 0.74+, but the actual on-device build doesn't have it.
 *     Crashed `[direct IIFE CRASHED: Property 'TextDecoder' doesn't exist]`,
 *     silently dropping every received message.
 *
 * To prevent a third repetition we drop ALL Web/Node API dependencies in
 * this module and use only the lowest-common-denominator JS that
 * provably works in Hermes:
 *
 *   - `String.fromCharCode` / `s.charCodeAt(i)` for surrogate-pair-aware
 *     character handling
 *   - manual UTF-8 codec (the spec is short; this is ~50 lines)
 *   - `btoa` / `atob` (Hermes does ship these — confirmed by 0.2.2's
 *     base64 round-trip test)
 *
 * If we ever hit a `btoa`/`atob`-doesn't-exist bug, replace those too.
 */

const CHUNK = 0x8000; // 32KB chunk per fromCharCode/charCodeAt loop pass.

/**
 * UTF-8 encode a JS string. Handles surrogate pairs (emoji + supplementary
 * plane) by combining the high+low surrogate into a 4-byte sequence.
 */
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

/**
 * UTF-8 decode a Uint8Array to a JS string. Handles 1/2/3/4-byte sequences,
 * splitting 4-byte codepoints into a surrogate pair so the result is a
 * standard JS UTF-16 string.
 *
 * Malformed sequences (incomplete continuation, invalid leading byte) are
 * replaced with U+FFFD, matching what `TextDecoder('utf-8')` would do.
 */
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
      // Invalid leading byte.
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
