import type { ApiClient } from '../api/client.js';
import type {
  GroupMessagingModule,
  SignalProtocolModule,
} from '@speakeasy/crypto';
import { SignalClientError } from '@speakeasy/crypto';
import {
  decodePayload,
  isSpeakerHandle,
  type Attachment,
  type WsServerMsg,
} from '@speakeasy/shared';
import type { SpeakeasyWsClient } from './client.js';
import type { GroupOrchestrator } from '../crypto/group-orchestration.js';
import type { ChatMessage } from '../store/conversations.js';
import { b64ToBytes as bytesFromB64, utf8FromBytes } from '../utils/bytes.js';
import { noteSessionEstablishedWith } from '../crypto/session.js';
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
  /**
   * Mark a previously-sent message as delivered. Fires from the
   * `delivered` WS frame the server emits when the recipient has
   * acked across all their devices (Phase 5f). Used to render the
   * `✓✓` glyph on sent bubbles.
   */
  markDelivered: (msgId: string) => void;
  /**
   * Stamp a sent message as visibly read. Fires from the `read` WS
   * frame the server forwards from the original recipient when they
   * open the chat. Surfaces as a brass `✓✓` (vs slate for delivered-
   * but-unread).
   */
  markMessageRead: (msgId: string, readAt: number) => void;
  /**
   * Implicit read-up-to. The peer just sent us a message in this
   * conversation; everything we sent before that point has by
   * definition been seen by them, so any outbound bubble older than
   * `readAt` gets stamped. Closes the gap when the peer's client
   * doesn't emit `read` WS frames (older builds, peers reading via
   * push only).
   */
  markReadUpTo: (conversationId: string, readAt: number) => void;
  /**
   * Idempotent: ensure the local `useGroups` store has metadata for
   * `groupId` (name + members). Fires when a group message arrives
   * for a groupId we've never seen — e.g., a freshly-added member
   * who's never opened the room. Pre-rc.48 the metadata never
   * propagated, so the chat AppBar showed the raw `grp-…` id and
   * `sendOutbound` failed with `[group not loaded]` because
   * `useGroups.byId[gid]` was undefined.
   */
  ensureGroupHydrated: (groupId: string) => Promise<void>;
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
  /**
   * Called every time the server returns an `authed` frame — i.e.
   * after every successful WS handshake (cold start, warm resume,
   * reconnect after network blip). App.tsx wires this to a
   * best-effort `tryRegisterPushToken()` re-sync.
   *
   * Why: signup's push-token registration is fire-and-forget
   * (HandleStep.tsx) and can silently fail (Firebase not ready,
   * network blip, app backgrounded mid-request). When it does, the
   * server has the device row but no push_token, so any push the
   * server tries to send hits the "no devices with push_token"
   * branch and gets silently dropped. The only thing that triggers
   * another attempt is a cold app launch — meaning brand-new users
   * are unreachable by push for the entire window between signup
   * and their next cold launch (~2 min observed in tester14's
   * incident on 2026-05-14).
   *
   * Wiring this to the `authed` frame closes the window from
   * "until next cold launch" to "next WS connection" (~1 second
   * after signup). Idempotent: `tryRegisterPushToken` collapses
   * duplicate calls via its in-flight + recency cache, so this
   * costs nothing when registration already succeeded.
   *
   * Optional so tests that don't care about push can omit it.
   */
  onAuthed?: () => void;
  /** Optional structured logger. Omitted in production unless a caller wires one. */
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export function makeMessageRouter(deps: MessageRouterDeps): (frame: WsServerMsg) => void {
  const log = deps.log ?? (() => {});

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
      // Underlying `sce.reason` is captured upstream in the diag log
      // (search "signal decrypt FAILED"); the bubble copy stays human.
      return sce.reason === 'untrusted_identity'
        ? '[identity changed — verify with peer]'
        : `[couldn’t decrypt this message]`;
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
        // Re-sync push token on every successful handshake. See
        // `onAuthed` doc comment for the bug this closes.
        deps.onAuthed?.();
        return;

      case 'pong':
        return;

      case 'error':
        log(`server error: ${frame.code} — ${frame.message}`);
        return;

      case 'delivered':
        diag('router', 'delivered', { msgId: frame.message_id });
        deps.markDelivered(frame.message_id);
        return;

      case 'read':
        diag('router', 'read', {
          msgId: frame.message_id,
          from: frame.from,
        });
        deps.markMessageRead(frame.message_id, Date.now());
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
          // Sealed-sender direct messages omit `from` — recipient is
          // expected to unwrap the inner envelope to recover sender
          // identity. Phase A (this commit) ships server-side wire
          // support but no mobile unwrap path yet — surface a
          // placeholder bubble + ack so the buffer drains, and log
          // the event so it's visible on the on-device Diagnostics
          // screen. Phase B will replace this with real unwrap.
          if (typeof frame.from !== 'string') {
            diag('router', 'direct: sealed-sender frame, no unwrap (Phase B)', {
              msgId: frame.message_id,
            });
            deps.ws.enqueueAck(frame.message_id);
            return;
          }
          // After the guard above, `frame.from` is narrowed to string.
          // Capture it once so the rest of this branch can keep using
          // the existing logic without per-line non-null assertions.
          const senderId: string = frame.from;
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
              let mentions: string[] | undefined;
              if (senderId === deps.myUserId || isSpeakerHandle(senderId)) {
                // Plaintext path: self-DM (raw utf-8, no self-session)
                // and @speaker broadcasts (announcements aren't E2E).
                // No libsignal decrypt — decode the v1 envelope directly.
                const raw = utf8FromBytes(ciphertext);
                const payload = decodePayload(raw);
                bubble = payload.text ?? '';
                attachments = payload.attachments;
                mentions = payload.mentions;
                decryptedOk = true;
                diag('router', 'message: plaintext decoded', {
                  ...frameDesc,
                  textPreview: bubble.slice(0, 24),
                  attachCount: attachments?.length ?? 0,
                  mentionCount: mentions?.length ?? 0,
                });
              } else {
                try {
                  const plaintext = await deps.signalProtocol.decrypt(
                    senderId,
                    ciphertext,
                  );
                  // rc.58: decrypt succeeded → libsignal has an
                  // established session for this peer. Mark it so the
                  // next outbound encrypt skips the destructive
                  // ensureSessionWithPeer re-initiation. See
                  // session.ts for the why.
                  noteSessionEstablishedWith(senderId);
                  const raw = utf8FromBytes(plaintext);
                  const payload = decodePayload(raw);
                  bubble = payload.text ?? '';
                  attachments = payload.attachments;
                  mentions = payload.mentions;
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
                  senderId,
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
                from: senderId,
                isSelf: senderId === deps.myUserId,
                textPreview: bubble.slice(0, 24),
              });
              const inboundSentAt = Date.now();
              try {
                deps.addToConversation(conversationId, {
                  id: frame.message_id,
                  from: senderId,
                  text: bubble,
                  attachments,
                  mentions,
                  kind: 'direct',
                  sentAt: inboundSentAt,
                  stage: 'sent',
                });
                diag('router', 'addToConversation OK', { convId: conversationId });
                if (attachments && senderId !== deps.myUserId) {
                  deps.onInboundAttachments?.(attachments);
                }
                // Implicit read receipts: the peer just sent us a
                // message, so they've necessarily seen everything we
                // sent in this conversation up to this point. Stamp
                // our prior outbound bubbles as read. Closes the gap
                // when the peer's client doesn't emit `read` frames
                // and outbound bubbles get stuck on a faded ✓✓.
                if (senderId !== deps.myUserId) {
                  deps.markReadUpTo(conversationId, inboundSentAt);
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
              if (decryptedOk && senderId !== deps.myUserId) {
                deps.notifyInbound?.({
                  msgId: frame.message_id,
                  from: senderId,
                  text: bubble,
                  target: { kind: 'direct', peerId: senderId },
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
          // Group/community messages always carry `from` — sealed
          // sender doesn't apply to fan-out frames. Type narrows
          // `frame.from` from `string | undefined` to `string`.
          if (typeof frame.from !== 'string') {
            diag('router', 'group: missing from (unexpected)', {
              msgId: frame.message_id,
            });
            return;
          }
          const groupSenderId: string = frame.from;
          // Server stamps the group id as conversation_id on the frame
          // (added when group messages can't carry it inside the
          // ciphertext envelope). Bucket directly into that group.
          void (async () => {
            try {
              // If an SKDM from the same sender is mid-flight (e.g.
              // both arrived together on a buffer drain after a
              // reconnect), wait for it to finish so the SenderKey is
              // installed before we try to decrypt.
              const pendingSkdm = pendingSkdms.get(groupSenderId);
              if (pendingSkdm) {
                diag('router', 'group: awaiting in-flight SKDM', {
                  msgId: frame.message_id,
                  from: groupSenderId,
                });
                await pendingSkdm;
                diag('router', 'group: SKDM settled, proceeding', {
                  msgId: frame.message_id,
                  from: groupSenderId,
                });
              }
              let bubble: string;
              let groupAttachments: Attachment[] | undefined;
              let groupMentions: string[] | undefined;
              let decryptedOk = false;
              try {
                const plaintext = await deps.groupMessaging.decryptFromGroupMember(
                  groupSenderId,
                  ciphertext,
                );
                const raw = utf8FromBytes(plaintext);
                const payload = decodePayload(raw);
                bubble = payload.text ?? '';
                groupAttachments = payload.attachments;
                groupMentions = payload.mentions;
                decryptedOk = true;
                diag('router', 'group: decrypted', {
                  msgId: frame.message_id,
                  from: groupSenderId,
                  textPreview: bubble.slice(0, 24),
                  attachCount: groupAttachments?.length ?? 0,
                });
              } catch (err) {
                bubble = decodeBubble(err as Error);
                diag('router', 'group: decrypt FAILED → bubble', {
                  msgId: frame.message_id,
                  from: groupSenderId,
                  bubble,
                  err: String(err),
                });
              }
              try {
                deps.addToConversation(frame.conversation_id, {
                  id: frame.message_id,
                  from: groupSenderId,
                  text: bubble,
                  attachments: groupAttachments,
                  mentions: groupMentions,
                  kind: 'group',
                  sentAt: Date.now(),
                  stage: 'sent',
                });
                diag('router', 'group: addToConversation OK', {
                  convId: frame.conversation_id,
                  msgId: frame.message_id,
                });
                // Make sure the room's metadata (name, members) is
                // hydrated locally so the chat AppBar + send path
                // work — see ensureGroupHydrated docs.
                void deps
                  .ensureGroupHydrated(frame.conversation_id)
                  .catch((err) =>
                    diag('router', 'ensureGroupHydrated threw', {
                      groupId: frame.conversation_id,
                      err: String(err),
                    }),
                  );
                if (groupAttachments && groupSenderId !== deps.myUserId) {
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
              if (decryptedOk && groupSenderId !== deps.myUserId) {
                deps.notifyInbound?.({
                  msgId: frame.message_id,
                  from: groupSenderId,
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
                from: groupSenderId,
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

      case 'channel_key_rotation_required':
        // Server tells us a community's channel key must rotate — fired
        // when a member is removed (spec §4b revocation guarantee).
        // Mobile-side orchestration ("elect a wrapper, generate fresh K,
        // upload new-epoch envelopes") is a future commit; for now we
        // just record the signal so the on-device Diagnostics screen
        // can show the user it landed.
        diag('router', 'channel_key_rotation_required', {
          community_id: frame.community_id,
          reason: frame.reason,
        });
        return;

      default: {
        const _exhaustive: never = frame;
        void _exhaustive;
      }
    }
  };
}
