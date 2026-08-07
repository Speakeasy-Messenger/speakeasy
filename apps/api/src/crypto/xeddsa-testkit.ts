import { ed25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';

/**
 * TEST-ONLY XEdDSA signing. Production clients sign on-device with
 * libsignal; the server only ever verifies. Tests need real
 * (identity, signed prekey, signature) triples now that enroll /
 * rebind / replenish reject unsigned bundles, and hand-pasted
 * fixtures can't cover freshly-minted handles.
 *
 * Not exported from any production path — importing this in `src/`
 * outside a test is a bug (the server has no business holding an
 * identity private key).
 */

const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const P = 2n ** 255n - 19n;

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

function numberToBytesLE(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

function invert(a: bigint): bigint {
  let result = 1n;
  let base = mod(a, P);
  let e = P - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % P;
    base = (base * base) % P;
    e >>= 1n;
  }
  return result;
}

export interface TestIdentity {
  /** libsignal-serialized (0x05-prefixed) Montgomery public key, base64. */
  publicKeyB64: string;
  /** Sign a message with this identity, returning base64 XEdDSA. */
  sign: (message: Uint8Array) => string;
}

/**
 * Deterministically derive a test identity from `seed` so failures
 * reproduce. Returns the Montgomery public key libsignal would upload
 * plus an XEdDSA signer over the matching private scalar.
 */
export function testIdentity(seed: string): TestIdentity {
  // Clamped X25519-style scalar, as libsignal's Curve.generateKeyPair
  // produces.
  const a0 = sha512(new TextEncoder().encode(`speakeasy-test-identity:${seed}`)).slice(0, 32);
  a0[0]! &= 248;
  a0[31]! &= 127;
  a0[31]! |= 64;
  let a = mod(bytesToNumberLE(a0), L);

  // A = a*G on Edwards; XEdDSA negates the scalar when A is negative
  // so the signature always corresponds to the positive encoding.
  let A = ed25519.Point.BASE.multiply(a);
  if ((A.toBytes()[31]! & 0x80) !== 0) {
    a = mod(-a, L);
    A = ed25519.Point.BASE.multiply(a);
  }
  const Aenc = A.toBytes();

  // Edwards y → Montgomery u = (1 + y) / (1 - y): the public key
  // libsignal actually publishes.
  const y = bytesToNumberLE(Aenc) & ((1n << 255n) - 1n);
  const u = mod(mod(1n + y, P) * invert(mod(1n - y, P)), P);
  const publicKey = new Uint8Array(33);
  publicKey[0] = 0x05;
  publicKey.set(numberToBytesLE(u, 32), 1);

  return {
    publicKeyB64: Buffer.from(publicKey).toString('base64'),
    sign(message: Uint8Array): string {
      // Deterministic nonce — fine for tests (no key reuse risk since
      // these identities never leave the suite).
      const r = mod(
        bytesToNumberLE(sha512(new Uint8Array([...numberToBytesLE(a, 32), ...message]))),
        L,
      );
      const R = ed25519.Point.BASE.multiply(r).toBytes();
      const k = mod(bytesToNumberLE(sha512(new Uint8Array([...R, ...Aenc, ...message]))), L);
      const s = mod(r + k * a, L);
      const sig = new Uint8Array(64);
      sig.set(R, 0);
      sig.set(numberToBytesLE(s, 32), 32);
      // XEdDSA carries the Edwards sign bit here; `a` was normalized
      // above so it's always 0, but set it explicitly for clarity.
      sig[63]! |= Aenc[31]! & 0x80;
      return Buffer.from(sig).toString('base64');
    },
  };
}

/**
 * A complete, correctly-signed enroll/rebind/replenish payload pair.
 * `signedPreKey` content is arbitrary — what matters is that the
 * signature over it verifies against `publicKey`.
 */
export function testBundle(
  seed: string,
  opts: { registrationId?: number; signedPreKeyId?: number; spkLabel?: string } = {},
): {
  publicKey: string;
  bundle: {
    registrationId: number;
    signedPreKeyId: number;
    signedPreKey: string;
    signedPreKeySig: string;
    preKeys: { id: number; key: string }[];
  };
} {
  const id = testIdentity(seed);
  const spk = Buffer.from(opts.spkLabel ?? `spk-${seed}`);
  return {
    publicKey: id.publicKeyB64,
    bundle: {
      registrationId: opts.registrationId ?? 1,
      signedPreKeyId: opts.signedPreKeyId ?? 100,
      signedPreKey: spk.toString('base64'),
      signedPreKeySig: id.sign(spk),
      preKeys: [
        { id: 1, key: Buffer.from(`k1-${seed}`).toString('base64') },
        { id: 2, key: Buffer.from(`k2-${seed}`).toString('base64') },
      ],
    },
  };
}
