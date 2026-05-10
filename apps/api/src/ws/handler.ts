import type { WebSocket } from 'ws';
import type { FastifyBaseLogger } from 'fastify';
import {
  conversationIdForCommunity,
  conversationIdForDirect,
  conversationIdForGroup,
  newMessageId,
} from '@speakeasy/shared';
import type {
  ConversationKind,
  WsClientMsg,
  WsServerMsg,
} from '@speakeasy/shared';
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
        await deps.connections.add(session.userId, session.deviceToken, socket);
        await deps.devices.upsertOnSeen({
          userId: session.userId,
          deviceToken: session.deviceToken,
        });
        await deps.presence.recordOnline(session.userId, deps.instanceId);
        send(socket, { type: 'authed', user_id: session.userId });
        deps.log.info(
          { userId: session.userId, deviceToken: session.deviceToken },
          'ws authed',
        );
        // Drain any buffered messages addressed to this user. Spec §5.
        // Per-device aware: rows acked by *this* deviceToken on a previous
        // connection won't be re-drained (Phase 5f).
        await deliverBuffered(session.userId, session.deviceToken, socket, deps);
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
            deviceToken: session?.deviceToken,
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
        }
        // 'pending' (other devices haven't acked yet) and 'not_found'
        // both produce no further side effect.
        return;
      }
      case 'read': {
        // Phase 6 read receipts. Recipient signals to the original
        // sender that the message has been visibly opened. We do not
        // persist anything server-side — the read state is a UI
        // affordance and only matters when the sender is online to
        // receive it. Cross-instance route via AckRouter so the
        // sender's connection (which may be on the other Fly machine)
        // gets the frame.
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
        const directMessageId = msg.msg_type === 'direct' ? newMessageId() : undefined;

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
            // Phase 4: fan-out to ALL live devices for this recipient.
            const peerDevices = deps.connections.getDevices(recipientId);
            if (peerDevices.length > 0) {
              for (const peer of peerDevices) {
                send(peer, {
                  type: 'message',
                  // Sealed-sender direct messages omit `from` — the
                  // recipient unwraps the inner envelope to recover
                  // sender identity. See `WsServerMsg.message`.
                  ...(sealed ? {} : { from: senderUserId }),
                  ciphertext: msg.ciphertext,
                  message_id: rowId,
                  msg_type: msg.msg_type,
                  conversation_id: conversation,
                });
              }
            } else {
              // Phase 4: notify-only push so the device wakes and reconnects
              // (then drains via the buffered-delivery path on auth handshake).
              // No content in the payload per spec §11.
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
                })
                .catch((err) => deps.log.warn({ err, recipientId }, 'push notify failed'));
            }
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
        const peerDevices = deps.connections.getDevices(msg.to);
        if (peerDevices.length > 0) {
          for (const peer of peerDevices) {
            send(peer, {
              type: 'skdm',
              from: senderUserId,
              group_id: msg.group_id,
              ciphertext: msg.ciphertext,
              message_id: rowId,
            });
          }
        } else {
          // Same notify-only push behavior as ordinary messages — wakes
          // the recipient device which then drains the buffer.
          void deps.push
            .notifyDelivery({
              userId: msg.to,
              conversationId: conversation,
              msgType: 'direct',
              // SKDM is the group-key-distribution carrier — sender
              // identity is fine to surface (member adds member, you
              // see who added the SKDM that unlocks future group
              // messages).
              senderId: senderUserId,
            })
            .catch((err) => deps.log.warn({ err, recipientId: msg.to }, 'push notify failed'));
        }
        return;
      }
      case 'call_offer':
      case 'call_answer':
      case 'call_ice':
      case 'call_end': {
        // Voice call signaling. Live-route only — no relay buffer.
        // Rationale: a call_offer that arrives 7 days later isn't a
        // call, it's an artifact. The sender's orchestrator handles
        // ringing-window timeout (~45s) locally; if the recipient is
        // offline, push wakes the device and a fresh offer can be
        // attempted on reconnect.
        //
        // The `ciphertext` (offer/answer/ice) is encrypted with the
        // existing Signal 1:1 session — server can't read SDP, ICE
        // candidates, or DTLS fingerprints. `call_end` carries no
        // ciphertext, just a plaintext reason.
        if (!msg.to || typeof msg.to !== 'string') {
          sendError(socket, 'invalid_target', 'call frame requires `to`');
          return;
        }
        if (msg.to === session.userId) {
          sendError(socket, 'invalid_target', 'cannot call self');
          return;
        }
        if (!msg.call_id || typeof msg.call_id !== 'string') {
          sendError(socket, 'bad_call_id', 'call frame requires `call_id`');
          return;
        }
        if (msg.type !== 'call_end' && typeof msg.ciphertext !== 'string') {
          sendError(socket, 'invalid_ciphertext', 'call signaling requires ciphertext');
          return;
        }

        const peerDevices = deps.connections.getDevices(msg.to);
        if (peerDevices.length === 0) {
          if (msg.type === 'call_offer') {
            // Wake the device — push provider already does notify-only,
            // no content. The caller's orchestrator times out the
            // ringing window if the callee never connects.
            const conversation = conversationIdForDirect(session.userId, msg.to);
            void deps.push
              .notifyDelivery({
                userId: msg.to,
                conversationId: conversation,
                msgType: 'direct',
                senderId: session.userId,
                // Distinguishes the banner copy ("@caller is calling…"
                // vs "@sender: New message") and stamps the FCM data
                // block so the mobile app's message handler can route
                // to CallKeepBridge for the full-screen ringer.
                kind: 'call',
              })
              .catch((err) =>
                deps.log.warn({ err, recipientId: msg.to }, 'call push notify failed'),
              );
          }
          // call_answer / call_ice / call_end to an offline peer is a
          // best-effort no-op. (call_end specifically is fine to drop —
          // the peer's local timeout will produce the same outcome.)
          return;
        }

        // Fan out to every live device of the recipient. First answer
        // wins; orchestrator on losing devices sees no media flow and
        // transitions to ended on the next call_end frame.
        const senderUserId = session.userId;
        for (const peer of peerDevices) {
          if (msg.type === 'call_end') {
            send(peer, {
              type: 'call_end',
              from: senderUserId,
              call_id: msg.call_id,
              reason: msg.reason,
            });
          } else {
            send(peer, {
              type: msg.type,
              from: senderUserId,
              call_id: msg.call_id,
              ciphertext: msg.ciphertext,
            });
          }
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
      void deps.connections.remove(session.userId, session.deviceToken, socket);
      void deps.presence.recordOffline(session.userId);
    }
  });

  socket.on('error', (err) => {
    deps.log.warn({ err, userId: session?.userId }, 'ws error');
  });
}
