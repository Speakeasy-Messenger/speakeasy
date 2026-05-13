import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { EventLogRepo } from '../db/event-log.js';

/**
 * Admin diagnostics routes.
 *
 * Gated by ADMIN_TOKEN env var (bearer). When unset, every route here
 * returns 503 — defense in depth so a misconfigured deploy can't
 * accidentally expose user-keyed event logs publicly.
 *
 *   GET /v1/admin/events
 *     ?userId=<id>      filter by recipient/originator userId
 *     ?type=<event>     filter by eventType (e.g. push.attempted)
 *     ?limit=<n>        max rows (default 50, cap 500)
 *
 * Auth:
 *   Authorization: Bearer <ADMIN_TOKEN>
 *
 * Built primarily for "did the server push for tester5?"-style
 * questions whose answer is in the rc.57 server_event_log table
 * (see migrations/0015).
 */

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export async function registerAdminRoutes(
  app: FastifyInstance,
  deps: { eventLog: EventLogRepo; devices?: any; users?: any },
): Promise<void> {
  app.get(
    '/v1/admin/events',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const expected = process.env.ADMIN_TOKEN;
      if (!expected) {
        return reply.code(503).send({ error: 'admin_token_unset' });
      }
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'missing_bearer' });
      }
      const token = auth.slice('Bearer '.length).trim();
      if (token !== expected) {
        return reply.code(403).send({ error: 'bad_token' });
      }
      const q = req.query as { userId?: string; type?: string; limit?: string };
      const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit ?? DEFAULT_LIMIT)));
      if (!q.userId) {
        return reply.code(400).send({ error: 'userId_required' });
      }
      const rows = await deps.eventLog.recentForUser(q.userId, limit);
      const filtered = q.type ? rows.filter((r) => r.eventType === q.type) : rows;
      return reply.send({ rows: filtered });
    },
  );

  // GET /v1/admin/users/:userId/devices
  // Lists all devices for a user
  app.get(
    '/v1/admin/users/:userId/devices',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const expected = process.env.ADMIN_TOKEN;
      if (!expected) {
        return reply.code(503).send({ error: 'admin_token_unset' });
      }
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'missing_bearer' });
      }
      const token = auth.slice('Bearer '.length).trim();
      if (token !== expected) {
        return reply.code(403).send({ error: 'bad_token' });
      }
      const params = req.params as { userId: string };
      if (!deps.devices) {
        return reply.code(501).send({ error: 'devices_repo_not_available' });
      }
      
      const devices = await deps.devices.listForUser(params.userId);
      return reply.send({ devices });
    },
  );

  // DELETE /v1/admin/users/:userId/devices/:deviceToken
  // Deletes a device record, forcing re-enrollment
  app.delete(
    '/v1/admin/users/:userId/devices/:deviceToken',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const expected = process.env.ADMIN_TOKEN;
      if (!expected) {
        return reply.code(503).send({ error: 'admin_token_unset' });
      }
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'missing_bearer' });
      }
      const token = auth.slice('Bearer '.length).trim();
      if (token !== expected) {
        return reply.code(403).send({ error: 'bad_token' });
      }
      const params = req.params as { userId: string; deviceToken: string };
      if (!deps.devices) {
        return reply.code(501).send({ error: 'devices_repo_not_available' });
      }
      
      // Delete the device
      const result = await deps.devices.remove(params.deviceToken);
      
      // Log the admin action
      await deps.eventLog.record({
        eventType: 'admin.device_deleted',
        userId: params.userId,
        payload: { deviceToken: params.deviceToken.slice(0, 16) + '...' },
      });
      
      return reply.send({ ok: true, result, message: 'device deleted - user can re-enroll' });
    },
  );
}
