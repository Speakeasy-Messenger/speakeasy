import { FastifyInstance } from 'fastify';
import { isUserId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { UserRepo } from '../db/users.js';

interface Params {
  id: string;
}

/**
 * Server-known animal ids. Mobile clients render the matching SVG;
 * unknown ids cause the client to fall back to a deterministic-from-
 * userId default. Centralized here so that:
 *   - The PUT route can reject ids the launch set doesn't include
 *     (typo guard, prevents a peer setting `selected_avatar_id =
 *     "i-am-an-elephant"` and breaking other clients' renders).
 *   - When we add a new animal in v2 we update this list and ship a
 *     new server build; old clients gracefully fall back rather than
 *     showing a black tile.
 */
/**
 * Canonical set lives in `apps/mobile/src/avatars/catalog.ts`. We
 * duplicate the ids here as a typo-guard only — server doesn't gate
 * ownership of paid avatars (RevenueCat does that on the client at
 * purchase time). Keep this list in sync when CATALOG changes;
 * rc.6 expanded it from 12 free animals to 12 free + 12 rare + 4
 * legendary, and renamed `raven` (free) → `pigeon`.
 */
const KNOWN_ANIMAL_IDS = new Set([
  // free 12
  'fox',
  'owl',
  'pigeon',
  'hare',
  'stag',
  'whale',
  'moth',
  'octopus',
  'heron',
  'bear',
  'cat',
  'bat',
  // rare 12
  'lynx',
  'koi',
  'raven',
  'frog',
  'snake',
  'peacock',
  'hawk',
  'squirrel',
  'crab',
  'beetle',
  'anglerfish',
  'seahorse',
  // legendary 4
  'dragon',
  'phoenix',
  'turtle',
  'manticore',
]);

interface AvatarBody {
  /** Animal id from the launch set, or null to clear. */
  animal_id: string | null;
}

/**
 * GET /v1/users/:id — public-key + existence + selected animal lookup.
 * Vouchflow-gated to mitigate enumeration attacks; only authenticated
 * callers can probe.
 *
 * PUT /v1/users/me/avatar — set or clear the caller's selected animal.
 *
 * AVATAR-SYSTEM.md §8 sunset note: this endpoint previously accepted a
 * `avatar_b64` JPEG payload. It now accepts an `animal_id` string from
 * the launch set. Server doesn't store JPEGs at all — `users.avatar_b64`
 * was dropped in migration 0009.
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
        selected_avatar_id: u.selectedAvatarId ?? null,
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
          required: ['animal_id'],
          properties: {
            animal_id: {
              // Bounded length, but the real validation is the
              // launch-set check below — the schema only protects us
              // against junk strings.
              type: ['string', 'null'],
              maxLength: 32,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) return reply.code(401).send({ error: 'not_enrolled' });
      const raw = request.body.animal_id;
      if (raw !== null && !KNOWN_ANIMAL_IDS.has(raw)) {
        return reply.code(400).send({ error: 'unknown_animal_id' });
      }
      await opts.repo.setSelectedAvatar(userId, raw ?? undefined);
      return reply.code(204).send();
    },
  );
}
