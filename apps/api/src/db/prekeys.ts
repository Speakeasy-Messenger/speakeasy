import type { PreKey, PreKeyBundleInput } from './users.js';

/**
 * Public PreKey bundle returned to a peer who's establishing a session.
 * Per Signal Protocol, the server hands out one one-time prekey at a time
 * and removes it from inventory ("consume on fetch") to prevent replay.
 */
export interface PublicPreKeyBundle {
  userId: string;
  identityPublicKey: Buffer;
  registrationId: number;
  signedPreKeyId: number;
  signedPreKey: Buffer;
  signedPreKeySig: Buffer;
  /** A single one-time prekey, or null if the bucket is exhausted. */
  oneTimePreKey: PreKey | null;
  /** How many one-time keys remain after this fetch (for monitoring). */
  remainingPreKeys: number;
}

export interface PreKeyRepo {
  /**
   * Atomically fetch and consume a one-time prekey for `userId`.
   * Returns the bundle (with oneTimePreKey null if exhausted) or undefined
   * if the user has never enrolled.
   */
  fetchBundleConsume(userId: string): Promise<PublicPreKeyBundle | undefined>;

  /** Replace the user's one-time prekey inventory. Used by replenish. */
  replenish(args: {
    userId: string;
    signedPreKeyId: number;
    signedPreKey: string;
    signedPreKeySig: string;
    preKeys: PreKey[];
  }): Promise<void>;

  /** Count remaining one-time prekeys, e.g. for client-side replenish trigger. */
  countRemaining(userId: string): Promise<number>;
}
