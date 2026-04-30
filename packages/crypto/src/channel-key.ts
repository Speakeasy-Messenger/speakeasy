/**
 * Community channel-key contract — spec §4b.
 *
 * Each community has one symmetric AES-256 channel key K. K is generated on
 * the creator's device and distributed via per-recipient *envelopes*: K
 * wrapped with each member's identity public key (ECIES: ephemeral X25519 +
 * HKDF-SHA256 + AES-256-GCM). Server stores envelopes only; never plaintext K.
 *
 * **Wire format** — must stay in sync between Android (Phase 5b ✅) and
 * iOS (🍎 queued). Documented in detail in
 * `apps/mobile/android/.../channelkey/ChannelKeyModule.kt`. Summary:
 *
 *   wrapForRecipient envelope:
 *     [33 bytes ephemeral pubkey] [12 bytes IV] [ciphertext + 16-byte GCM tag]
 *
 *   encryptMessage output:
 *     [12 bytes IV] [ciphertext + 16-byte GCM tag]
 *
 * Key rotation (spec §13 open question, default policy): moderator-triggered;
 * also automatic on a member leave. New K, new envelopes.
 */

export interface ChannelKeyModule {
  /** Generate a fresh 32-byte AES-256 channel key on the device. */
  generateChannelKey(): Promise<Uint8Array>;

  /**
   * Wrap channel key K for a recipient identified by their identity public key.
   * Returns an opaque envelope blob the server can store and relay verbatim.
   */
  wrapForRecipient(K: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array>;

  /**
   * Unwrap an envelope using the device's own identity private key (held
   * inside libsignal's protocol store). Native module hides the private key
   * entirely.
   */
  unwrapForSelf(envelope: Uint8Array): Promise<Uint8Array>;

  /** AES-256-GCM encrypt with the channel key. */
  encryptMessage(K: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  decryptMessage(K: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array>;
}

/** Mirrors error reasons from the Kotlin module (apps/mobile/.../ChannelKeyModule.kt). */
export type ChannelKeyClientErrorReason =
  | 'generate_failed'
  | 'wrap_failed'
  | 'unwrap_failed'
  | 'encrypt_failed'
  | 'decrypt_failed'
  | 'bad_channel_key'
  | 'bad_envelope'
  | 'bad_ciphertext'
  | 'bad_eph_pub_size'
  | 'unknown_error';

export class ChannelKeyClientError extends Error {
  constructor(public readonly reason: ChannelKeyClientErrorReason, message?: string) {
    super(message ?? reason);
    this.name = 'ChannelKeyClientError';
  }
}

interface NativeChannelKeyModuleBridge {
  generateChannelKey(): Promise<string>;
  wrapForRecipient(channelKeyB64: string, recipientPublicKeyB64: string): Promise<string>;
  unwrapForSelf(envelopeB64: string): Promise<string>;
  encryptMessage(channelKeyB64: string, plaintextB64: string): Promise<string>;
  decryptMessage(channelKeyB64: string, ciphertextB64: string): Promise<string>;
}

function loadNativeModule(): NativeChannelKeyModuleBridge | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rn = require('react-native') as { NativeModules?: Record<string, unknown> };
    return rn.NativeModules?.ChannelKey as NativeChannelKeyModuleBridge | undefined;
  } catch {
    return undefined;
  }
}

import { b64ToBytes as b64Decode, bytesToB64 as b64Encode } from './bytes.js';

/**
 * Production wiring — Phase 5b. Calls `NativeModules.ChannelKey.*` (Kotlin
 * module under `apps/mobile/android/.../channelkey/`). Throws
 * `ChannelKeyClientError` with a `reason` mirroring the Kotlin reject codes.
 *
 * 🍎 iOS counterpart bridge is queued — see spec §11 Phase 5b.
 */
export class NativeChannelKeyModule implements ChannelKeyModule {
  private readonly module: NativeChannelKeyModuleBridge;

  constructor() {
    const m = loadNativeModule();
    if (!m) {
      throw new ChannelKeyClientError(
        'unknown_error',
        'NativeChannelKeyModule: native module not registered. ' +
          'Are you running on a real device with the Phase 5b APK?',
      );
    }
    this.module = m;
  }

  async generateChannelKey(): Promise<Uint8Array> {
    return b64Decode(await this.callBridge(() => this.module.generateChannelKey()));
  }

  async wrapForRecipient(K: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.wrapForRecipient(b64Encode(K), b64Encode(recipientPublicKey)),
    );
    return b64Decode(out);
  }

  async unwrapForSelf(envelope: Uint8Array): Promise<Uint8Array> {
    const out = await this.callBridge(() => this.module.unwrapForSelf(b64Encode(envelope)));
    return b64Decode(out);
  }

  async encryptMessage(K: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.encryptMessage(b64Encode(K), b64Encode(plaintext)),
    );
    return b64Decode(out);
  }

  async decryptMessage(K: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.decryptMessage(b64Encode(K), b64Encode(ciphertext)),
    );
    return b64Decode(out);
  }

  private async callBridge<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const reason =
        (err as { code?: ChannelKeyClientErrorReason }).code ?? 'unknown_error';
      throw new ChannelKeyClientError(reason, (err as Error).message);
    }
  }
}
