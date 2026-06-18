import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import {
  conversationIdForCommunity,
  conversationIdForDirect,
  conversationIdForGroup,
  isMessageId,
  KNOWN_CALL_KINDS,
  newMessageId,
} from '@speakeasy/shared';
import type {
  CallKind,
  ConversationKind,
  WsClientMsg,
  WsServerMsg,
} from '@speakeasy/shared';
import { redactToken } from '../log/redact.js';
import {
  Validator,
  VouchflowValidationError,
} from '@speakeasy/vouchflow';
import type { Connections } from './connections.js';
import type { Presence } from '../presence/presence.js';
import type { MessagesRepo } from '../db/messages.js';
import type { GroupRepo } from '../db/groups.js';
import type { CommunityRepo } from '../db/communities.js';
import type { AckRouter } from './ack-router.js';
import type { PushProvider } from '../push/push.js';
import type { DevicesRepo } from '../db/devices.js';
import type { UserRepo } from '../db/users.js';
import type { DeletedHandlesRepo } from '../db/deleted-handles.js';
import type { CallOfferBuffer } from './call-offer-buffer.js';
import type { AckBuffer } from './ack-buffer.js';
import type { UserNotifier } from './user-notifier.js';
import { routeCallFrame } from './call-router.js';

const AUTH_TIMEOUT_MS = 10_000;
const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // spec §5: 7-day relay buffer

interface Deps {
  validator: Validator;
  connections: Connections;
  presence: Presence;
  instanceId: string;
  log: FastifyBaseLogger;
  messages: MessagesRepo;
  groups: GroupRepo;
  communities: CommunityRepo;
  ackRouter: AckRouter;
  push: PushProvider;
  devices: DevicesRepo;
  users: UserRepo;
  /**
   * Tombstone for handles deleted via `DELETE /v1/users/me`. When the
   * message handler is about to relay a direct frame to a recipient
   * the user repo doesn't know, it consults this tombstone to decide
   * between "never existed" (emit a generic `invalid_target` error)
   * and "was deleted" (emit a typed `peer_deleted` frame so the
   * mobile client can render an in-chat tombstone instead of a
   * generic error toast).
   *
   * Optional so older test harnesses without the repo wired keep
   * the legacy behavior of buffering whatever was requested.
   */
  deletedHandles?: DeletedHandlesRepo;
  /**
   * Ringing-window buffer for call signaling addressed to a recipient
   * with no live WS. Drained on auth. See call-offer-buffer.ts for
   * the why.
   */
  callBuffer: CallOfferBuffer;
  /**
   * Catch-up buffer for `delivered` / `read` acks addressed to a sender
   * with no live WS. The live AckRouter path only reaches connected
   * sockets; this is drained on the sender's next auth. See ack-buffer.ts.
   */
  ackBuffer: AckBuffer;
  /**
   * Cross-instance fan-out for live frames. Used by the call signaling
   * path (rc.57) so a `call_answer` / `call_ice` / `call_end` reaches
   * the peer even if their WS authed onto a different fly machine
   * than the sender's. The Redis-backed variant publishes via pub/sub;
   * each instance subscribes and forwards to its local sockets.
   *
   * The offer side already worked cross-instance via callBuffer (rc.53);
   * the reply side was still local-fan-out only, which lost ~50% of
   * answers in a 2-machine deploy.
   */
  userNotifier: UserNotifier;
  /** Optional persistent event log — recipient of call-route diagnostics. */
  eventLog?: import('../db/event-log.js').EventLogRepo;
}

interface AuthedSession {
  userId: string;
  deviceToken: string;
}

function send(socket: WebSocket, msg: WsServerMsg): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

function sendError(socket: WebSocket, code: string, message: string): void {
  send(socket, { type: 'error', code, message });
}

/**
 * Compute the conversation id for a given outbound message frame.
 * Direct: deterministic dm-… id from the (sender, recipient) pair.
 * Group / community: the group / community id passes through.
 */
function conversationFor(
  msgType: ConversationKind,
  senderId: string,
  to: string,
): string {
  switch (msgType) {
    case 'direct':
      return conversationIdForDirect(senderId, to);
    case 'group':
      return conversationIdForGroup(to);
    case 'community':
      return conversationIdForCommunity(to);
  }
}

/**
 * Compute the recipients list for a message — fan-out.
 * Direct: just `to`.
 * Group: all members except sender (Sender Keys envelope per spec §4a).
 * Community: all members except sender (channel key per spec §4b).
 */
async function recipientsFor(
  msgType: ConversationKind,
  senderId: string,
  to: string,
  deps: Deps,
): Promise<string[]> {
  switch (msgType) {
    case 'direct':
      return [to];
    case 'group': {
      const members = await deps.groups.listMembers(to);
      return members.filter((m) => m !== senderId);
    }
    case 'community': {
      const members = await deps.communities.listMembers(to);
      return members.filter((m) => m !== senderId);
    }
  }
}

/**
 * Drain the buffered messages for `userId`, forwarding each. Called right
 * after a successful auth handshake (spec §5: 7-day relay buffer for
 * undelivered).
 */
async function deliverBuffered(
  userId: string,
  deviceToken: string,
  socket: WebSocket,
  deps: Deps,
): Promise<void> {
  const pending = await deps.messages.listUndeliveredFor(userId, deviceToken);
  for (const m of pending) {
    if (m.skdmGroupId) {
      // SKDMs ride the same buffer as messages but dispatch as the
      // separate `skdm` frame so the client routes to
      // groupMessaging.processSenderKeyDistribution rather than the
      // regular message decrypt path.
      send(socket, {
        type: 'skdm',
        from: m.senderId,
        group_id: m.skdmGroupId,
        ciphertext: m.ciphertext.toString('base64'),
        message_id: m.id,
      });
    } else {
      // Sealed-sender direct messages omit `from` — the recipient
      // recovers the sender from the inner envelope encrypted to
      // their identity key.
      send(socket, {
        type: 'message',
        ...(m.sealed ? {} : { from: m.senderId }),
        ciphertext: m.ciphertext.toString('base64'),
        message_id: m.id,
        msg_type: m.msgType,
        conversation_id: m.conversation,
        // Original relay time, so a backlog draining all at once keeps each
        // message's real timestamp instead of collapsing onto "now".
        sent_at: m.createdAt.getTime(),
      });
    }
  }
  if (pending.length > 0) {
    deps.log.info({ userId, count: pending.length }, 'delivered buffered messages');
  }
}

export function handleConnection(socket: WebSocket, deps: Deps): void {
  let session: AuthedSession | undefined;

  const authTimer = setTimeout(() => {
    if (!session) {
      sendError(socket, 'auth_timeout', 'no auth frame received');
      socket.close(4001, 'auth_timeout');
    }
  }, AUTH_TIMEOUT_MS);

  socket.on('message', async (raw) => {
    let msg: WsClientMsg;
    try {
      msg = JSON.parse(raw.toString()) as WsClientMsg;
    } catch {
      sendError(socket, 'bad_json', 'frame is not valid JSON');
      return;
    }

    if (!session) {
      if (msg.type !== 'auth') {
        sendError(socket, 'unauthenticated', 'first frame must be auth');
        socket.close(4002, 'unauthenticated');
        return;
      }
      try {
        const v = await deps.validator.validate(msg.token);
        // Real Vouchflow's ValidatedAttestation has no userId field —
        // it tracks attestation/risk/age, not Speakeasy's internal id.
        // Same fallback HTTP `requireAuth` does (apps/api/src/auth/
        // vouchflow.ts): resolve via the user repo's deviceToken→userId
        // index that the enroll route populated. Without this, every WS
        // auth fails with `not_enrolled` whenever the validator is real
        // Vouchflow OR `MockValidator.alwaysSucceeds()` (sandbox mode),
        // and the client's reconnect loop spins forever.
        let userId = v.userId;
        if (!userId) {
          userId = await deps.users.findUserIdByDeviceToken(v.deviceToken);
        }
        if (!userId) {
          sendError(socket, 'not_enrolled', 'token has no userId; enroll first');
          socket.close(4003, 'not_enrolled');
          return;
        }
        session = { userId, deviceToken: v.deviceToken };
        clearTimeout(authTimer);
        // Validate + normalize the client's declared call-kind capabilities.
        // Unknown strings are dropped (defense in depth). Absent field
        // means the client is pre-rc.130; default to ['audio','video']
        // which matches the historical capability set.
        const declaredKinds = Array.isArray(msg.supported_call_kinds)
          ? msg.supported_call_kinds
          : undefined;
        const capabilities: CallKind[] = declaredKinds
          ? (declaredKinds.filter((k): k is CallKind =>
              typeof k === 'string' && KNOWN_CALL_KINDS.has(k as CallKind),
            ) as CallKind[])
          : ['audio', 'video'];
        await deps.connections.add(
          session.userId,
          session.deviceToken,
          socket,
          capabilities,
        );
        await deps.devices.upsertOnSeen({
          userId: session.userId,
          deviceToken: session.deviceToken,
        });
        await deps.devices.setSupportedCallKinds({
          deviceToken: session.deviceToken,
          kinds: capabilities,
        });
        await deps.presence.recordOnline(session.userId, deps.instanceId);
        send(socket, { type: 'authed', user_id: session.userId });
        deps.log.info(
          { userId: session.userId, deviceToken: redactToken(session.deviceToken) },
          'ws authed',
        );
        // Drain any buffered messages addressed to this user. Spec §5.
        // Per-device aware: rows acked by *this* deviceToken on a previous
        // connection won't be re-drained (Phase 5f).
        await deliverBuffered(session.userId, session.deviceToken, socket, deps);
        // Drain any in-flight call signaling that arrived while the
        // user was offline (e.g. WS closed for push routing in the
        // background → caller sent offer → user taps push and
        // reconnects). Without this, the offer + early ICE frames
        // are dropped and the call never reaches the call screen.
        // 30-second TTL on the buffer side caps how stale this can be.
        const pendingCall = await deps.callBuffer.drain(session.userId);
        if (pendingCall.length > 0) {
          for (const f of pendingCall) {
            send(socket, {
              type: f.type,
              from: f.fromUserId,
              call_id: f.callId,
              ciphertext: f.ciphertext,
            });
          }
          deps.log.info(
            {
              userId: session.userId,
              count: pendingCall.length,
              callId: pendingCall[0]!.callId,
            },
            'delivered buffered call signaling',
          );
        }
        // Drain delivery/read acks produced while this user's WS was
        // down (it closes on background). The live AckRouter path only
        // reaches connected sockets; without this catch-up a sent
        // message stays on a single ✓.
        const pendingAcks = await deps.ackBuffer.drain(session.userId);
        for (const a of pendingAcks) {
          send(
            socket,
            a.kind === 'read'
              ? { type: 'read', from: a.fromUserId, message_id: a.messageId }
              : { type: 'delivered', message_id: a.messageId },
          );
        }
        if (pendingAcks.length > 0) {
          deps.log.info(
            { userId: session.userId, count: pendingAcks.length },
            'delivered buffered acks',
          );
        }
      } catch (err) {
        const code =
          err instanceof VouchflowValidationError ? err.reason : 'auth_failed';
        // Log the underlying error so we can diagnose anything that
        // throws after the `authed` send (a non-Vouchflow error here
        // is almost always a downstream DB / Redis issue silently
        // becoming `auth_failed` on the wire — see 0011 migration's
        // header for the precedent that motivated this log).
        deps.log.warn(
          {
            err,
            userId: session?.userId,
            deviceToken: redactToken(session?.deviceToken),
            code,
          },
          'ws auth/post-auth threw',
        );
        sendError(socket, code, 'authentication failed');
        socket.close(4004, code);
      }
      return;
    }

    switch (msg.type) {
      case 'ping':
        send(socket, { type: 'pong' });
        return;
      case 'auth':
        sendError(socket, 'already_authed', 'already authenticated');
        return;
      case 'ack': {
        // Spec §5: deleted on confirmed delivery.
        // Phase 4: announce via AckRouter so the instance holding the
        // original sender can emit `delivered` (cross-instance routing).
        // Phase 5f: per-device tracking — `delivered` only fires once
        // every known device of the recipient has acked.
        const result = await deps.messages.markDeliveredByDevice(
          msg.message_id,
          session.deviceToken,
        );
        if (result.kind === 'fully_delivered') {
          void deps.ackRouter.announce({
            messageId: msg.message_id,
            senderId: result.senderId,
            instanceId: deps.instanceId,
            kind: 'delivered',
          });
          // Catch-up: the announce above only reaches a sender who is
          // online right now. Buffer it so a backgrounded sender still
          // sees ✓✓ on reconnect.
          deps.ackBuffer.put(result.senderId, {
            kind: 'delivered',
            messageId: msg.message_id,
          });
        }
        // 'pending' (other devices haven't acked yet) and 'not_found'
        // both produce no further side effect.
        return;
      }
      case 'read': {
        // Phase 6 read receipts. Recipient signals to the original
        // sender that the message has been visibly opened. Cross-
        // instance route via AckRouter so the sender's connection
        // (which may be on the other Fly machine) gets the frame, and
        // buffer it so a sender who is offline at this moment still
        // sees the receipt on reconnect.
        if (
          typeof msg.to !== 'string' ||
          typeof msg.message_id !== 'string'
        ) {
          sendError(socket, 'invalid_target', 'read.to + message_id required');
          return;
        }
        void deps.ackRouter.announce({
          messageId: msg.message_id,
          senderId: msg.to, // who to notify (= original sender)
          instanceId: deps.instanceId,
          kind: 'read',
          fromUserId: session.userId, // who read it
        });
        deps.ackBuffer.put(msg.to, {
          kind: 'read',
          messageId: msg.message_id,
          fromUserId: session.userId,
        });
        return;
      }
      case 'message': {
        // Wire frames are dynamically parsed JSON — TS can't statically
        // narrow `msg.msg_type` to the union {direct, group, community}.
        // Without this guard, an unknown value falls through the
        // (no-default) switches in conversationFor / recipientsFor and
        // returns undefined, which then crashes at `recipients.length`.
        if (
          msg.msg_type !== 'direct' &&
          msg.msg_type !== 'group' &&
          msg.msg_type !== 'community'
        ) {
          sendError(
            socket,
            'invalid_msg_type',
            `msg_type must be one of: direct, group, community`,
          );
          return;
        }
        if (!msg.to || typeof msg.to !== 'string') {
          sendError(socket, 'invalid_target', 'message.to is required');
          return;
        }
        if (typeof msg.ciphertext !== 'string') {
          sendError(socket, 'invalid_ciphertext', 'message.ciphertext is required');
          return;
        }
        // Self-DM is allowed for direct messages — "Notes to self". For
        // group/community, sending to a group/community you're a member
        // of *is* implicitly self-inclusive (fan-out filters self out),
        // so the recipientsFor() filter handles those upstream.
        let conversation: string;
        try {
          conversation = conversationFor(msg.msg_type, session.userId, msg.to);
        } catch (err) {
          sendError(socket, 'invalid_target', String(err));
          return;
        }

        let recipients: string[];
        try {
          recipients = await recipientsFor(msg.msg_type, session.userId, msg.to, deps);
        } catch (err) {
          sendError(socket, 'invalid_target', String(err));
          return;
        }
        if (recipients.length === 0) {
          sendError(socket, 'no_recipients', 'no other members in conversation');
          return;
        }
        // Phase 1 peer-deleted: for direct sends specifically, check
        // whether the recipient handle has been tombstoned. If so,
        // emit `peer_deleted` to the sender so their mobile client
        // can render an in-chat tombstone bubble instead of silently
        // dropping the message into a 7-day relay buffer no one is
        // ever going to drain. `recipientsFor` for direct unconditionally
        // returns `[to]` without an existence check, so the
        // `recipients.length === 0` branch above never fires for
        // missing direct recipients — the tombstone lookup is the
        // only signal we have at this layer.
        //
        // Group/community sends are unchanged: a deleted ex-member's
        // userId won't appear in `recipientsFor`'s membership result.
        if (
          msg.msg_type === 'direct' &&
          deps.deletedHandles &&
          (await deps.deletedHandles.isDeleted(msg.to))
        ) {
          socket.send(JSON.stringify({ type: 'peer_deleted', handle: msg.to }));
          // No relay row written, no ack expected from the sender for
          // this frame. Server-side this is a refused-relay; client
          // treats it as a terminal conversation state.
          return;
        }

        const ciphertextBuf = Buffer.from(msg.ciphertext, 'base64');
        const expiresAt = new Date(Date.now() + RELAY_TTL_MS);
        const senderUserId = session.userId;
        // Sealed-sender (spec §13). Only meaningful for direct
        // messages — group/community fan-out has no single sender to
        // hide. Server still records senderId internally for ack
        // routing (`delivered` needs to know who to fire back to);
        // the suppression is purely on the wire frame + audit log.
        const sealed = msg.msg_type === 'direct' && msg.sealed === true;

        // For direct: one row, one message_id (the value also returned in
        // `delivered` to sender). For group/community: one row per recipient
        // so each can be acked + deleted independently.
        //
        // The direct id is the *client-supplied* `message_id` — the
        // sender stamped its optimistic bubble with it, so the
        // `delivered`/`read` frames routed back carry an id that bubble
        // actually has (without this they never attach — receipts are
        // stuck on a single ✓). Fall back to a server id if the client
        // omitted it (older builds) or sent something malformed.
        const directMessageId =
          msg.msg_type === 'direct'
            ? isMessageId(msg.message_id)
              ? msg.message_id
              : newMessageId()
            : undefined;

        // For group pushes, surface the room's name (plaintext
        // server-side per spec §schema groups.name) so the notification
        // reads "<Group> · New message" instead of "@sender · New
        // message". Looked up once per message, not per recipient.
        const groupName =
          msg.msg_type === 'group'
            ? ((await deps.groups.findById(msg.to))?.name ?? undefined)
            : undefined;

        await Promise.all(
          recipients.map(async (recipientId) => {
            const rowId = directMessageId ?? newMessageId();
            // Phase 5f: snapshot recipient's known devices at insert time.
            // The row deletes only when *every* listed device acks. If no
            // devices are known yet (recipient never connected), empty
            // array → legacy single-device shortcut: any single ack deletes.
            const targetDevices = (await deps.devices.listForUser(recipientId)).map(
              (d) => d.deviceToken,
            );
            await deps.messages.insert({
              id: rowId,
              conversation,
              senderId: senderUserId,
              recipientId,
              ciphertext: ciphertextBuf,
              msgType: msg.msg_type,
              expiresAt,
              targetDevices,
              deliveredToDevices: [],
              sealed,
            });
            // Live fan-out via UserNotifier — local delivery + Redis
            // pub/sub so the recipient receives the message regardless
            // of which fly instance their WS is authed on. Pre-rc.58
            // this was local-only fan-out, so two users on different
            // machines saw messages delayed until one of them's WS
            // happened to cycle and drain the relay buffer.
            //
            // The relay buffer write (above) still happens so messages
            // survive when the recipient is offline; the mobile client
            // dedupes by `message_id` so the live frame + a later
            // drain replay of the same row is harmless.
            const frame = {
              type: 'message' as const,
              // Sealed-sender direct messages omit `from` — the
              // recipient unwraps the inner envelope to recover
              // sender identity. See `WsServerMsg.message`.
              ...(sealed ? {} : { from: senderUserId }),
              ciphertext: msg.ciphertext,
              message_id: rowId,
              msg_type: msg.msg_type,
              conversation_id: conversation,
              // Server send time. For live delivery this ≈ the recipient's
              // receive time, but stamping it server-side keeps the bubble
              // timestamp consistent with the buffered-drain path and
              // immune to client clock skew.
              sent_at: Date.now(),
            };
            // Always fan out live AND fire a notify-only push. The
            // previous `onlineSomewhere ? notify : push` gate relied
            // on `presence:{userId}` being a perfect mirror of socket
            // liveness — which it isn't. Anything that severs the
            // TCP without firing the WS close handler (process crash,
            // fly machine swap, cellular handoff, k8s eviction)
            // leaves `session:{userId}` set in Redis forever and
            // routes every subsequent message via the dead socket
            // instead of FCM. The client already dedupes by
            // `message_id` (see store/conversations.ts add()) and
            // the foreground FCM handler suppresses the OS tray
            // notification on Android when the app is open (see
            // commit 3d969ad), so a redundant push for a foregrounded
            // user is a no-op visually. Cost: one FCM data call per
            // message even when the user is online — negligible
            // versus the "@x didn't get a push" reports this fixes.
            deps.userNotifier.notify(recipientId, frame);
            void deps.push
              .notifyDelivery({
                userId: recipientId,
                conversationId: conversation,
                msgType: msg.msg_type,
                // Sealed-sender messages don't reveal the sender to
                // the server-side push surface — degrades to generic
                // "speakeasy: New message" regardless of recipient
                // privacy preference.
                senderId: sealed ? undefined : senderUserId,
                // Group room name for the banner title (undefined for direct).
                groupName,
                // Forward id + ciphertext so the recipient's headless
                // push handler can decrypt and show the real text.
                // The server can't read it (E2E); push.fcm-apns gates
                // inclusion (rich device, not sealed, size cap).
                messageId: rowId,
                ciphertext: msg.ciphertext,
              })
              .catch((err) => deps.log.warn({ err, recipientId }, 'push notify failed'));
          }),
        );

        if (sealed) {
          deps.log.info(
            {
              audit: 'message_send_sealed',
              messageId: directMessageId,
              // Deliberately NO senderId in the audit line — that's the
              // privacy property sealed-sender buys at-rest. The internal
              // buffer row still has senderId for ack routing; that's a
              // separate (server-only) leak surface tracked under spec
              // §13's "v2 sealed sender (server-blind routing)" line.
              recipient: msg.to,
              msgType: msg.msg_type,
            },
            'sealed direct message persisted',
          );
        }

        // Phase 4: `delivered` is now emitted cross-instance via the
        // AckRouter (subscribed at attach time in ws/server.ts). Each
        // instance fires `delivered` to a sender it owns when it receives
        // the corresponding ack event. We deliberately do NOT short-circuit
        // a same-instance fast path — the round-trip through AckRouter for
        // both same- and cross-instance keeps the behaviour uniform.
        return;
      }
      case 'skdm': {
        // Phase 5b carry-over — Sender Key Distribution Message envelope.
        // Routed like a single-recipient direct message at the relay
        // layer (one row, ack-deletes, drains on reconnect) but
        // dispatched to the recipient as a `skdm` frame so they can
        // route into groupMessaging.processSenderKeyDistribution rather
        // than the regular decrypt path.
        if (!msg.to || !msg.group_id || !msg.ciphertext) {
          sendError(socket, 'bad_skdm', 'skdm requires to, group_id, ciphertext');
          return;
        }
        if (msg.to === session.userId) {
          sendError(socket, 'invalid_target', 'cannot send skdm to self');
          return;
        }
        const conversation = conversationIdForDirect(session.userId, msg.to);
        const ciphertextBuf = Buffer.from(msg.ciphertext, 'base64');
        const expiresAt = new Date(Date.now() + RELAY_TTL_MS);
        const senderUserId = session.userId;
        const rowId = newMessageId();
        // Phase 5f: per-device delivery snapshot, same as direct messages.
        const skdmTargetDevices = (await deps.devices.listForUser(msg.to)).map(
          (d) => d.deviceToken,
        );
        await deps.messages.insert({
          id: rowId,
          conversation,
          senderId: senderUserId,
          recipientId: msg.to,
          ciphertext: ciphertextBuf,
          // Persist as 'direct' for shape consistency; the sentinel that
          // tells the deliverBuffered + handler paths "this is an SKDM"
          // is the non-null skdmGroupId.
          msgType: 'direct',
          expiresAt,
          skdmGroupId: msg.group_id,
          targetDevices: skdmTargetDevices,
          deliveredToDevices: [],
          // SKDMs are never sealed — they carry SenderKey bootstrap
          // material that's already encrypted with the recipient's
          // 1:1 Signal session, and the recipient needs to know
          // who sent it to install the SenderKey under the right
          // attribution.
          sealed: false,
        });
        // Live fan-out via UserNotifier — see direct-message branch
        // above for the why. Same cross-instance shape, same dedupe
        // semantics from the relay-buffer drain.
        const skdmFrame = {
          type: 'skdm' as const,
          from: senderUserId,
          group_id: msg.group_id,
          ciphertext: msg.ciphertext,
          message_id: rowId,
        };
        // Fan out live only — NO push. An SKDM is a protocol control
        // message (sender-key bootstrap), not a user message. The
        // headless push handler has no SKDM path (it would just render
        // a generic "New message" banner), so pushing it produced a
        // phantom 1:1 notification on every group send (fuertechino
        // repro 2026-06-04). The SKDM still reaches an offline recipient
        // two ways: the buffered row above (drains on reconnect, ahead
        // of the group message it unlocks — see message-router's
        // "awaiting in-flight SKDM") and the accompanying group
        // MESSAGE's own push, which wakes the device. So suppressing
        // the SKDM push loses no delivery, only the spurious banner.
        deps.userNotifier.notify(msg.to, skdmFrame);
        return;
      }
      case 'skdm_request': {
        // A recipient couldn't decrypt one of `to`'s group messages
        // (no SenderKey state) and is asking `to` to re-distribute their
        // SKDM. Relayed LIVE only — no relay row, no push. It's an
        // idempotent control message; if `to` is offline the requester
        // re-asks on the next undecryptable message once `to` is sending
        // again. Both parties must be members of the group, so this can't
        // be used to probe or spam arbitrary users.
        if (!msg.to || !msg.group_id) {
          sendError(socket, 'bad_skdm_request', 'skdm_request requires to, group_id');
          return;
        }
        if (msg.to === session.userId) {
          sendError(socket, 'invalid_target', 'cannot request skdm from self');
          return;
        }
        const members = await deps.groups.listMembers(msg.group_id);
        if (!members.includes(session.userId) || !members.includes(msg.to)) {
          sendError(socket, 'not_a_member', 'requester and target must both be group members');
          return;
        }
        deps.userNotifier.notify(msg.to, {
          type: 'skdm_request' as const,
          from: session.userId,
          group_id: msg.group_id,
        });
        return;
      }
      case 'call_offer':
      case 'call_answer':
      case 'call_ice':
      case 'call_end': {
        // Voice/video call signaling. Logic lives in call-router.ts —
        // see that module's header for the routing model (always-push
        // for offers, UserNotifier for live cross-instance fan-out,
        // ringing-window buffer for offline peers). Kept here as a
        // thin dispatcher so handler.ts stays the WS shape and
        // validation surface, not the call lifecycle.
        const result = await routeCallFrame(deps, session.userId, msg);
        if (!result.ok) {
          sendError(socket, result.code, result.message);
        }
        return;
      }
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
        sendError(socket, 'unknown_type', 'unknown frame type');
      }
    }
  });

  socket.on('close', () => {
    clearTimeout(authTimer);
    if (session) {
      const closingSession = session;
      void (async () => {
        await deps.connections.remove(
          closingSession.userId,
          closingSession.deviceToken,
          socket,
        );
        // Only record offline if THIS was the user's last live WS in
        // the cluster. Without this check, a rapid background→active
        // reconnect (mobile AppState flip → close old WS, open new
        // WS) had a window where the old WS's close handler ran
        // *after* the new WS authed — recordOffline DELETEd presence
        // even though the user was still live on the new socket.
        // Downstream effect: cross-instance call routing thought the
        // user was offline and dropped subsequent call_answer /
        // call_ice frames silently. Reproduced in
        // cross-instance-real-redis.test.ts.
        const remainingLocal = deps.connections.getDevices(closingSession.userId);
        if (remainingLocal.length === 0) {
          void deps.presence.recordOffline(closingSession.userId);
        }
      })();
    }
  });

  socket.on('error', (err) => {
    deps.log.warn({ err, userId: session?.userId }, 'ws error');
  });
}
