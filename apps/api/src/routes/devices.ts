import { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth/vouchflow.js';
import type { DevicesRepo } from '../db/devices.js';

interface PushTokenBody {
  /** FCM/APNs banner token. Optional when registering ONLY a voip_token. */
  push_token?: string;
  /** iOS PushKit (VoIP) token for CallKit incoming-call wake-ups. Sent on
   * its own request (the PushKit token arrives separately from the FCM one). */
  voip_token?: string;
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
          required: ['platform'],
          // Must carry at least one token (FCM banner and/or PushKit VoIP).
          anyOf: [{ required: ['push_token'] }, { required: ['voip_token'] }],
          properties: {
            push_token: { type: 'string', minLength: 1 },
            voip_token: { type: 'string', minLength: 1 },
            platform: { type: 'string', enum: ['ios', 'android'] },
            notification_privacy: { type: 'string', enum: ['rich', 'private'] },
          },
        },
      },
    },
    async (request, reply) => {
      const deviceToken = request.auth?.deviceToken;
      const userId = request.auth?.userId;
      if (!deviceToken) {
        return reply.code(403).send({ error: 'not_enrolled' });
      }
      // Pass `userId` so the repo can insert-on-conflict the row if
      // it does not exist yet. Closes the wipe-and-recover race:
      // mobile may POST /v1/devices/push-token under a freshly-minted
      // Vouchflow deviceToken BEFORE the WS handshake has had a
      // chance to upsertOnSeen it. Without this, the old row's
      // push_token gets nulled by the rotation while the UPDATE for
      // the new deviceToken matches zero rows — leaving the user
      // with zero devices holding the live token (tester15 incident,
      // 2026-05-14: `push.no_devices` for every message during the
      // window between identity recovery and the next WS auth).
      if (request.body.push_token) {
        await opts.devices.setPushToken({
          deviceToken,
          userId,
          pushToken: request.body.push_token,
          platform: request.body.platform,
          notificationPrivacy: request.body.notification_privacy,
        });
      }
      // iOS PushKit (VoIP) token — registered on its own request for CallKit
      // incoming-call wake-ups (the PushKit token arrives separately).
      if (request.body.voip_token) {
        await opts.devices.setVoipToken({
          deviceToken,
          userId,
          voipToken: request.body.voip_token,
        });
      }
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

  /** Delete the current device, used when identity recovery fails */
  app.delete(
    '/v1/devices/:deviceToken',
    {
      preHandler: [requireAuth],
    },
    async (request, reply) => {
      const params = request.params as { deviceToken: string };
      const authToken = request.auth?.deviceToken;
      // Must match the device being deleted
      if (authToken !== params.deviceToken) {
        return reply.code(403).send({ error: 'cannot_delete_other_device' });
      }
      await opts.devices.remove(params.deviceToken);
      return reply.code(200).send({ ok: true });
    },
  );
}
