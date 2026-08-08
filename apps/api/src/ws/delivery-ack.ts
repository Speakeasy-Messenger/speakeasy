import type { MessagesRepo } from '../db/messages.js';
import type { AckRouter } from './ack-router.js';
import type { AckBuffer } from './ack-buffer.js';

export interface DeliveryAckDeps {
  messages: MessagesRepo;
  ackRouter: AckRouter;
  ackBuffer: AckBuffer;
  instanceId: string;
}

/**
 * Record one device's delivery ack for a message and, when that completes
 * delivery to all of the recipient's known devices, notify the sender (✓✓).
 *
 * This is the SINGLE implementation shared by two callers so they can't drift:
 *   - the WebSocket `ack` frame (foreground / connected client), and
 *   - `POST /v1/messages/delivered` (background push handler, which has network
 *     but no open WebSocket).
 *
 * Deleting the relay row is what stops the message-retry worker from re-sending
 * the push — so a backgrounded-but-alive phone that received the notification
 * must call the HTTP endpoint, or it would get a needless retry ~45s later.
 */
export async function applyDeliveryAck(
  deps: DeliveryAckDeps,
  messageId: string,
  deviceToken: string,
): Promise<void> {
  const result = await deps.messages.markDeliveredByDevice(messageId, deviceToken);
  if (result.kind !== 'fully_delivered') return; // pending / not_found → no side effect

  // Reaches a sender who is online right now (cross-instance).
  void deps.ackRouter.announce({
    messageId,
    senderId: result.senderId,
    instanceId: deps.instanceId,
    kind: 'delivered',
  });
  // Catch-up so a backgrounded sender still sees ✓✓ on reconnect.
  deps.ackBuffer.put(result.senderId, { kind: 'delivered', messageId });
}
