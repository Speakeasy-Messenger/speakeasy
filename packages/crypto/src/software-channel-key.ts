import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ChannelKeyModule } from './channel-key.js';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

function aesGcmDecrypt(key: Uint8Array, blob: Uint8Array): Uint8Array {
  if (blob.length < IV_BYTES + TAG_BYTES) {
    throw new Error('ciphertext too short');
  }
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Test fixture for `ChannelKeyModule`. **Not for production.**
 *
 * Real `wrapForRecipient` uses ECIES: ephemeral X25519 + HKDF + AES-GCM,
 * wrapping K under a key derived from the recipient's identity *public*
 * key. Devices unwrap with their *private* key in the secure enclave.
 *
 * This software impl is symmetric — `wrap` and `unwrap` use the SAME
 * 32-byte secret. Sufficient to exercise wire-format round-trips, the
 * server's envelope storage, and the upload/fetch endpoints. Construct
 * with the recipient's "key" set to a deterministic test secret.
 */
export class SoftwareChannelKeyModule implements ChannelKeyModule {
  /** Fixed 32-byte secret used as both wrap and unwrap key. */
  constructor(private readonly testSecret: Uint8Array) {
    if (testSecret.length !== KEY_BYTES) {
      throw new Error(`SoftwareChannelKeyModule: testSecret must be ${KEY_BYTES} bytes`);
    }
  }

  async generateChannelKey(): Promise<Uint8Array> {
    return new Uint8Array(randomBytes(KEY_BYTES));
  }

  async wrapForRecipient(K: Uint8Array, _recipientPublicKey: Uint8Array): Promise<Uint8Array> {
    // Real impl derives a wrap key from recipientPublicKey via ECIES; here we
    // ignore it and use the constructor secret. The API shape matches.
    return aesGcmEncrypt(this.testSecret, K);
  }

  async unwrapForSelf(envelope: Uint8Array): Promise<Uint8Array> {
    return aesGcmDecrypt(this.testSecret, envelope);
  }

  async encryptMessage(K: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    return aesGcmEncrypt(K, plaintext);
  }

  async decryptMessage(K: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    return aesGcmDecrypt(K, ciphertext);
  }
}
