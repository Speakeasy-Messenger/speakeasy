import { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { validateHandle } from '@speakeasy/shared';
import { VouchflowValidationError } from '@speakeasy/vouchflow';
import type { PreKeyBundleInput, UserRepo } from '../db/users.js';

interface EnrollBody {
  token: string;
  /** User-chosen handle (no `@` prefix). Validated against the strict
   * `HANDLE_REGEX` + reserved set; on collision the route returns
   * `409 {error: 'taken'}` so the client can prompt for another. */
  user_id: string;
  publicKey: string; // base64
  preKeyBundle: PreKeyBundleInput;
}

export async function registerEnrollRoutes(
  app: FastifyInstance,
  opts: {
    repo: UserRepo;
    /** Optional Phase-4 rate-limit preHandler. Subject defaults to req.ip. */
    enrollRateLimit?: preHandlerHookHandler;
    /**
     * Sandbox-only hook: called after a successful mint with the
     * (deviceToken, userId) pair. Lets the in-memory dev validator
     * remember the binding for subsequent verifies. No-op in production
     * — real Vouchflow tracks this binding server-side.
     */
    onUserMinted?: (deviceToken: string, userId: string) => void;
  },
): Promise<void> {
  const { repo } = opts;
  const preHandlers = opts.enrollRateLimit ? [opts.enrollRateLimit] : undefined;

  app.post<{ Body: EnrollBody }>(
    '/v1/enroll',
    {
      ...(preHandlers ? { preHandler: preHandlers } : {}),
      schema: {
        body: {
          type: 'object',
          required: ['token', 'user_id', 'publicKey', 'preKeyBundle'],
          properties: {
            token: { type: 'string', minLength: 1 },
            user_id: { type: 'string', minLength: 3, maxLength: 20 },
            publicKey: { type: 'string', minLength: 1 },
            preKeyBundle: {
              type: 'object',
              required: [
                'registrationId',
                'signedPreKeyId',
                'signedPreKey',
                'signedPreKeySig',
                'preKeys',
              ],
              properties: {
                registrationId: { type: 'integer', minimum: 0 },
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
      },
    },
    async (request, reply) => {
      const { token, publicKey, preKeyBundle } = request.body;
      const userId = request.body.user_id.trim().toLowerCase();

      const handleReason = validateHandle(userId);
      if (handleReason === 'invalid') {
        return reply.code(400).send({ error: 'invalid_user_id' });
      }
      if (handleReason === 'reserved') {
        return reply.code(409).send({ error: 'reserved' });
      }

      try {
        await app.vouchflow.validate(token);
      } catch (err) {
        if (err instanceof VouchflowValidationError) {
          return reply.code(401).send({ error: err.reason });
        }
        request.log.error({ err }, 'unexpected vouchflow error during enroll');
        return reply.code(500).send({ error: 'internal' });
      }

      const publicKeyBuf = Buffer.from(publicKey, 'base64');

      const created = await repo.tryCreate({
        userId,
        deviceToken: token,
        publicKey: publicKeyBuf,
        bundle: preKeyBundle,
      });
      if (!created) {
        return reply.code(409).send({ error: 'taken' });
      }

      // Sandbox-only: tell the dev validator about the new binding so
      // subsequent verifies (login, WS auth) recognize the user. No-op
      // in production where real Vouchflow tracks this.
      opts.onUserMinted?.(token, userId);
      return reply.code(201).send({ user_id: userId });
    },
  );
}
