/**
 * Buffer for delivery/read acks addressed to a sender with no live WS.
 *
 * The live path (AckRouter → ws/server.ts subscriber) emits a
 * `delivered` / `read` frame only to the sender's *currently connected*
 * sockets. The app closes its WS whenever it is backgrounded, so an ack
 * produced while the sender is backgrounded was simply dropped — the
 * sent message stayed on a single `✓` forever.
 *
 * This buffer catches those acks and drains them on the sender's next
 * WS auth, alongside the message + call-signaling drains. Applying a
 * `delivered` / `read` twice is idempotent on the client, so buffering
 * unconditionally (rather than only when the sender is offline) is
 * safe and avoids a presence lookup on every ack.
 */

export type BufferedAck =
  | { kind: 'delivered'; messageId: string }
  | { kind: 'read'; messageId: string; fromUserId: string };

export interface AckBuffer {
  /**
   * Record an ack for `senderId`. Best-effort — a dropped put just
   * means that one receipt won't catch up on the sender's reconnect.
   */
  put(senderId: string, ack: BufferedAck): void;
  /** Pop and return all pending acks for `senderId`, in arrival order. */
  drain(senderId: string): Promise<BufferedAck[]>;
}

/** Max acks held per sender — when exceeded, the oldest are dropped. */
export const ACK_BUFFER_CAP = 256;

/**
 * In-memory variant — tests + single-instance dev. A 2-machine deploy
 * needs the Redis variant: the sender may reconnect to a different
 * instance than the one that handled the recipient's ack.
 */
export function createAckBuffer(): AckBuffer {
  const byUser = new Map<string, BufferedAck[]>();
  return {
    put(senderId, ack) {
      const list = byUser.get(senderId) ?? [];
      list.push(ack);
      if (list.length > ACK_BUFFER_CAP) {
        list.splice(0, list.length - ACK_BUFFER_CAP);
      }
      byUser.set(senderId, list);
    },
    drain(senderId) {
      const list = byUser.get(senderId) ?? [];
      byUser.delete(senderId);
      return Promise.resolve(list);
    },
  };
}
