import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/vouchflow.js';
import { applyDeliveryAck, type DeliveryAckDeps } from '../ws/delivery-ack.js';

/**
 * POST /v1/messages/delivered — background delivery receipt.
 *
 * The mobile client acks messages over the WebSocket while it is foregrounded.
 * When backgrounded it CLOSES the WebSocket (so incoming pushes route through
 * FCM/APNs), yet the headless push handler still receives, decrypts and
 * displays messages — with a live network connection but no way to ack. This
 * endpoint is that ack: it clears the relay row (stopping a needless retry) and
 * fires ✓✓ to the sender, exactly as the WS `ack` frame does (shared code path
 * in ws/delivery-ack.ts).
 *
 * Accepts a batch because the handler may drain several messages at once.
 */
export async function registerDeliveredRoute(
  app: FastifyInstance,
  deps: DeliveryAckDeps,
): Promise<void> {
  app.post<{ Body: { message_ids: string[] } }>(
    '/v1/messages/delivered',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['message_ids'],
          properties: {
            message_ids: {
              type: 'array',
              items: { type: 'string', minLength: 1 },
              minItems: 1,
              maxItems: 200,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const deviceToken = request.auth?.deviceToken;
      if (!deviceToken) return reply.code(403).send({ error: 'not_enrolled' });

      // Ack each id under this device. markDeliveredByDevice is idempotent and
      // returns not_found for an already-cleared row, so double-acks are safe.
      const ids = request.body.message_ids;
      await Promise.all(
        ids.map((id) =>
          applyDeliveryAck(deps, id, deviceToken).catch((err) => {
            request.log.warn({ err, messageId: id }, 'delivered-receipt ack failed');
          }),
        ),
      );
      return reply.code(200).send({ acked: ids.length });
    },
  );
}
