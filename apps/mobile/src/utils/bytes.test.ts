import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { b64ToBytes, bytesToB64, utf8FromBytes, utf8ToBytes } from './bytes.js';

/**
 * Regression coverage for the Hermes runtime gap.
 *
 * Vitest tests run in Node, where `Buffer` is a builtin. This is what let
 * the original `Buffer.from(...)` helpers ship to alpha 0.2.1 and crash
 * the first send-message with `ReferenceError: Property 'Buffer' doesn't
 * exist`. To prevent the regression class:
 *
 *   1. The helpers in `bytes.ts` use only APIs that exist in Hermes
 *      (TextEncoder, btoa, atob).
 *   2. THIS test file deletes `Buffer` from `globalThis` for the
 *      duration of every test, then exercises the helpers. Any code
 *      path that secretly reaches for `Buffer` will throw, failing the
 *      assertion.
 *
 * If you find yourself reaching for `Buffer` in app code in the future,
 * funnel through `bytes.ts` and these tests will keep you honest.
 */

let savedBuffer: typeof globalThis.Buffer | undefined;

beforeEach(() => {
  savedBuffer = globalThis.Buffer;
  // Simulate Hermes — Buffer global does not exist.
  // @ts-expect-error — runtime-only deletion of a Node global.
  delete globalThis.Buffer;
});
afterEach(() => {
  if (savedBuffer) {
    globalThis.Buffer = savedBuffer;
  }
});

describe('byte / string / base64 helpers (Hermes-safe)', () => {
  it('utf8 round-trip with ASCII', () => {
    const b = utf8ToBytes('hello speakeasy');
    expect(b).toBeInstanceOf(Uint8Array);
    expect(utf8FromBytes(b)).toBe('hello speakeasy');
  });

  it('utf8 round-trip with multi-byte (em dash, CJK, emoji)', () => {
    const s = 'say it — 言って ✌️';
    const b = utf8ToBytes(s);
    // em dash is 3 bytes utf-8; "言" is 3; "って" is 6; emoji is 4 (no skin tone).
    // The exact byte length isn't the contract — only the round-trip.
    expect(utf8FromBytes(b)).toBe(s);
  });

  it('base64 round-trip preserves arbitrary bytes', () => {
    const original = new Uint8Array([
      0x00, 0xff, 0x02, 0x7f, 0x80, 0x10, 0xa5, 0x33, 0x9c, 0x42, 0xee, 0xb1,
      0xc4, 0x6d, 0x57, 0x29, 0xf1, 0x0b, 0x5e, 0xa0, 0x71, 0x3d, 0x4c, 0xfa,
    ]);
    const encoded = bytesToB64(original);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const decoded = b64ToBytes(encoded);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBe(original[i]);
    }
  });

  it('handles a 32KB+ payload (chunk-loop boundary)', () => {
    // The bytesToB64 implementation slices into 32KB chunks to avoid
    // "Maximum call stack" on huge spread-into-fromCharCode args. Verify
    // the chunk seam is clean.
    const big = new Uint8Array(40 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    const encoded = bytesToB64(big);
    const decoded = b64ToBytes(encoded);
    expect(decoded.length).toBe(big.length);
    for (let i = 0; i < big.length; i++) {
      expect(decoded[i]).toBe(big[i]);
    }
  });

  it('confirms Buffer is genuinely absent during the test', () => {
    // Catches the failure mode where the test infra silently re-injects
    // Buffer (and the helpers happen to use it).
    expect(typeof (globalThis as Record<string, unknown>).Buffer).toBe('undefined');
  });

  it('utf8 + base64 composed: text → bytes → b64 → bytes → text', () => {
    const s = 'hello, bob — see you in 7 days.';
    const b1 = utf8ToBytes(s);
    const wire = bytesToB64(b1);
    const b2 = b64ToBytes(wire);
    expect(utf8FromBytes(b2)).toBe(s);
  });
});
