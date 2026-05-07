import type { ConversationKind } from '@speakeasy/shared';

export interface BufferedMessage {
  id: string;
  conversation: string;
  senderId: string;
  recipientId: string;
  ciphertext: Buffer;
  msgType: ConversationKind;
  createdAt: Date;
  expiresAt: Date;
  /**
   * Set on Sender Key Distribution Messages (SKDMs) only. Carries the
   * group context the recipient needs to attribute the SKDM to the right
   * conversation when processing it. Null/undefined for ordinary messages.
   */
  skdmGroupId?: string;
  /**
   * Snapshot of the recipient's known device tokens at insert time
   * (Phase 5f per-device buffered-delivery tracking). Empty array means
   * "no devices were known yet" — the legacy single-device shortcut
   * applies (any drain, any ack deletes). Non-empty means **every**
   * listed device must ack before the row is deleted; only listed
   * devices drain on reconnect.
   */
  targetDevices: string[];
  /**
   * Subset of `targetDevices` that have acked so far. Row is deleted +
   * `delivered` fires back to the sender once `deliveredToDevices`
   * contains every entry of `targetDevices`.
   */
  deliveredToDevices: string[];
  /**
   * Sealed-sender flag (spec §13 / §11 Phase 5g). When true, the
   * server stores `senderId` for ack routing but suppresses it in
   * the wire frame forwarded to the recipient + omits it from the
   * `audit: 'message_send'` log line. Direct messages only —
   * sealing a group/community message has no meaning (server
   * already fans out one row per recipient and the inner ciphertext
   * is recipient-keyed).
   *
   * Server has no schema for the inner sealed payload; that's a
   * mobile-side wrap of `(sender_id, signal_ciphertext)` with the
   * recipient's identity public key. From the server's perspective
   * `ciphertext` is opaque either way.
   */
  sealed: boolean;
}

/**
 * Per spec §5: "Messages are deleted from the server on confirmed delivery,
 * regardless of local persistence settings. The 7-day TTL applies to the
 * relay buffer for undelivered messages only."
 *
 * The schema has a `delivered` flag, but in practice we delete on delivery.
 * The flag is a safety net for crashes between mark + delete.
 */
/**
 * Result of a per-device ack:
 *   - `not_found` — no row with that messageId.
 *   - `pending` — ack accepted, but other devices haven't acked yet.
 *     Row stays; `delivered` MUST NOT fire back to the sender.
 *   - `fully_delivered` — all targetDevices have now acked. Row was
 *     deleted; caller routes a `delivered` event back to the sender.
 */
export type AckResult =
  | { kind: 'not_found' }
  | { kind: 'pending' }
  | { kind: 'fully_delivered'; senderId: string; recipientId: string };

export interface MessagesRepo {
  /** Persist before forwarding. Returns the row's id. */
  insert(msg: Omit<BufferedMessage, 'createdAt'> & { createdAt?: Date }): Promise<void>;

  /**
   * Pull all undelivered messages drainable by `(recipientId,
   * deviceToken)`, oldest first. A row is drainable iff:
   *   - `targetDevices` is empty (legacy / no-device-known-at-insert), OR
   *   - `targetDevices` includes `deviceToken` AND
   *     `deliveredToDevices` does NOT include `deviceToken`.
   *
   * `deviceToken` is required so multi-device users don't redrain
   * messages they've already acked from a previous connection.
   */
  listUndeliveredFor(recipientId: string, deviceToken: string): Promise<BufferedMessage[]>;

  /**
   * Mark `deviceToken`'s ack of `messageId`. Per spec §11 Phase 5f:
   * row is deleted only when **all** known devices have acked;
   * `delivered` fires to the sender at that point.
   *
   * Legacy single-device shortcut: when `targetDevices` is empty (no
   * devices were known at insert time), any single ack deletes the row
   * — same as the pre-Phase-5f behaviour. This keeps first-time
   * recipients (no previous connection on file) working.
   */
  markDeliveredByDevice(messageId: string, deviceToken: string): Promise<AckResult>;
}
