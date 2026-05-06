import type { ApiClient } from '../api/client.js';
import type {
  GroupMessagingModule,
  SignalProtocolModule,
} from '@speakeasy/crypto';
import { SignalClientError } from '@speakeasy/crypto';
import {
  decodePayload,
  type Attachment,
  type WsServerMsg,
} from '@speakeasy/shared';
import type { SpeakeasyWsClient } from './client.js';
import type { GroupOrchestrator } from '../crypto/group-orchestration.js';
import type { ChatMessage } from '../store/conversations.js';
import { b64ToBytes as bytesFromB64, utf8FromBytes } from '../utils/bytes.js';
import { diag } from '../diag/log.js';

/**
 * Single dispatcher for every inbound WS frame.
 *
 * Pre-Phase-5e, ChatScreen subscribed to the WS client directly and
 * filtered for `direct` frames addressed to the open peer. That worked
 * for one screen but dropped group messages, dropped SKDMs, and
 * required every screen to re-implement the decrypt + ack dance.
 *
 * Now App.tsx wires this once and every frame ends up in the right
 * store, regardless of which screen is mounted. ChatScreen +
 * GroupChatScreen become read-only views over the conversations store.
 */

export interface MessageRouterDeps {
  myUserId: string;
  api: ApiClient;
  signalProtocol: SignalProtocolModule;
  groupMessaging: GroupMessagingModule;
  ws: SpeakeasyWsClient;
  orchestrator: GroupOrchestrator;
  /**
   * Inbound voice-call signaling sink. Optional so unit tests of the
   * messaging path don't have to construct a CallOrchestrator.
   */
  onCallFrame?: (frame: WsServerMsg) => void;
  /** Called when prekey replenishment should fire. */
  onPrekeysLow: () => void;
  /** Add a chat message to the right conversation. */
  addToConversation: (conversationId: string, msg: ChatMessage) => void;
  /** Resolve a conversation id from a message frame. */
  conversationIdFor: (
    msgType: 'direct' | 'group' | 'community',
    senderId: string,
    to: string,
  ) => string;
  /**
   * Fires for each successfully-decrypted inbound message. Caller is
   * responsible for whatever foreground-notification UX it wants
   * (in-app banner, OS notification, ignore on the active chat, etc.)
   * — the router just hands over the decoded text + routing target.
   * Skipped on decrypt failures (the bubble already says
   * `[decrypt failed: …]`; surfacing that as a notification is noise).
   */
  notifyInbound?: (n: {
    msgId: string;
    from: string;
    text: string;
    target:
      | { kind: 'direct'; peerId: string }
      | { kind: 'group'; groupId: string };
  }) => void;
  /**
   * Called once per successfully-decrypted inbound message that
   * carries `image` / `gif` / `file` attachments. App-level wiring
   * uses this to auto-save photos to the device gallery
   * (WhatsApp-style). Failures are non-fatal — chat rendering still
   * works regardless.
   */
  onInboundAttachments?: (attachments: Attachment[]) => void;
  /** Optional structured logger; defaults to console. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export function makeMessageRouter(deps: MessageRouterDeps): (frame: WsServerMsg) => void {
  const log = deps.log ?? ((m, c) => console.log('[ws]', m, c ?? ''));

  // Per-sender SKDM in-flight tracker. The server delivers an SKDM
  // bootstrap envelope right before the first group message from a
  // new sender (orchestrator's `sendGroupMessage` does SKDM-then-
  // message in that order, and the server's buffer-drain preserves
  // it). Both frames land on the WS within ms of each other; SKDM
  // processing is a couple of native calls (signal decrypt +
  // processSenderKeyDistribution), each potentially hundreds of ms.
  // If the group message races ahead, `decryptFromGroupMember` finds
  // no SenderKey and rejects — silently, because the catch only logs
  // the bubble. We track the in-flight handler promise per sender
  // and have group decrypts await it.
  const pendingSkdms = new Map<string, Promise<void>>();

  function decodeBubble(decryptResult: Uint8Array | Error): string {
    if (decryptResult instanceof Error) {
      const sce = decryptResult as SignalClientError;
      return sce.reason === 'untrusted_identity'
        ? '[identity changed — verify with peer]'
        : `[decrypt failed: ${sce.reason ?? sce.message}]`;
    }
    return utf8FromBytes(decryptResult);
  }

  return (frame: WsServerMsg) => {
    const breadcrumb: Record<string, unknown> = {};
    const f = frame as {
      from?: string;
      msg_type?: string;
      code?: string;
      message?: string;
    };
    if (f.from) breadcrumb.from = f.from;
    if (f.msg_type) breadcrumb.msg_type = f.msg_type;
    // Surface server-side error reasons on the on-device Diagnostics
    // screen — without these, error frames showed up as `error {}` and
    // gave the user nothing to act on (or report).
    if (frame.type === 'error') {
      breadcrumb.code = f.code;
      breadcrumb.message = f.message;
    }
    diag('router', `frame: ${frame.type}`, breadcrumb);
    switch (frame.type) {
      case 'authed':
      case 'pong':
        return;

      case 'error':
        log(`server error: ${frame.code} — ${frame.message}`);
        return;

      case 'delivered':
        // Phase 5e: client doesn't yet render delivered receipts. Wire
        // when conversation persistence lands and we want a "✓✓ seen"
        // affordance.
        return;

      case 'prekeys_low':
        deps.onPrekeysLow();
        return;

      case 'skdm': {
        // SKDM bootstrap envelope — install the SenderKey + ack the
        // server so it deletes the buffered row. Track the in-flight
        // promise per sender so a group message arriving in the same
        // tick can await it (otherwise `decryptFromGroupMember`
        // rejects with no SenderKey installed yet).
        diag('router', 'skdm: enter', {
          msgId: frame.message_id,
          from: frame.from,
          groupId: frame.group_id,
        });
        const senderId = frame.from;
        const messageId = frame.message_id;
        const handled = deps.orchestrator
          .handleIncomingSkdm({
            from: senderId,
            group_id: frame.group_id,
            ciphertext: frame.ciphertext,
            message_id: messageId,
          })
          .then(
            () => {
              diag('router', 'skdm: handled OK', {
                msgId: messageId,
                from: senderId,
              });
            },
            (err) => {
              diag('router', 'skdm: handle FAILED', {
                msgId: messageId,
                from: senderId,
                err: String(err),
              });
              log('skdm handle failed', { err: String(err), from: senderId });
            },
          );
        pendingSkdms.set(senderId, handled);
        // Clear the pending entry once settled — only if it still
        // points at us; a fresher SKDM from the same sender may have
        // replaced it while we were running.
        void handled.finally(() => {
          if (pendingSkdms.get(senderId) === handled) {
            pendingSkdms.delete(senderId);
          }
        });
        return;
      }

      case 'message': {
        // Bulletproof wrapper — every step gets a diag breadcrumb so a
        // silent failure inside the IIFE can be pinpointed from the
        // on-device diagnostics screen. The previous version had only
        // diags AROUND `conversationIdFor`; if anything BEFORE it threw
        // (b64 decode, utf8 decode, signal decrypt) the unhandled
        // promise rejection was swallowed by the WS subscriber's outer
        // try/catch, leaving zero on-device evidence of where it died.
        const frameDesc = {
          msgId: frame.message_id,
          from: frame.from,
          msgType: frame.msg_type,
          ctLen: typeof frame.ciphertext === 'string' ? frame.ciphertext.length : -1,
        };
        diag('router', 'message: enter', frameDesc);
        let ciphertext: Uint8Array;
        try {
          ciphertext = bytesFromB64(frame.ciphertext);
        } catch (err) {
          diag('router', 'b64ToBytes THREW', { ...frameDesc, err: String(err) });
          return;
        }
        diag('router', 'message: b64 decoded', { ...frameDesc, bytes: ciphertext.length });
        if (frame.msg_type === 'direct') {
          void (async () => {
            try {
              let bubble: string;
              // `decryptedOk` gates the inbound notification — we don't
              // want to drop "[decrypt failed: …]" placeholders into a
              // banner toast.
              let decryptedOk = false;
              // Self-DM round-trip — sender already has the plaintext on
              // the optimistic bubble; the wire payload was utf-8 (no
              // libsignal encrypt). Decode directly instead of running
              // decrypt against a self-paired session that may not exist.
              let attachments: Attachment[] | undefined;
              if (frame.from === deps.myUserId) {
                const raw = utf8FromBytes(ciphertext);
                const payload = decodePayload(raw);
                bubble = payload.text ?? '';
                attachments = payload.attachments;
                diag('router', 'message: self-DM utf8 decoded', {
                  ...frameDesc,
                  textPreview: bubble.slice(0, 24),
                  attachCount: attachments?.length ?? 0,
                });
              } else {
                try {
                  const plaintext = await deps.signalProtocol.decrypt(
                    frame.from,
                    ciphertext,
                  );
                  const raw = utf8FromBytes(plaintext);
                  const payload = decodePayload(raw);
                  bubble = payload.text ?? '';
                  attachments = payload.attachments;
                  decryptedOk = true;
                  diag('router', 'message: signal decrypted', {
                    ...frameDesc,
                    textPreview: bubble.slice(0, 24),
                    attachCount: attachments?.length ?? 0,
                  });
                } catch (err) {
                  bubble = decodeBubble(err as Error);
                  diag('router', 'message: signal decrypt FAILED → bubble', {
                    ...frameDesc,
                    bubble,
                  });
                }
              }
              let conversationId: string;
              try {
                conversationId = deps.conversationIdFor(
                  'direct',
                  frame.from,
                  deps.myUserId,
                );
              } catch (err) {
                diag('router', 'conversationIdFor THREW', {
                  ...frameDesc,
                  me: deps.myUserId,
                  err: String(err),
                });
                return;
              }
              diag('router', 'add direct to conversation', {
                convId: conversationId,
                from: frame.from,
                isSelf: frame.from === deps.myUserId,
                textPreview: bubble.slice(0, 24),
              });
              try {
                deps.addToConversation(conversationId, {
                  id: frame.message_id,
                  from: frame.from,
                  text: bubble,
                  attachments,
                  kind: 'direct',
                  sentAt: Date.now(),
                  stage: 'sent',
                });
                diag('router', 'addToConversation OK', { convId: conversationId });
                if (attachments && frame.from !== deps.myUserId) {
                  deps.onInboundAttachments?.(attachments);
                }
              } catch (err) {
                diag('router', 'addToConversation THREW', {
                  convId: conversationId,
                  err: String(err),
                });
                return;
              }
              deps.ws.enqueueAck(frame.message_id);
              diag('router', 'ack queued', { msgId: frame.message_id });
              if (decryptedOk && frame.from !== deps.myUserId) {
                deps.notifyInbound?.({
                  msgId: frame.message_id,
                  from: frame.from,
                  text: bubble,
                  target: { kind: 'direct', peerId: frame.from },
                });
              }
            } catch (err) {
              // Catch-all so unhandled rejections never disappear into
              // the WS subscriber's outer try/catch.
              diag('router', 'direct IIFE CRASHED', {
                ...frameDesc,
                err: String(err),
                stack: (err as { stack?: string }).stack?.slice(0, 240) ?? '',
              });
            }
          })();
        } else if (frame.msg_type === 'group') {
          // Server stamps the group id as conversation_id on the frame
          // (added when group messages can't carry it inside the
          // ciphertext envelope). Bucket directly into that group.
          void (async () => {
            try {
              // If an SKDM from the same sender is mid-flight (e.g.
              // both arrived together on a buffer drain after a
              // reconnect), wait for it to finish so the SenderKey is
              // installed before we try to decrypt.
              const pendingSkdm = pendingSkdms.get(frame.from);
              if (pendingSkdm) {
                diag('router', 'group: awaiting in-flight SKDM', {
                  msgId: frame.message_id,
                  from: frame.from,
                });
                await pendingSkdm;
                diag('router', 'group: SKDM settled, proceeding', {
                  msgId: frame.message_id,
                  from: frame.from,
                });
              }
              let bubble: string;
              let groupAttachments: Attachment[] | undefined;
              let decryptedOk = false;
              try {
                const plaintext = await deps.groupMessaging.decryptFromGroupMember(
                  frame.from,
                  ciphertext,
                );
                const raw = utf8FromBytes(plaintext);
                const payload = decodePayload(raw);
                bubble = payload.text ?? '';
                groupAttachments = payload.attachments;
                decryptedOk = true;
                diag('router', 'group: decrypted', {
                  msgId: frame.message_id,
                  from: frame.from,
                  textPreview: bubble.slice(0, 24),
                  attachCount: groupAttachments?.length ?? 0,
                });
              } catch (err) {
                bubble = decodeBubble(err as Error);
                diag('router', 'group: decrypt FAILED → bubble', {
                  msgId: frame.message_id,
                  from: frame.from,
                  bubble,
                  err: String(err),
                });
              }
              try {
                deps.addToConversation(frame.conversation_id, {
                  id: frame.message_id,
                  from: frame.from,
                  text: bubble,
                  attachments: groupAttachments,
                  kind: 'group',
                  sentAt: Date.now(),
                  stage: 'sent',
                });
                diag('router', 'group: addToConversation OK', {
                  convId: frame.conversation_id,
                  msgId: frame.message_id,
                });
                if (groupAttachments && frame.from !== deps.myUserId) {
                  deps.onInboundAttachments?.(groupAttachments);
                }
              } catch (err) {
                diag('router', 'group: addToConversation THREW', {
                  convId: frame.conversation_id,
                  msgId: frame.message_id,
                  err: String(err),
                });
                return;
              }
              deps.ws.enqueueAck(frame.message_id);
              diag('router', 'group: ack queued', { msgId: frame.message_id });
              if (decryptedOk && frame.from !== deps.myUserId) {
                deps.notifyInbound?.({
                  msgId: frame.message_id,
                  from: frame.from,
                  text: bubble,
                  target: { kind: 'group', groupId: frame.conversation_id },
                });
              }
            } catch (err) {
              // Catch-all so any unhandled rejection makes it to the
              // on-device Diagnostics screen instead of vanishing into
              // the WS subscriber's outer try/catch.
              diag('router', 'group IIFE CRASHED', {
                msgId: frame.message_id,
                from: frame.from,
                err: String(err),
                stack: (err as { stack?: string }).stack?.slice(0, 240) ?? '',
              });
            }
          })();
        } else {
          // community — not yet wired into a screen; ack so the buffer drains.
          deps.ws.enqueueAck(frame.message_id);
          log('dropping community message — UI not yet wired', {
            from: frame.from,
            messageId: frame.message_id,
          });
        }
        return;
      }

      case 'call_offer':
      case 'call_answer':
      case 'call_ice':
      case 'call_end':
        deps.onCallFrame?.(frame);
        return;

      default: {
        const _exhaustive: never = frame;
        void _exhaustive;
      }
    }
  };
}
