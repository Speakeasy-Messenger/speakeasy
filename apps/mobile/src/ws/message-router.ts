import type { ApiClient } from '../api/client.js';
import type {
  GroupMessagingModule,
  SignalProtocolModule,
} from '@speakeasy/crypto';
import { GroupMessagingClientError, SignalClientError } from '@speakeasy/crypto';
import {
  decodePayload,
  isSpeakerHandle,
  type Attachment,
  type ReplyContext,
  type WsServerMsg,
} from '@speakeasy/shared';
import type { SpeakeasyWsClient } from './client.js';
import type { GroupOrchestrator } from '../crypto/group-orchestration.js';
import type { ChatMessage } from '../store/conversations.js';
import { b64ToBytes as bytesFromB64, utf8FromBytes } from '../utils/bytes.js';
import { noteSessionEstablishedWith } from '../crypto/session.js';
import { diag, diagFingerprint } from '../diag/log.js';

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
  /**
   * Counterpart to the server's `peer_deleted` WS frame: the recipient
   * of a direct message the user just sent has deleted their account.
   * Caller surfaces an in-chat system bubble + freezes the chat
   * (input disabled, no resend). Phase 1 peer-deleted notification.
   *
   * Optional so unit tests of the router that don't exercise the
   * tombstone path can omit it.
   */
  onPeerDeleted?: (handle: string) => void;
  /**
   * A peer asked us (via an `skdm_request` frame) to re-send our SenderKey
   * for a group they can't decrypt our messages in. Wired to the group
   * orchestrator's `redistributeSenderKey(groupId, peer)`. Optional so
   * router unit tests can omit it.
   */
  onSkdmRequest?: (from: string, groupId: string) => void | Promise<void>;
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

  // ── Direct-message buffer-and-retry ────────────────────────────────
  //
  // The direct analog of the group `pendingSkdms` await above. A direct
  // message can land before the PreKey message that establishes its
  // Signal session — e.g. a sender's establish-then-send pair drains out
  // of order on a reconnect, or the two race on the wire. The later
  // (non-establishing) message then fails to decrypt with "no session",
  // and the old code dropped a permanent `[couldn't decrypt]` bubble with
  // no retry — exactly the one-off amiiz failure.
  //
  // Instead we hold the ciphertext keyed by sender and replay it once a
  // *later* message from that sender decrypts successfully (which means
  // the session is now established). A timeout flushes it as the dead
  // bubble if no establishing message ever arrives, so a genuinely
  // undecryptable message (corrupt / never-established) still surfaces —
  // just delayed, never wrong. We deliberately do NOT ack a buffered
  // message: the server keeps the relay row as a backup until we either
  // succeed or give up, so an app restart mid-window recovers on the next
  // drain instead of losing the ciphertext.
  interface BufferedDirect {
    frame: { from?: string; message_id: string; sent_at?: number };
    ciphertext: Uint8Array;
    timer: ReturnType<typeof setTimeout>;
  }
  const pendingDirectRetry = new Map<string, BufferedDirect[]>();
  const DIRECT_RETRY_TIMEOUT_MS = 12_000;
  const MAX_BUFFERED_DIRECT_PER_SENDER = 50;

  function isRecoverableDecryptError(err: unknown): boolean {
    // `untrusted_identity` has its own actionable bubble and a retry won't
    // fix it; everything else (notably the "no session yet" ordering race)
    // gets one buffered retry window.
    if (err instanceof SignalClientError) return err.reason !== 'untrusted_identity';
    return true;
  }

  // Buffer a direct frame for retry. Returns true if buffered (caller skips
  // render + ack); false if the per-sender cap is hit (fall back to the
  // dead bubble so we never grow unbounded).
  function bufferDirect(
    senderId: string,
    frame: BufferedDirect['frame'],
    ciphertext: Uint8Array,
  ): boolean {
    let buf = pendingDirectRetry.get(senderId);
    // Server may redeliver the still-unacked message; don't double-buffer.
    if (buf?.some((b) => b.frame.message_id === frame.message_id)) return true;
    if (buf && buf.length >= MAX_BUFFERED_DIRECT_PER_SENDER) return false;
    if (!buf) {
      buf = [];
      pendingDirectRetry.set(senderId, buf);
    }
    const timer = setTimeout(() => {
      const cur = pendingDirectRetry.get(senderId);
      const idx = cur?.findIndex((b) => b.frame.message_id === frame.message_id) ?? -1;
      if (!cur || idx === -1) return;
      const [entry] = cur.splice(idx, 1);
      if (cur.length === 0) pendingDirectRetry.delete(senderId);
      diag('router', 'message: buffered decrypt timed out — giving up', {
        msgId: frame.message_id,
        peerFp: diagFingerprint(senderId),
      });
      void processDirectFrame(entry!.frame, entry!.ciphertext, senderId, true);
    }, DIRECT_RETRY_TIMEOUT_MS);
    buf.push({ frame, ciphertext, timer });
    return true;
  }

  // A message from `senderId` just decrypted — the session is established,
  // so replay anything we were holding for them.
  function drainDirectRetry(senderId: string): void {
    const buf = pendingDirectRetry.get(senderId);
    if (!buf || buf.length === 0) return;
    pendingDirectRetry.delete(senderId);
    diag('router', 'message: session established — replaying buffered', {
      peerFp: diagFingerprint(senderId),
      count: buf.length,
    });
    for (const entry of buf) {
      clearTimeout(entry.timer);
      void processDirectFrame(entry.frame, entry.ciphertext, senderId, true);
    }
  }

  // Process one direct message end-to-end: decrypt (or decode the
  // plaintext self/@speaker path) → add to the conversation → ack →
  // notify. `isReplay` is true for buffered retries; it suppresses
  // re-buffering so a still-failing message gives up to the dead bubble
  // after one attempt instead of looping.
  async function processDirectFrame(
    frame: { from?: string; message_id: string; sent_at?: number },
    ciphertext: Uint8Array,
    senderId: string,
    isReplay: boolean,
  ): Promise<void> {
    const frameDesc = {
      msgId: frame.message_id,
      peerFp: diagFingerprint(senderId),
      msgType: 'direct' as const,
    };
    try {
      let bubble: string;
      // `decryptedOk` gates the inbound notification — we don't want to
      // drop "[couldn't decrypt]" placeholders into a banner toast.
      let decryptedOk = false;
      let attachments: Attachment[] | undefined;
      let mentions: string[] | undefined;
      let replyTo: ReplyContext | undefined;
      if (senderId === deps.myUserId || isSpeakerHandle(senderId)) {
        // Plaintext path: self-DM (raw utf-8, no self-session) and
        // @speaker broadcasts (announcements aren't E2E). No libsignal
        // decrypt — decode the v1 envelope directly.
        const raw = utf8FromBytes(ciphertext);
        const payload = decodePayload(raw);
        bubble = payload.text ?? '';
        attachments = payload.attachments;
        mentions = payload.mentions;
        replyTo = payload.replyTo;
        decryptedOk = true;
        diag('router', 'message: plaintext decoded', {
          ...frameDesc,
          textLen: bubble.length,
          attachCount: attachments?.length ?? 0,
          mentionCount: mentions?.length ?? 0,
        });
      } else {
        try {
          const plaintext = await deps.signalProtocol.decrypt(senderId, ciphertext);
          // rc.58: decrypt succeeded → libsignal has an established
          // session for this peer. Mark it so the next outbound encrypt
          // skips the destructive ensureSessionWithPeer re-initiation.
          noteSessionEstablishedWith(senderId);
          const raw = utf8FromBytes(plaintext);
          const payload = decodePayload(raw);
          bubble = payload.text ?? '';
          attachments = payload.attachments;
          mentions = payload.mentions;
          replyTo = payload.replyTo;
          decryptedOk = true;
          diag('router', 'message: signal decrypted', {
            ...frameDesc,
            textLen: bubble.length,
            attachCount: attachments?.length ?? 0,
          });
        } catch (err) {
          // No session yet (or another recoverable failure): hold and
          // replay once a later message establishes the session, rather
          // than dropping a permanent dead bubble. See the buffer doc.
          if (!isReplay && isRecoverableDecryptError(err) && bufferDirect(senderId, frame, ciphertext)) {
            diag('router', 'message: decrypt deferred — buffered for session', {
              ...frameDesc,
              err: String(err),
            });
            return;
          }
          bubble = decodeBubble(err as Error);
          diag('router', 'message: signal decrypt FAILED → bubble', {
            ...frameDesc,
            isReplay,
            bubble,
          });
        }
      }
      let conversationId: string;
      try {
        conversationId = deps.conversationIdFor('direct', senderId, deps.myUserId);
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
        peerFp: diagFingerprint(senderId),
        isSelf: senderId === deps.myUserId,
        textLen: bubble.length,
      });
      // Prefer the server's authoritative send time so a backlog draining
      // all at once keeps each message's real timestamp instead of
      // collapsing onto "now". Falls back to receive time for pre-rc.51
      // servers.
      const inboundSentAt = frame.sent_at ?? Date.now();
      try {
        deps.addToConversation(conversationId, {
          id: frame.message_id,
          from: senderId,
          text: bubble,
          attachments,
          mentions,
          replyTo,
          kind: 'direct',
          sentAt: inboundSentAt,
          stage: 'sent',
        });
        diag('router', 'addToConversation OK', { convId: conversationId });
        if (attachments && senderId !== deps.myUserId) {
          deps.onInboundAttachments?.(attachments);
        }
        // Implicit read receipts: the peer just sent us a message, so
        // they've necessarily seen everything we sent in this conversation
        // up to this point. Stamp our prior outbound bubbles as read.
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
      // A real decrypt means the session is now established — replay
      // anything we were holding for this sender (the ordering-race fix).
      if (decryptedOk) drainDirectRetry(senderId);
    } catch (err) {
      // Catch-all so unhandled rejections never disappear into the WS
      // subscriber's outer try/catch.
      diag('router', 'direct IIFE CRASHED', {
        ...frameDesc,
        err: String(err),
        stack: (err as { stack?: string }).stack?.slice(0, 240) ?? '',
      });
    }
  }

  // ── Group-message buffer + SKDM re-request ─────────────────────────
  //
  // The group analog of the direct buffer above, for the OTHER cause of a
  // missing sender key: not an in-flight SKDM (handled by `pendingSkdms`),
  // but one that was never received at all — the recipient joined the
  // group after the sender last distributed, the sender's SKDM was lost,
  // or the recipient reinstalled. The group decrypt then fails `no_session`
  // ("missing sender key state for distribution ID …") with nothing in
  // flight to wait for.
  //
  // We hold the message, ask the sender to re-send their SKDM
  // (`skdm_request`, rate-limited per sender+group), and replay the
  // buffered messages once that SKDM is processed. A timeout flushes the
  // dead bubble if the key never arrives. Like the direct buffer, a held
  // message is NOT acked, so the server keeps the relay row as a backup.
  interface BufferedGroup {
    frame: { from?: string; message_id: string; conversation_id: string; sent_at?: number };
    ciphertext: Uint8Array;
    timer: ReturnType<typeof setTimeout>;
  }
  const pendingGroupRetry = new Map<string, BufferedGroup[]>();
  const GROUP_RETRY_TIMEOUT_MS = 15_000;
  const MAX_BUFFERED_GROUP_PER_SENDER = 100;
  // Per (sender\0group) timestamp of the last skdm_request we sent, so a
  // backlog of undecryptable messages from one sender fires a single
  // request, not one per message.
  const lastSkdmRequestAt = new Map<string, number>();
  const SKDM_REQUEST_COOLDOWN_MS = 10_000;

  function isMissingSenderKey(err: unknown): boolean {
    // Production throws a GroupMessagingClientError (`.reason`); be tolerant
    // of the plain `{ code }` shape too (mock + any unwrapped native reject)
    // so the recovery path doesn't hinge on the error class.
    if (err instanceof GroupMessagingClientError) return err.reason === 'no_session';
    const code =
      (err as { reason?: string } | null)?.reason ?? (err as { code?: string } | null)?.code;
    return code === 'no_session';
  }

  function requestSkdm(senderId: string, groupId: string): void {
    const key = `${senderId} ${groupId}`;
    const last = lastSkdmRequestAt.get(key) ?? 0;
    const now = Date.now();
    if (now - last < SKDM_REQUEST_COOLDOWN_MS) return;
    lastSkdmRequestAt.set(key, now);
    diag('router', 'group: requesting SKDM re-send', {
      peerFp: diagFingerprint(senderId),
      groupId,
    });
    deps.ws.enqueueSend({ type: 'skdm_request', to: senderId, group_id: groupId });
  }

  // Buffer a group frame for retry. Returns true if buffered (caller skips
  // render + ack); false if the per-sender cap is hit.
  function bufferGroup(
    senderId: string,
    frame: BufferedGroup['frame'],
    ciphertext: Uint8Array,
  ): boolean {
    let buf = pendingGroupRetry.get(senderId);
    if (buf?.some((b) => b.frame.message_id === frame.message_id)) return true;
    if (buf && buf.length >= MAX_BUFFERED_GROUP_PER_SENDER) return false;
    if (!buf) {
      buf = [];
      pendingGroupRetry.set(senderId, buf);
    }
    const timer = setTimeout(() => {
      const cur = pendingGroupRetry.get(senderId);
      const idx = cur?.findIndex((b) => b.frame.message_id === frame.message_id) ?? -1;
      if (!cur || idx === -1) return;
      const [entry] = cur.splice(idx, 1);
      if (cur.length === 0) pendingGroupRetry.delete(senderId);
      diag('router', 'group: buffered decrypt timed out — giving up', {
        msgId: frame.message_id,
        peerFp: diagFingerprint(senderId),
      });
      void processGroupFrame(entry!.frame, entry!.ciphertext, senderId, true);
    }, GROUP_RETRY_TIMEOUT_MS);
    buf.push({ frame, ciphertext, timer });
    return true;
  }

  // An SKDM from `senderId` was just installed — replay anything we were
  // holding for them. Called from the `skdm` case after handleIncomingSkdm.
  function drainGroupRetry(senderId: string): void {
    const buf = pendingGroupRetry.get(senderId);
    if (!buf || buf.length === 0) return;
    pendingGroupRetry.delete(senderId);
    diag('router', 'group: SKDM installed — replaying buffered', {
      peerFp: diagFingerprint(senderId),
      count: buf.length,
    });
    for (const entry of buf) {
      clearTimeout(entry.timer);
      void processGroupFrame(entry.frame, entry.ciphertext, senderId, true);
    }
  }

  // Process one group message end-to-end. `isReplay` is true for buffered
  // retries (suppresses re-buffering / re-requesting so a still-failing
  // message gives up to the dead bubble after one attempt).
  async function processGroupFrame(
    frame: { from?: string; message_id: string; conversation_id: string; sent_at?: number },
    ciphertext: Uint8Array,
    groupSenderId: string,
    isReplay: boolean,
  ): Promise<void> {
    try {
      // If an SKDM from the same sender is mid-flight (both arrived
      // together on a buffer drain after a reconnect), wait for it so the
      // SenderKey is installed before we try to decrypt.
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
      let groupReplyTo: ReplyContext | undefined;
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
        groupReplyTo = payload.replyTo;
        decryptedOk = true;
        diag('router', 'group: decrypted', {
          msgId: frame.message_id,
          peerFp: diagFingerprint(groupSenderId),
          textLen: bubble.length,
          attachCount: groupAttachments?.length ?? 0,
        });
      } catch (err) {
        // No SenderKey state for this sender: hold the message, ask them
        // to re-distribute their SKDM, and replay once it lands — instead
        // of a permanent dead bubble. Only for a genuine missing-key (not
        // a corrupt/duplicate message), and not on a replay.
        if (
          !isReplay &&
          groupSenderId !== deps.myUserId &&
          isMissingSenderKey(err) &&
          bufferGroup(groupSenderId, frame, ciphertext)
        ) {
          requestSkdm(groupSenderId, frame.conversation_id);
          diag('router', 'group: decrypt deferred — buffered, SKDM requested', {
            msgId: frame.message_id,
            from: groupSenderId,
            err: String(err),
          });
          return;
        }
        bubble = decodeBubble(err as Error);
        diag('router', 'group: decrypt FAILED → bubble', {
          msgId: frame.message_id,
          from: groupSenderId,
          isReplay,
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
          replyTo: groupReplyTo,
          kind: 'group',
          sentAt: frame.sent_at ?? Date.now(),
          stage: 'sent',
        });
        diag('router', 'group: addToConversation OK', {
          convId: frame.conversation_id,
          msgId: frame.message_id,
        });
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
      diag('router', 'group IIFE CRASHED', {
        msgId: frame.message_id,
        from: groupSenderId,
        err: String(err),
        stack: (err as { stack?: string }).stack?.slice(0, 240) ?? '',
      });
    }
  }

  return (frame: WsServerMsg) => {
    const breadcrumb: Record<string, unknown> = {};
    const f = frame as {
      from?: string;
      msg_type?: string;
      code?: string;
      message?: string;
    };
    if (f.from) breadcrumb.peerFp = diagFingerprint(f.from);
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
          peerFp: diagFingerprint(frame.from ?? ''),
        });
        deps.markMessageRead(frame.message_id, Date.now());
        return;

      case 'prekeys_low':
        deps.onPrekeysLow();
        return;

      case 'peer_deleted':
        // Server refused to relay a direct message because the
        // recipient handle has been deleted. Caller surfaces the
        // in-chat tombstone + freezes the conversation. We don't
        // do anything to local state here — the conversation freeze
        // + system bubble are app-level UX concerns. Diagnose with a
        // redacted fingerprint so the support flow doesn't expose
        // peer handles in copy-logs.
        diag('router', 'peer_deleted', {
          peerFp: diagFingerprint(frame.handle),
        });
        deps.onPeerDeleted?.(frame.handle);
        return;

      case 'skdm': {
        // SKDM bootstrap envelope — install the SenderKey + ack the
        // server so it deletes the buffered row. Track the in-flight
        // promise per sender so a group message arriving in the same
        // tick can await it (otherwise `decryptFromGroupMember`
        // rejects with no SenderKey installed yet).
        diag('router', 'skdm: enter', {
          msgId: frame.message_id,
          peerFp: diagFingerprint(frame.from ?? ''),
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
                peerFp: diagFingerprint(senderId),
              });
              // The SenderKey for this sender is now installed — replay
              // any group messages we buffered waiting for it (the
              // re-request recovery path), not just the in-flight ones
              // `pendingSkdms` already covers.
              drainGroupRetry(senderId);
            },
            (err) => {
              diag('router', 'skdm: handle FAILED', {
                msgId: messageId,
                peerFp: diagFingerprint(senderId),
                err: String(err),
              });
              log('skdm handle failed', { err: String(err), peerFp: diagFingerprint(senderId) });
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

      case 'skdm_request': {
        // A peer couldn't decrypt one of our group messages and is asking
        // us to re-send our SenderKey for the group. Re-distribute it (the
        // orchestrator clears its "already bootstrapped this peer" mark and
        // sends a fresh SKDM). Best-effort — failures just mean the peer
        // re-asks on their next undecryptable message.
        diag('router', 'skdm_request: received', {
          peerFp: diagFingerprint(frame.from),
          groupId: frame.group_id,
        });
        void deps.onSkdmRequest?.(frame.from, frame.group_id);
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
          peerFp: diagFingerprint(frame.from ?? ''),
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
          // identity. Phase A shipped server-side wire support but
          // no mobile unwrap path yet.
          //
          // Previously: we ack'd and dropped the frame. That was a
          // silent data-loss bug — if the server ever flips the
          // sealed-sender path on before the mobile unwrap ships,
          // every direct message disappears with no way to recover
          // the ciphertext.
          //
          // Now: we DO NOT ack. The server keeps the message
          // buffered (TTL = 7d per ws/handler.ts:RELAY_TTL_MS).
          // Once mobile-side unwrap lands, the buffer drains on the
          // next reconnect. Same tradeoff as the community-message
          // branch below.
          if (typeof frame.from !== 'string') {
            diag('router', 'direct: sealed-sender frame buffered (no unwrap yet)', {
              msgId: frame.message_id,
            });
            return;
          }
          // After the guard above, `frame.from` is narrowed to string.
          // Capture it once so the rest of this branch can keep using
          // the existing logic without per-line non-null assertions.
          const senderId: string = frame.from;
          // Full processing (decrypt → store → ack → notify) lives in
          // processDirectFrame, which also implements the buffer-and-retry
          // for a message that arrives before its session-establishing
          // PreKey. `false` = this is the live frame, not a replay.
          void processDirectFrame(frame, ciphertext, senderId, false);
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
          // Full processing (await in-flight SKDM → decrypt → store → ack
          // → notify) lives in processGroupFrame, which also buffers a
          // `no_session` failure and re-requests the sender's SKDM. `false`
          // = live frame, not a replay.
          void processGroupFrame(frame, ciphertext, groupSenderId, false);
        } else {
          // Community message arrived but the UI isn't wired yet.
          //
          // Previously: we ack'd to keep the server buffer from
          // backing up. That was a silent data-loss bug — the server
          // saw the ack as delivered and deleted the row, but the
          // mobile client had nothing to render and the ciphertext
          // never reached the user. As soon as community UI ships
          // those messages are gone with no recovery.
          //
          // Now: we DO NOT ack. The server keeps the message
          // buffered (TTL = 7d per ws/handler.ts:RELAY_TTL_MS). Once
          // the UI lands and a connected client rebuilds the
          // community surface, the buffer drains on reconnect. The
          // tradeoff is a slowly-growing server buffer for users
          // who never get community UI, capped by the 7d TTL — much
          // better than silently throwing away ciphertext we don't
          // know how to render.
          log('community message buffered server-side — UI not yet wired', {
            peerFp: diagFingerprint(frame.from ?? ''),
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
