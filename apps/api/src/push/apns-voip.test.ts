import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { signApnsProviderJwt, apnsVoipFromEnv } from './apns-voip.js';

function p256KeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privateKey, publicKey };
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

describe('signApnsProviderJwt', () => {
  it('produces a verifiable ES256 JWT with the right header + claims', () => {
    const { privateKey, publicKey } = p256KeyPair();
    const now = 1_700_000_000_000;
    const jwt = signApnsProviderJwt({
      keyP8: privateKey,
      keyId: 'ABCDE12345',
      teamId: 'TEAM123456',
      now,
    });
    const [h, c, sig] = jwt.split('.');
    expect(sig).toBeTruthy();

    const header = JSON.parse(b64urlToBuf(h).toString('utf8'));
    expect(header).toEqual({ alg: 'ES256', kid: 'ABCDE12345', typ: 'JWT' });

    const claims = JSON.parse(b64urlToBuf(c).toString('utf8'));
    expect(claims).toEqual({ iss: 'TEAM123456', iat: Math.floor(now / 1000) });

    // The signature must verify against the public key as raw r‖s (P1363) —
    // this is exactly what APNs checks; a DER signature here would 403.
    const ok = createVerify('SHA256')
      .update(`${h}.${c}`)
      .verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, b64urlToBuf(sig));
    expect(ok).toBe(true);
  });
});

describe('apnsVoipFromEnv', () => {
  const fullEnv = {
    APNS_KEY_P8: p256KeyPair().privateKey,
    APNS_KEY_ID: 'ABCDE12345',
    APNS_TEAM_ID: 'TEAM123456',
    APNS_BUNDLE_ID: 'xyz.speakeasyapp.app',
  } as unknown as NodeJS.ProcessEnv;

  it('returns undefined when any required var is missing', () => {
    expect(apnsVoipFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(apnsVoipFromEnv({ ...fullEnv, APNS_KEY_ID: undefined } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(apnsVoipFromEnv({ ...fullEnv, APNS_BUNDLE_ID: undefined } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('builds a sender when fully configured', () => {
    expect(apnsVoipFromEnv(fullEnv)).toBeDefined();
  });

  it('un-escapes \\n in the PEM (Fly/CI single-line secret format)', () => {
    const escaped = { ...fullEnv, APNS_KEY_P8: (fullEnv.APNS_KEY_P8 as string).replace(/\n/g, '\\n') };
    // Should still build + be able to sign (no throw on the escaped key).
    const sender = apnsVoipFromEnv(escaped as NodeJS.ProcessEnv);
    expect(sender).toBeDefined();
  });
});
