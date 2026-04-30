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
    diag('router', `frame: ${frame.type}`, {
      ...((frame as { from?: string }).from ? { from: (frame as { from: string }).from } : {}),
      ...((frame as { msg_type?: string }).msg_type
        ? { msg_type: (frame as { msg_type: string }).msg_type }
        : {}),
    });
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
        const ciphertext = bytesFromB64(frame.ciphertext);
        if (frame.msg_type === 'direct') {
          void (async () => {
            let bubble: string;
            // Self-DM round-trip — sender already has the plaintext on
            // the optimistic bubble; the wire payload was utf-8 (no
            // libsignal encrypt). Decode directly instead of running
            // decrypt against a self-paired session that may not exist.
            if (frame.from === deps.myUserId) {
              bubble = utf8FromBytes(ciphertext);
            } else {
              try {
                const plaintext = await deps.signalProtocol.decrypt(frame.from, ciphertext);
                bubble = utf8FromBytes(plaintext);
              } catch (err) {
                bubble = decodeBubble(err as Error);
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
                from: frame.from,
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
            deps.addToConversation(conversationId, {
              id: frame.message_id,
              from: frame.from,
              text: bubble,
              kind: 'direct',
              sentAt: Date.now(),
              stage: 'sent',
            });
            try {
              deps.ws.send({ type: 'ack', message_id: frame.message_id });
            } catch {
              /* socket may be reconnecting; server retries on reconnect */
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
