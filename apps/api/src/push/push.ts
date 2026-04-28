/**
 * Push notifications — spec §11 hardening.
 *
 * **Notify-only.** Per spec, payloads carry no message content. Just
 * "you have new messages" + a hint of which conversation, so the device
 * can show a badge or surface a generic notification. The actual content
 * stays end-to-end encrypted on the wire and can only be decrypted when
 * the user opens the app.
 */

import type { ConversationKind } from '@speakeasy/shared';

export interface PushDeliveryNotice {
  /** The recipient's adjective-adjective-noun id. */
  userId: string;
  /** The conversation the buffered message lives on. */
  conversationId: string;
  msgType: ConversationKind;
}

export interface PushProvider {
  /** Trigger a notify-only push for `userId`. */
  notifyDelivery(notice: PushDeliveryNotice): Promise<void>;
}

/**
 * Default. Does nothing (logs at debug). Real production wiring is
 * `FcmApnsPushProvider` in `push.fcm-apns.ts` (placeholder until cloud
 * keys are wired).
 */
export class NoopPushProvider implements PushProvider {
  constructor(private readonly log?: (msg: string, ctx?: unknown) => void) {}
  async notifyDelivery(notice: PushDeliveryNotice): Promise<void> {
    this.log?.('push (noop)', notice);
  }
}
