import { ed25519 } from '@noble/curves/ed25519.js';

/**
 * XEdDSA signature verification (Signal's Curve25519 signatures).
 *
 * libsignal clients sign the serialized signed-prekey public key with
 * the identity private key via `Curve.calculateSignature` — an XEdDSA
 * signature: an Ed25519 signature made with the Montgomery (X25519)
 * identity key, with the Edwards sign bit of the public key smuggled
 * into the top bit of the final signature byte (valid Ed25519 `s`
 * scalars never use that bit).
 *
 * Verification (per the XEdDSA spec / libsignal's curve25519_verify):
 *   1. b   = sig[63] >> 7            — the Edwards sign bit
 *   2. sig' = sig with that bit cleared
 *   3. A_ed = Edwards encoding of the Montgomery key:
 *        y = (u - 1) / (u + 1) mod p, with sign bit b
 *   4. standard Ed25519 verify(sig', message, A_ed)
 *
 * WHY THE SERVER VERIFIES AT ALL: `/v1/prekeys/replenish` used to
 * store whatever bundle an authenticated device token uploaded. A
 * token that outlives its Signal store (iOS keychain surviving an app
 * reinstall — observed 2026-08-07 — or a stolen token) could then
 * silently swap the account's effective identity, bypassing the
 * dual-proof rebind path that exists precisely to prevent handle
 * takeover without the on-file identity key. Rejecting bundles whose
 * signature doesn't verify against the ON-FILE identity closes that
 * side door: identity rotation only happens through enroll/rebind.
 */

const P = 2n ** 255n - 19n;

function mod(a: bigint): bigint {
  const r = a % P;
  return r < 0n ? r + P : r;
}

/** Modular inverse via Fermat: a^(p-2) mod p. */
function invert(a: bigint): bigint {
  let result = 1n;
  let base = mod(a);
  let e = P - 2n;
  while (e > 0n) {
    if (e & 1n) result = (result * base) % P;
    base = (base * base) % P;
    e >>= 1n;
  }
  return result;
}

function bytesToNumberLE(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[i]!);
  }
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

/** Strip libsignal's 0x05 DJB type prefix if present (33 → 32 bytes). */
function montgomeryBytes(key: Uint8Array): Uint8Array | undefined {
  if (key.length === 33 && key[0] === 0x05) return key.subarray(1);
  if (key.length === 32) return key;
  return undefined;
}

/**
 * Verify an XEdDSA signature.
 *
 * @param identityPublicKey Montgomery identity key, 32 bytes raw or
 *   33 bytes libsignal-serialized (0x05-prefixed).
 * @param message           the exact signed bytes (for a signed
 *   prekey: its 33-byte serialized public key, i.e. the stored value).
 * @param signature         64-byte XEdDSA signature.
 * @returns true iff the signature verifies. Never throws on malformed
 *   input — malformed means "not verified".
 */
export function xeddsaVerify(
  identityPublicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  const mont = montgomeryBytes(identityPublicKey);
  if (!mont || signature.length !== 64) return false;

  const signBit = (signature[63]! & 0x80) >> 7;
  const cleared = Uint8Array.from(signature);
  cleared[63]! &= 0x7f;

  // Montgomery u → Edwards y: y = (u - 1) / (u + 1). u = -1 has no
  // Edwards image (division by zero) — reject.
  const u = mod(bytesToNumberLE(mont));
  const denom = mod(u + 1n);
  if (denom === 0n) return false;
  const y = mod(mod(u - 1n) * invert(denom));

  const edPub = numberToBytesLE(y, 32);
  edPub[31]! |= signBit << 7;

  try {
    // zip215:false = strict cofactored rejection of non-canonical
    // encodings, matching libsignal's own strict verification.
    return ed25519.verify(cleared, message, edPub, { zip215: false });
  } catch {
    return false;
  }
}
