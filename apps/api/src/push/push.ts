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
  /**
   * Sender id (handle), when known to the server. Omitted for
   * sealed-sender messages (server doesn't have it). Drives the
   * FCM/APNs banner copy alongside the recipient's per-device privacy
   * preference: `rich` + senderId → "@bananaman1: New message",
   * otherwise generic.
   */
  senderId?: string;
  /**
   * What was buffered. Default 'message'. 'call' triggers ringer copy
   * ("@bananaman1 is calling…") and stamps `notify_kind: 'call'` in
   * the FCM data block so the mobile app's foreground-message handler
   * can route to CallKeepBridge.displayIncomingCall on Android (iOS
   * needs PushKit for true lock-screen ringing — deferred with the
   * iOS APNs setup).
   */
  kind?: 'message' | 'call';
  /**
   * Explicit notification body. Normally omitted — payloads are
   * notify-only ("New message") because message content is E2E and the
   * server can't read it. The @speaker broadcast bot is the exception:
   * its messages are plaintext announcements the server *does* have, so
   * the broadcast passes the announcement text here to surface it
   * directly in the banner. 'rich' devices only.
   */
  body?: string;
  /**
   * The buffered message's id. Forwarded to the device in the FCM data
   * block so the headless push handler can decrypt + render the message
   * (and so the notification can be keyed for de-dup).
   */
  messageId?: string;
  /**
   * The message ciphertext, base64. The server can't read it (E2E), but
   * it forwards it in the FCM data block so the headless push handler
   * can decrypt it on-device and show the real text in the notification.
   * Omitted for sealed-sender messages and calls. Dropped from the push
   * when it would push the data payload past FCM's 4 KB limit — the
   * device then falls back to a generic "New message".
   */
  ciphertext?: string;
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
