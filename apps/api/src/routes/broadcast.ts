import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  conversationIdForDirect,
  encodePayload,
  newMessageId,
  SPEAKER_HANDLE,
} from '@speakeasy/shared';
import type { DevicesRepo } from '../db/devices.js';
import type { MessagesRepo } from '../db/messages.js';
import type { PushProvider } from '../push/push.js';
import type { UserNotifier } from '../ws/user-notifier.js';

/** Relay-buffer TTL — 7 days, matching spec §5 / the WS handler. */
const RELAY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TEXT = 1000;

/**
 * Only fan out to users whose device authed within this window. A
 * successful auth means Vouchflow `validate()` passed, so this skips
 * dead test accounts that never come back. Matches Vouchflow's 24h
 * verification-freshness window.
 */
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * POST /v1/broadcast — fan a plaintext announcement out from the
 * `@speaker` bot to every recently-active user (a device authed in
 * the last 24h). The release workflow calls this so everyone on a
 * live install learns a new build is available.
 *
 * Admin-gated (ADMIN_TOKEN bearer). NOT end-to-end encrypted — @speaker
 * announcements are public; the wire `ciphertext` is just the plaintext
 * v1 envelope and the mobile client renders @speaker messages without a
 * Signal session.
 */
export async function registerBroadcastRoute(
  app: FastifyInstance,
  deps: {
    devices: DevicesRepo;
    messages: MessagesRepo;
    push: PushProvider;
    userNotifier: UserNotifier;
  },
): Promise<void> {
  app.post<{ Body: { text: string } }>(
    '/v1/broadcast',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: MAX_TEXT },
          },
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { text: string } }>,
      reply: FastifyReply,
    ) => {
      const expected = process.env.ADMIN_TOKEN;
      if (!expected) {
        return reply.code(503).send({ error: 'admin_token_unset' });
      }
      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'missing_bearer' });
      }
      if (auth.slice('Bearer '.length).trim() !== expected) {
        return reply.code(403).send({ error: 'bad_token' });
      }

      const text = request.body.text;
      // Same v1 envelope a normal text message uses, but plaintext on
      // the wire — @speaker has no Signal session with anyone.
      const ciphertext = Buffer.from(encodePayload({ v: 1, text }), 'utf8');
      const ciphertextB64 = ciphertext.toString('base64');
      const expiresAt = new Date(Date.now() + RELAY_TTL_MS);

      const userIds = await deps.devices.listActiveUserIds(ACTIVE_WINDOW_MS);
      let sent = 0;
      for (const userId of userIds) {
        if (userId === SPEAKER_HANDLE) continue;
        const conversation = conversationIdForDirect(SPEAKER_HANDLE, userId);
        const messageId = newMessageId();
        // Buffer it so offline users drain the announcement on reconnect.
        await deps.messages.insert({
          id: messageId,
          conversation,
          senderId: SPEAKER_HANDLE,
          recipientId: userId,
          ciphertext,
          msgType: 'direct',
          expiresAt,
          targetDevices: [],
          deliveredToDevices: [],
          sealed: false,
        });
        // Live fan-out to anyone currently connected.
        deps.userNotifier.notify(userId, {
          type: 'message',
          from: SPEAKER_HANDLE,
          ciphertext: ciphertextB64,
          message_id: messageId,
          msg_type: 'direct',
          conversation_id: conversation,
        });
        // Push — `body` carries the announcement text (allowed because
        // @speaker content is plaintext; see PushDeliveryNotice.body).
        void deps.push
          .notifyDelivery({
            userId,
            conversationId: conversation,
            msgType: 'direct',
            senderId: SPEAKER_HANDLE,
            body: text,
          })
          .catch(() => {
            /* best-effort — a failed push just means no banner */
          });
        sent += 1;
      }
      request.log.info({ sent }, 'broadcast sent');
      return reply.send({ ok: true, sent });
    },
  );
}
