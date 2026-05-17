/**
 * Signal Protocol contract — implemented natively per spec §4a:
 *   iOS:     CryptoKit (Swift) bridged to RN — 🍎 deferred to Phase 5b iOS sweep
 *   Android: org.signal:libsignal-android (AGPLv3) bridged via Kotlin module
 *   Server:  not used — server only stores opaque blobs (PreKey bundles
 *            and ciphertext) and relays them.
 *
 * The interface here is intentionally narrow: only the operations the
 * mobile client actually invokes from JS land. Internal session state is
 * managed by the native module.
 *
 * **Phase 5b scope (April 2026):** the 1:1 path only. Group messaging
 * (`encryptForGroup` / `decryptFromGroupMember`, Sender Keys per spec §4a)
 * was removed from this interface and lives on the planned `GroupMessagingModule`
 * — see spec §11 Phase 5b carry-over for the next sweep.
 */

/** A user's identity key — 32-byte X25519 public key, base64. */
export type IdentityKey = string;

export interface SignalSessionState {
  /** Opaque session blob the native module persists in SQLCipher (Phase 5c). */
  serialized: Uint8Array;
}

/**
 * Bundle uploaded by a freshly-enrolled device to `POST /v1/enroll`. The
 * Speakeasy server splits this into the `users.public_key` row + a
 * `prekey_bundles` row (spec §8). The wire shape is intentionally narrower
 * than the peer-bundle returned to other clients (no `identityPublicKey` —
 * the server already has it from enrollment).
 */
export interface OwnPreKeyBundle {
  /** Identity public key (32-byte X25519, base64). */
  identityPublicKey: string;
  registrationId: number;
  signedPreKeyId: number;
  /** Base64. */
  signedPreKey: string;
  /** Base64. */
  signedPreKeySig: string;
  preKeys: Array<{ id: number; key: string }>;
}

/**
 * Bundle returned by `POST /v1/prekeys/bundle` for a given peer userId. The
 * server consumed exactly one one-time prekey on the way out, so `preKeys`
 * has length 0 or 1. Identity key comes from `users.public_key`.
 */
export interface PeerPreKeyBundle {
  identityPublicKey: string;
  registrationId: number;
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySig: string;
  preKeys: Array<{ id: number; key: string }>;
}

export interface SignalProtocolModule {
  /** Generate a fresh identity keypair on the device. Returns the public key (base64). */
  generateIdentityKey(): Promise<IdentityKey>;

  /**
   * Generate the PreKey bundle uploaded at enrollment + on replenishment.
   * Spec §8: 1 signed prekey + N one-time prekeys.
   */
  generatePreKeyBundle(opts: {
    registrationId: number;
    signedPreKeyId: number;
    oneTimePreKeyCount: number;
  }): Promise<OwnPreKeyBundle>;

  /**
   * Establish a 1:1 session from a peer's PreKey bundle. The first call to
   * `encrypt(peerUserId, …)` after this will produce a `PreKeySignalMessage`
   * the peer's `decrypt` can use to mirror the session.
   *
   * Phase 5b note: the previous version of this interface returned the
   * session-handshake bytes from `initiateSession` directly. The new
   * libsignal-backed bridge is cleaner — establish here, send-as-first-encrypt
   * downstream. App code paths shrink correspondingly.
   */
  initiateSession(peerUserId: string, peerBundle: PeerPreKeyBundle): Promise<void>;

  /** Encrypt a payload for a peer with whom a session already exists. */
  encrypt(peerUserId: string, plaintext: Uint8Array): Promise<Uint8Array>;

  /** Decrypt a payload from a peer. May establish a new session on first message. */
  decrypt(peerUserId: string, ciphertext: Uint8Array): Promise<Uint8Array>;

  /**
   * Drop all stored Signal state for `peerUserId` — their identity key
   * and every session record. Used to recover from a TOFU-rejected
   * key change (`SignalClientError('untrusted_identity')`) when the
   * user opts in to trust the peer's freshly-rotated identity.
   *
   * After this resolves, the next `initiateSession(peerUserId, …)`
   * fetches the peer's current PreKey bundle, saves the new identity
   * via TOFU, and proceeds as if we'd never communicated with them.
   * Caller must also drop any in-process session cache (see
   * `crypto/session.ts`).
   */
  resetPeer(peerUserId: string): Promise<void>;

  /**
   * Permanently wipe the entire local Signal store — identity key,
   * sessions, prekeys, sender keys, and the decrypt cache — by deleting
   * the encrypted SQLCipher database. Used by account deletion so a
   * later re-enrollment starts from a genuinely empty store rather than
   * resurrecting the previous identity's keys.
   */
  wipeStore(): Promise<void>;
}

/** Mirrors error reasons from the Kotlin module (apps/mobile/.../SignalProtocolModule.kt). */
export type SignalClientErrorReason =
  | 'identity_key_failed'
  | 'prekey_bundle_failed'
  | 'session_init_failed'
  | 'untrusted_identity'
  | 'no_prekey'
  | 'encrypt_failed'
  | 'decrypt_failed'
  | 'unknown_error';

export class SignalClientError extends Error {
  constructor(public readonly reason: SignalClientErrorReason, message?: string) {
    super(message ?? reason);
    this.name = 'SignalClientError';
  }
}

interface NativeSignalModule {
  generateIdentityKey(): Promise<string>;
  generatePreKeyBundle(
    registrationId: number,
    signedPreKeyId: number,
    oneTimePreKeyCount: number,
  ): Promise<OwnPreKeyBundle>;
  initiateSession(peerUserId: string, peerBundle: PeerPreKeyBundle): Promise<null>;
  encrypt(peerUserId: string, plaintextB64: string): Promise<string>;
  decrypt(peerUserId: string, ciphertextB64: string): Promise<string>;
  resetPeer(peerUserId: string): Promise<null>;
  wipeStore(): Promise<null>;
}

/**
 * Conditional require of `react-native`. In RN production bundles the module
 * is provided globally by Metro. In Node test envs the require throws —
 * tests construct a mock instead of using this class directly.
 */
function loadNativeModule(): NativeSignalModule | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rn = require('react-native') as { NativeModules?: Record<string, unknown> };
    return rn.NativeModules?.SignalProtocol as NativeSignalModule | undefined;
  } catch {
    return undefined;
  }
}

// Hermes does NOT ship Buffer despite RN docs. The pure-JS helpers in
// ./bytes.ts work in both Hermes and Node.
import { b64ToBytes as b64Decode, bytesToB64 as b64Encode } from './bytes.js';

/**
 * Production wiring — Phase 5b. Calls `NativeModules.SignalProtocol.*`
 * (Kotlin module under `apps/mobile/android/.../signal/`, wrapping
 * `org.signal:libsignal-android:0.59.0`). Throws `SignalClientError` with
 * a `reason` mirroring the Kotlin reject codes.
 *
 * 🍎 iOS counterpart bridge is queued — see spec §11 Phase 5b.
 */
export class NativeSignalProtocolModule implements SignalProtocolModule {
  private readonly module: NativeSignalModule;

  constructor() {
    const m = loadNativeModule();
    if (!m) {
      throw new SignalClientError(
        'unknown_error',
        'NativeSignalProtocolModule: native module not registered. ' +
          'Are you running on a real device with the Phase 5b APK?',
      );
    }
    this.module = m;
  }

  async generateIdentityKey(): Promise<IdentityKey> {
    return await this.callBridge(() => this.module.generateIdentityKey());
  }

  async generatePreKeyBundle(opts: {
    registrationId: number;
    signedPreKeyId: number;
    oneTimePreKeyCount: number;
  }): Promise<OwnPreKeyBundle> {
    return await this.callBridge(() =>
      this.module.generatePreKeyBundle(
        opts.registrationId,
        opts.signedPreKeyId,
        opts.oneTimePreKeyCount,
      ),
    );
  }

  async initiateSession(peerUserId: string, peerBundle: PeerPreKeyBundle): Promise<void> {
    await this.callBridge(() => this.module.initiateSession(peerUserId, peerBundle));
  }

  async encrypt(peerUserId: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.encrypt(peerUserId, b64Encode(plaintext)),
    );
    return b64Decode(out);
  }

  async decrypt(peerUserId: string, ciphertext: Uint8Array): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.decrypt(peerUserId, b64Encode(ciphertext)),
    );
    return b64Decode(out);
  }

  async resetPeer(peerUserId: string): Promise<void> {
    await this.callBridge(() => this.module.resetPeer(peerUserId));
  }

  async wipeStore(): Promise<void> {
    await this.callBridge(() => this.module.wipeStore());
  }

  private async callBridge<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const reason =
        (err as { code?: SignalClientErrorReason }).code ?? 'unknown_error';
      throw new SignalClientError(reason, (err as Error).message);
    }
  }
}
