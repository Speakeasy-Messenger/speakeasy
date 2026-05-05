import type { ApiClient } from '../api/client.js';
import type {
  GroupMessagingModule,
  SignalProtocolModule,
} from '@speakeasy/crypto';
import { SignalClientError } from '@speakeasy/crypto';
import type { WsServerMsg } from '@speakeasy/shared';
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
  /** Optional structured logger; defaults to console. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export function makeMessageRouter(deps: MessageRouterDeps): (frame: WsServerMsg) => void {
  const log = deps.log ?? ((m, c) => console.log('[ws]', m, c ?? ''));

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

      case 'skdm':
        // SKDM bootstrap envelope — install the SenderKey + ack the
        // server so it deletes the buffered row.
        void deps.orchestrator
          .handleIncomingSkdm({
            from: frame.from,
            group_id: frame.group_id,
            ciphertext: frame.ciphertext,
            message_id: frame.message_id,
          })
          .catch((err) => log('skdm handle failed', { err: String(err), from: frame.from }));
        return;

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
              // Self-DM round-trip — sender already has the plaintext on
              // the optimistic bubble; the wire payload was utf-8 (no
              // libsignal encrypt). Decode directly instead of running
              // decrypt against a self-paired session that may not exist.
              if (frame.from === deps.myUserId) {
                bubble = utf8FromBytes(ciphertext);
                diag('router', 'message: self-DM utf8 decoded', {
                  ...frameDesc,
                  textPreview: bubble.slice(0, 24),
                });
              } else {
                try {
                  const plaintext = await deps.signalProtocol.decrypt(
                    frame.from,
                    ciphertext,
                  );
                  bubble = utf8FromBytes(plaintext);
                  diag('router', 'message: signal decrypted', {
                    ...frameDesc,
                    textPreview: bubble.slice(0, 24),
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
                  kind: 'direct',
                  sentAt: Date.now(),
                  stage: 'sent',
                });
                diag('router', 'addToConversation OK', { convId: conversationId });
              } catch (err) {
                diag('router', 'addToConversation THREW', {
                  convId: conversationId,
                  err: String(err),
                });
                return;
              }
              try {
                deps.ws.send({ type: 'ack', message_id: frame.message_id });
                diag('router', 'ack sent', { msgId: frame.message_id });
              } catch (err) {
                diag('router', 'ack send FAILED', {
                  msgId: frame.message_id,
                  err: String(err),
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
            let bubble: string;
            try {
              const plaintext = await deps.groupMessaging.decryptFromGroupMember(
                frame.from,
                ciphertext,
              );
              bubble = utf8FromBytes(plaintext);
            } catch (err) {
              bubble = decodeBubble(err as Error);
            }
            deps.addToConversation(frame.conversation_id, {
              id: frame.message_id,
              from: frame.from,
              text: bubble,
              kind: 'group',
              sentAt: Date.now(),
              stage: 'sent',
            });
            try {
              deps.ws.send({ type: 'ack', message_id: frame.message_id });
            } catch {
              /* ignore */
            }
          })();
        } else {
          // community — not yet wired into a screen; ack so the buffer drains.
          try {
            deps.ws.send({ type: 'ack', message_id: frame.message_id });
          } catch {
            /* ignore */
          }
          log('dropping community message — UI not yet wired', {
            from: frame.from,
            messageId: frame.message_id,
          });
        }
        return;
      }

      default: {
        const _exhaustive: never = frame;
        void _exhaustive;
      }
    }
  };
}
