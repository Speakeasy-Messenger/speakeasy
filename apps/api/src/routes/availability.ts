import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { isFeedbackHandle, validateHandle } from '@speakeasy/shared';
import type { UserRepo } from '../db/users.js';

interface Query {
  id?: string;
}

/**
 * Public lookup so the onboarding screen can probe a candidate handle
 * before the user commits. Race-safe: two clients can both see "free"
 * and only one will win the atomic `repo.tryCreate` at enroll time —
 * the loser gets 409 from `POST /v1/enroll`.
 *
 * Rate-limited to discourage scraping the user namespace.
 */
export async function registerAvailabilityRoute(
  app: FastifyInstance,
  opts: {
    repo: UserRepo;
    rateLimit?: preHandlerHookHandler;
  },
): Promise<void> {
  const { repo } = opts;
  app.get<{ Querystring: Query }>(
    '/v1/users/availability',
    {
      ...(opts.rateLimit ? { preHandler: [opts.rateLimit] } : {}),
      schema: {
        querystring: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 32 } },
        },
      },
    },
    async (req, reply) => {
      const id = (req.query.id ?? '').trim().toLowerCase();
      // `@feedback` is a reserved handle used for in-app feedback (see
      // routes/feedback.ts). Surface it as `taken` so the FindSomeone
      // sheet treats it as found and lets the user open a chat —
      // mobile send path special-cases this peer and POSTs to
      // /v1/feedback instead of going through the encrypted WS path.
      if (isFeedbackHandle(id)) {
        return reply.send({ available: false, reason: 'taken' });
      }
      const reason = validateHandle(id);
      if (reason) {
        return reply.send({ available: false, reason });
      }
      const existing = await repo.findById(id);
      if (existing) {
        return reply.send({ available: false, reason: 'taken' });
      }
      return reply.send({ available: true });
    },
  );
}
