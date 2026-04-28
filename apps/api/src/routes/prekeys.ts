import { FastifyInstance } from 'fastify';
import { isUserId } from '@speakeasy/shared';
import { requireAuth } from '../auth/vouchflow.js';
import type { PreKey } from '../db/users.js';
import type { PreKeyRepo } from '../db/prekeys.js';
import { rateLimit } from '../ratelimit/middleware.js';
import type { RateLimiter } from '../ratelimit/ratelimit.js';
import { NoopUserNotifier, type UserNotifier } from '../ws/user-notifier.js';

/**
 * Spec §11 Phase 4 monitoring threshold. When `remaining_prekeys <
 * PREKEY_LOW_WATER`, server flags `low_water: true` so the bundle owner's
 * client can replenish without depleting.
 */
export const PREKEY_LOW_WATER = 10;

interface BundleBody {
  user_id: string;
}

interface ReplenishBody {
  signedPreKeyId: number;
  signedPreKey: string;
  signedPreKeySig: string;
  preKeys: PreKey[];
}

/**
 * Spec §11 Phase 2:
 *   POST /v1/prekeys/bundle      — fetch a peer's bundle (consumes one OTPK)
 *   POST /v1/prekeys/replenish   — caller uploads new prekeys (auth.userId)
 *
 * Phase 4: rate-limited. low_water signal in responses so callers can
 * proactively replenish.
 */
export async function registerPreKeyRoutes(
  app: FastifyInstance,
  opts: { repo: PreKeyRepo; limiter?: RateLimiter; notifier?: UserNotifier },
): Promise<void> {
  const notifier = opts.notifier ?? new NoopUserNotifier();
  const rateLimitBundle = opts.limiter
    ? [
        rateLimit({
          limiter: opts.limiter,
          endpoint: 'prekeys.bundle',
          limit: 60,
          windowMs: 60_000,
        }),
      ]
    : [];
  const rateLimitReplenish = opts.limiter
    ? [
        rateLimit({
          limiter: opts.limiter,
          endpoint: 'prekeys.replenish',
          limit: 10,
          windowMs: 60_000,
        }),
      ]
    : [];

  app.post<{ Body: BundleBody }>(
    '/v1/prekeys/bundle',
    {
      preHandler: [requireAuth, ...rateLimitBundle],
      schema: {
        body: {
          type: 'object',
          required: ['user_id'],
          properties: { user_id: { type: 'string', minLength: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { user_id } = request.body;
      if (!isUserId(user_id)) return reply.code(400).send({ error: 'invalid_id' });
      const bundle = await opts.repo.fetchBundleConsume(user_id);
      if (!bundle) return reply.code(404).send({ error: 'not_found' });
      const lowWater = bundle.remainingPreKeys < PREKEY_LOW_WATER;
      if (lowWater) {
        request.log.warn(
          { userId: user_id, remaining: bundle.remainingPreKeys },
          'prekey bundle below low_water threshold',
        );
        // Push to the *owner's* live sockets so they replenish. The
        // `low_water` flag in this response goes to the *fetcher* (peer),
        // who can't refill the owner's pool. Local-instance push only;
        // cross-instance variant is a Phase 5f follow-up.
        notifier.notify(user_id, {
          type: 'prekeys_low',
          remaining_prekeys: bundle.remainingPreKeys,
        });
      }
      return reply.send({
        user_id: bundle.userId,
        identity_public_key: bundle.identityPublicKey.toString('base64'),
        registration_id: bundle.registrationId,
        signed_prekey_id: bundle.signedPreKeyId,
        signed_prekey: bundle.signedPreKey.toString('base64'),
        signed_prekey_sig: bundle.signedPreKeySig.toString('base64'),
        one_time_prekey: bundle.oneTimePreKey,
        remaining_prekeys: bundle.remainingPreKeys,
        low_water: lowWater,
      });
    },
  );

  app.post<{ Body: ReplenishBody }>(
    '/v1/prekeys/replenish',
    {
      preHandler: [requireAuth, ...rateLimitReplenish],
      schema: {
        body: {
          type: 'object',
          required: ['signedPreKeyId', 'signedPreKey', 'signedPreKeySig', 'preKeys'],
          properties: {
            signedPreKeyId: { type: 'integer', minimum: 0 },
            signedPreKey: { type: 'string', minLength: 1 },
            signedPreKeySig: { type: 'string', minLength: 1 },
            preKeys: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                required: ['id', 'key'],
                properties: {
                  id: { type: 'integer', minimum: 0 },
                  key: { type: 'string', minLength: 1 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.auth?.userId;
      if (!userId) {
        return reply.code(403).send({ error: 'not_enrolled' });
      }
      try {
        await opts.repo.replenish({
          userId,
          signedPreKeyId: request.body.signedPreKeyId,
          signedPreKey: request.body.signedPreKey,
          signedPreKeySig: request.body.signedPreKeySig,
          preKeys: request.body.preKeys,
        });
      } catch (err) {
        request.log.error({ err, userId }, 'replenish failed');
        return reply.code(500).send({ error: 'internal' });
      }
      const remaining = await opts.repo.countRemaining(userId);
      return reply.code(200).send({
        remaining_prekeys: remaining,
        low_water: remaining < PREKEY_LOW_WATER,
      });
    },
  );
}
