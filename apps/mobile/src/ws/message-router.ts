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

function utf8FromBytes(b: Uint8Array): string {
  return Buffer.from(b).toString('utf8');
}
function bytesFromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
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
            try {
              const plaintext = await deps.signalProtocol.decrypt(frame.from, ciphertext);
              bubble = utf8FromBytes(plaintext);
            } catch (err) {
              bubble = decodeBubble(err as Error);
            }
            const conversationId = deps.conversationIdFor(
              'direct',
              frame.from,
              deps.myUserId,
            );
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
          // Group message — the conversation id IS the group id.
          // (`to` field on the server-side frame doesn't make sense for
          // group messages since fan-out is implicit; the server's
          // delivery contract gives us only `from` and the group route
          // is encoded in the ciphertext envelope.)
          // For now we infer the group id from the message metadata.
          // Improvement: server adds a `group_id` field on group-typed
          // message frames.
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
            // Without an explicit group_id on the frame, we put the
            // message in a per-(sender) bucket keyed `group-from-<sender>`
            // until the server frame carries the group context. That's
            // a server-side TODO; client renders correctly once it arrives.
            const conversationId = `group-from-${frame.from}`;
            deps.addToConversation(conversationId, {
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
