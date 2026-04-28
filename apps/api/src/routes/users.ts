import { FastifyInstance } from 'fastify';
import { isUserId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { UserRepo } from '../db/users.js';

interface Params {
  id: string;
}

/**
 * GET /v1/users/:id — public-key + existence lookup. Vouchflow-gated to
 * mitigate enumeration attacks; only authenticated callers can probe.
 */
export async function registerUserRoutes(
  app: FastifyInstance,
  opts: { repo: UserRepo },
): Promise<void> {
  app.get<{ Params: Params }>(
    '/v1/users/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = request.params.id;
      if (!isUserId(id)) {
        return reply.code(400).send({ error: 'invalid_id' });
      }
      const u = await opts.repo.findById(id);
      if (!u) return reply.code(404).send({ error: 'not_found' });
      return reply.send({
        id: u.id,
        public_key: u.publicKey.toString('base64'),
        created_at: u.createdAt.toISOString(),
      });
    },
  );
}
