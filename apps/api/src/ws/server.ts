import { WebSocketServer, WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { Validator } from '@speakeasy/vouchflow';
import { handleConnection } from './handler.js';
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
import { createCallOfferBuffer } from './call-offer-buffer.js';
import type { CallOfferBuffer } from './call-offer-buffer.js';
import { createAckBuffer, type AckBuffer } from './ack-buffer.js';
import type { UserNotifier } from './user-notifier.js';
import type { EventLogRepo } from '../db/event-log.js';

export interface AttachWsOptions {
  validator: Validator;
  connections: Connections;
  presence: Presence;
  instanceId: string;
  messages: MessagesRepo;
  groups: GroupRepo;
  communities: CommunityRepo;
  ackRouter: AckRouter;
  push: PushProvider;
  devices: DevicesRepo;
  users: UserRepo;
  /**
   * Tombstone for handles deleted via `DELETE /v1/users/me`. Drives
   * the `peer_deleted` WS frame emission for direct messages whose
   * recipient handle is in the set. Optional so older test harnesses
   * keep the legacy behavior.
   */
  deletedHandles?: DeletedHandlesRepo;
  /**
   * Optional injected buffer (tests). When omitted, one is created
   * per attachWebsocket call with the default 30s ringing TTL.
   */
  callBuffer?: CallOfferBuffer;
  /**
   * Optional injected ack buffer (tests). When omitted, an in-memory
   * one is created. Production passes the Redis-backed variant so the
   * buffer is shared across fly machines.
   */
  ackBuffer?: AckBuffer;
  /**
   * UserNotifier for cross-instance frame routing — required for
   * call signaling to work in a multi-instance deploy (rc.57). The
   * server-level wiring resolves this once and shares it with the
   * routes layer that already uses it (e.g. prekey_low notifications).
   */
  userNotifier: UserNotifier;
  /** Optional persistent event log — recipient of call-route diagnostics. */
  eventLog?: EventLogRepo;
  /** Path on which to accept upgrades. Default: /ws */
  path?: string;
}

/**
 * Mounts a raw `ws` WebSocketServer on Fastify's underlying http server.
 * Returns the server so callers can close it explicitly in tests.
 *
 * Per spec §7: raw ws, no Socket.io overhead. Phase 4: also subscribes to
 * the AckRouter so cross-instance ack events drive `delivered` to senders
 * owned by this instance.
 */
export function attachWebsocket(
  app: FastifyInstance,
  opts: AttachWsOptions,
): WebSocketServer {
  const path = opts.path ?? '/ws';
  const wss = new WebSocketServer({ noServer: true });
  const callBuffer = opts.callBuffer ?? createCallOfferBuffer();
  const ackBuffer = opts.ackBuffer ?? createAckBuffer();

  app.server.on('upgrade', (req, socket, head) => {
    if (req.url !== path) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      // Register so wss.clients tracks it (noServer mode skips this).
      wss.emit('connection', ws, req);
      handleConnection(ws, {
        validator: opts.validator,
        connections: opts.connections,
        presence: opts.presence,
        instanceId: opts.instanceId,
        messages: opts.messages,
        groups: opts.groups,
        communities: opts.communities,
        ackRouter: opts.ackRouter,
        push: opts.push,
        devices: opts.devices,
        users: opts.users,
        deletedHandles: opts.deletedHandles,
        callBuffer,
        ackBuffer,
        userNotifier: opts.userNotifier,
        eventLog: opts.eventLog,
        log: app.log,
      });
    });
  });

  // Phase 4: cross-instance ack routing. When ANY instance emits an ack
  // event, this instance forwards the appropriate frame to every device
  // of the original sender (multi-device fan-out).
  // Phase 6: `kind` switches between `delivered` (server-acked by
  // recipient device) and `read` (recipient opened the chat).
  const unsubscribe = opts.ackRouter.subscribe((ev) => {
    const kind = ev.kind ?? 'delivered';
    const frame =
      kind === 'read'
        ? {
            type: 'read' as const,
            from: ev.fromUserId,
            message_id: ev.messageId,
          }
        : { type: 'delivered' as const, message_id: ev.messageId };
    for (const senderSocket of opts.connections.getDevices(ev.senderId)) {
      if (senderSocket.readyState !== WebSocket.OPEN) continue;
      senderSocket.send(JSON.stringify(frame));
    }
  });

  app.addHook('onClose', async () => {
    unsubscribe();
    await opts.ackRouter.close();
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  return wss;
}
