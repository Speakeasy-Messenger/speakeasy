import { FastifyInstance } from 'fastify';
import { isUserId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { UserRepo } from '../db/users.js';

interface Params {
  id: string;
}

/**
 * Avatars are user-supplied base64 JPEGs. The mobile picker downsizes
 * to ~256px before upload, so a valid avatar is well under 100KB. Cap
 * at 200KB on the wire as defense in depth — anything larger almost
 * certainly came from a misbehaving client and we don't want it
 * occupying a Postgres TEXT column.
 */
const MAX_AVATAR_B64_LENGTH = 200_000;

interface AvatarBody {
  /** base64 JPEG, or empty string / null to clear. */
  avatar_b64: string | null;
}

/**
 * GET /v1/users/:id — public-key + existence + avatar lookup.
 * Vouchflow-gated to mitigate enumeration attacks; only authenticated
 * callers can probe.
 *
 * PUT /v1/users/me/avatar — set or clear the caller's avatar.
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
        avatar_b64: u.avatarB64 ?? null,
      });
    },
  );

  app.put<{ Body: AvatarBody }>(
    '/v1/users/me/avatar',
    {
      preHandler: requireAuth,
      schema: {
        body: {
          type: 'object',
          required: ['avatar_b64'],
          properties: {
            avatar_b64: {
              type: ['string', 'null'],
              maxLength: MAX_AVATAR_B64_LENGTH,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(401).send({ error: 'not_enrolled' });
      const raw = request.body.avatar_b64;
      const next = raw && raw.length > 0 ? raw : undefined;
      await opts.repo.setAvatar(userId, next);
      return reply.code(204).send();
    },
  );
}
