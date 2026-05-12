import { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/vouchflow.js';
import type { DevicesRepo } from '../db/devices.js';

interface PushTokenBody {
  push_token: string;
  platform: 'ios' | 'android';
  /** Optional. Drives the FCM/APNs banner copy. Omitting leaves the
   * stored value alone — Settings can update it independently of a
   * fresh push-token rotation. */
  notification_privacy?: 'rich' | 'private';
}

/**
 * Spec §11 Phase 5d: mobile client registers its FCM/APNs push token
 * after enrollment so the server can wake the device when a message
 * arrives while it has no live WebSocket.
 */
export async function registerDeviceRoutes(
  app: FastifyInstance,
  opts: { devices: DevicesRepo },
): Promise<void> {
  app.post<{ Body: PushTokenBody }>(
    '/v1/devices/push-token',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['push_token', 'platform'],
          properties: {
            push_token: { type: 'string', minLength: 1 },
            platform: { type: 'string', enum: ['ios', 'android'] },
            notification_privacy: { type: 'string', enum: ['rich', 'private'] },
          },
        },
      },
    },
    async (request, reply) => {
      const deviceToken = request.auth?.deviceToken;
      if (!deviceToken) {
        return reply.code(403).send({ error: 'not_enrolled' });
      }
      await opts.devices.setPushToken({
        deviceToken,
        pushToken: request.body.push_token,
        platform: request.body.platform,
        notificationPrivacy: request.body.notification_privacy,
      });
      return reply.code(200).send({ ok: true });
    },
  );

  /** Client reports a push registration failure so the server can
   * diagnose "not receiving push" without requiring the user to
   * manually check their diag log. Cleared on next successful
   * registration. */
  app.post<{ Body: { error: string } }>(
    '/v1/devices/push-error',
    {
      preHandler: [requireAuth],
      schema: {
        body: {
          type: 'object',
          required: ['error'],
          properties: {
            error: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const deviceToken = request.auth?.deviceToken;
      if (!deviceToken) {
        return reply.code(403).send({ error: 'not_enrolled' });
      }
      await opts.devices.reportPushError({
        deviceToken,
        error: request.body.error,
      });
      return reply.code(200).send({ ok: true });
    },
  );
}
