import { describe, expect, it } from 'vitest';
import { testBundle, testIdentity } from './xeddsa-testkit.js';
import { xeddsaVerify } from './xeddsa.js';

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));

describe('xeddsa testkit', () => {
  it('produces signatures the production verifier accepts', () => {
    const { publicKey, bundle } = testBundle('alpha');
    expect(
      xeddsaVerify(b64(publicKey), b64(bundle.signedPreKey), b64(bundle.signedPreKeySig)),
    ).toBe(true);
  });
  it('is deterministic per seed and distinct across seeds', () => {
    expect(testIdentity('a').publicKeyB64).toBe(testIdentity('a').publicKeyB64);
    expect(testIdentity('a').publicKeyB64).not.toBe(testIdentity('b').publicKeyB64);
  });
  it("another identity's signature does not verify", () => {
    const a = testBundle('alpha');
    const b = testBundle('beta');
    expect(
      xeddsaVerify(b64(a.publicKey), b64(b.bundle.signedPreKey), b64(b.bundle.signedPreKeySig)),
    ).toBe(false);
  });
});
