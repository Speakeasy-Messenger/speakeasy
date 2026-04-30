/**
 * Group messaging contract — Sender Keys, implemented natively per spec §4a:
 *   iOS:     CryptoKit + Signal Group equivalent (🍎 deferred)
 *   Android: org.signal:libsignal-android `GroupSessionBuilder` + `GroupCipher`
 *
 * # Mental model
 *
 * Group messaging uses libsignal Sender Keys, NOT 1:1 sessions per
 * recipient. Each sender holds one SenderKey per (sender, group),
 * identified by a `distributionId` UUID. The first time the sender posts
 * to a group, they emit a `SenderKeyDistributionMessage` (SKDM) the
 * recipients use to construct a per-(sender, group) decryption key.
 * After that, every group send is a single ciphertext that fans out to
 * the whole group.
 *
 * # Wire-format orchestration (caller-side)
 *
 *   send-first-time:
 *     skdm = createSenderKeyDistribution(distributionId)
 *     for peer in members - {self}:
 *       wrapped = signalProtocol.encrypt(peer, skdm)
 *       server.upload(wrapped, kind='skdm', group=g)
 *     ciphertext = encryptForGroup(distributionId, plaintext)
 *     server.fanOut(ciphertext, group=g)
 *
 *   send-subsequent:
 *     ciphertext = encryptForGroup(distributionId, plaintext)
 *     server.fanOut(ciphertext, group=g)
 *
 *   receive-skdm:
 *     plaintext = signalProtocol.decrypt(senderUserId, wrapped)
 *     processSenderKeyDistribution(senderUserId, plaintext)
 *
 *   receive-message:
 *     plaintext = decryptFromGroupMember(senderUserId, ciphertext)
 *
 * The server fan-out path (delivering an SKDM bundled alongside the
 * first group message to new members) is part of the planned wire
 * format — see spec §11 Phase 5b carry-over for status.
 */

export interface GroupMessagingModule {
  /**
   * Create a fresh SenderKey for the local user in the named group.
   * Returns the SKDM bytes — caller must fan-out to every recipient via
   * `signalProtocol.encrypt` before the first encrypted group message
   * arrives.
   *
   * `distributionId` is a UUID v4 the caller allocates (one per local
   * (sender, group) pair, persisted client-side).
   */
  createSenderKeyDistribution(distributionId: string): Promise<Uint8Array>;

  /** Process a peer's SKDM (decrypted from a 1:1 Signal envelope). */
  processSenderKeyDistribution(
    senderUserId: string,
    skdmBytes: Uint8Array,
  ): Promise<void>;

  /** Encrypt for the group identified by `distributionId`. */
  encryptForGroup(distributionId: string, plaintext: Uint8Array): Promise<Uint8Array>;

  /** Decrypt a group message authored by `senderUserId`. */
  decryptFromGroupMember(
    senderUserId: string,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array>;
}

/** Mirrors error reasons from the Kotlin module (apps/mobile/.../GroupMessagingModule.kt). */
export type GroupMessagingClientErrorReason =
  | 'no_session'
  | 'duplicate_message'
  | 'invalid_message'
  | 'legacy_message'
  | 'bad_distribution_id'
  | 'unknown_error';

export class GroupMessagingClientError extends Error {
  constructor(
    public readonly reason: GroupMessagingClientErrorReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'GroupMessagingClientError';
  }
}

interface NativeGroupMessagingModuleAPI {
  createSenderKeyDistribution(distributionId: string): Promise<string>;
  processSenderKeyDistribution(senderUserId: string, skdmBytesB64: string): Promise<null>;
  encryptForGroup(distributionId: string, plaintextB64: string): Promise<string>;
  decryptFromGroupMember(senderUserId: string, ciphertextB64: string): Promise<string>;
}

function loadNativeModule(): NativeGroupMessagingModuleAPI | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const rn = require('react-native') as { NativeModules?: Record<string, unknown> };
    return rn.NativeModules?.GroupMessaging as NativeGroupMessagingModuleAPI | undefined;
  } catch {
    return undefined;
  }
}

import { b64ToBytes as b64Decode, bytesToB64 as b64Encode } from './bytes.js';

/**
 * Production wiring. Calls `NativeModules.GroupMessaging.*` (Kotlin
 * module under `apps/mobile/android/.../signal/GroupMessagingModule.kt`,
 * wrapping `org.signal:libsignal-android` Sender Keys). Throws
 * `GroupMessagingClientError` with reasons mirroring the Kotlin reject
 * codes.
 *
 * 🍎 iOS counterpart bridge is queued — see spec §11 Phase 5b carry-over.
 */
export class NativeGroupMessagingModule implements GroupMessagingModule {
  private readonly module: NativeGroupMessagingModuleAPI;

  constructor() {
    const m = loadNativeModule();
    if (!m) {
      throw new GroupMessagingClientError(
        'unknown_error',
        'NativeGroupMessagingModule: native module not registered. ' +
          'Are you running on a device with the Phase 5b carry-over APK?',
      );
    }
    this.module = m;
  }

  async createSenderKeyDistribution(distributionId: string): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.createSenderKeyDistribution(distributionId),
    );
    return b64Decode(out);
  }

  async processSenderKeyDistribution(
    senderUserId: string,
    skdmBytes: Uint8Array,
  ): Promise<void> {
    await this.callBridge(() =>
      this.module.processSenderKeyDistribution(senderUserId, b64Encode(skdmBytes)),
    );
  }

  async encryptForGroup(distributionId: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.encryptForGroup(distributionId, b64Encode(plaintext)),
    );
    return b64Decode(out);
  }

  async decryptFromGroupMember(
    senderUserId: string,
    ciphertext: Uint8Array,
  ): Promise<Uint8Array> {
    const out = await this.callBridge(() =>
      this.module.decryptFromGroupMember(senderUserId, b64Encode(ciphertext)),
    );
    return b64Decode(out);
  }

  private async callBridge<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const reason =
        (err as { code?: GroupMessagingClientErrorReason }).code ?? 'unknown_error';
      throw new GroupMessagingClientError(reason, (err as Error).message);
    }
  }
}
