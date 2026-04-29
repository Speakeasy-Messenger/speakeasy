/**
 * Hermes-safe byte / string / base64 helpers.
 *
 * Why this exists: the original helpers used `Buffer.from(...)`, a Node
 * global. RN's Hermes runtime does not ship `Buffer`, so the first send
 * blew up with `ReferenceError: Property 'Buffer' doesn't exist`. The
 * vitest tests didn't catch it because vitest runs in Node where
 * `Buffer` is a builtin.
 *
 * These helpers use only APIs available in Hermes (and Node):
 *   - TextEncoder / TextDecoder for utf-8 (Hermes ≥ 0.74, Node ≥ 11)
 *   - btoa / atob for base64 (Hermes shims them; Node 16+ has them as
 *     globals)
 *
 * Performance: equivalent for the message sizes we deal with (<32KB).
 * `String.fromCharCode` over a 16KB chunk is fine; the chunk loop avoids
 * "Maximum call stack" on huge inputs which is a documented btoa quirk.
 */

const CHUNK = 0x8000; // 32KB chunk per fromCharCode/charCodeAt loop pass.

export function utf8ToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8FromBytes(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

export function bytesToB64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    bin += String.fromCharCode(...b.subarray(i, i + CHUNK));
  }
  // btoa is global in Hermes + Node ≥ 16. (For Node ≥ 18 it's stable.)
  return btoa(bin);
}

export function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
