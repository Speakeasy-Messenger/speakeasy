import { FastifyInstance, preHandlerHookHandler } from 'fastify';
// Server-only subpath: `generateUserId` lives outside the package root
// because it pulls in `node:crypto` + the wordlists, which crash the
// React Native Metro bundler. See packages/shared/src/index.ts.
import { generateUserId } from '@speakeasy/shared/ids/generate';
import { VouchflowValidationError } from '@speakeasy/vouchflow';
import type { PreKeyBundleInput, UserRepo } from '../db/users.js';

interface EnrollBody {
  token: string;
  publicKey: string; // base64
  preKeyBundle: PreKeyBundleInput;
}

const MAX_ID_ATTEMPTS = 10;

export async function registerEnrollRoutes(
  app: FastifyInstance,
  opts: {
    repo: UserRepo;
    generateId?: () => string;
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
  const { repo, generateId = generateUserId } = opts;
  const preHandlers = opts.enrollRateLimit ? [opts.enrollRateLimit] : undefined;

  app.post<{ Body: EnrollBody }>(
    '/v1/enroll',
    {
      ...(preHandlers ? { preHandler: preHandlers } : {}),
      schema: {
        body: {
          type: 'object',
          required: ['token', 'publicKey', 'preKeyBundle'],
          properties: {
            token: { type: 'string', minLength: 1 },
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

      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
        const userId = generateId();
        const created = await repo.tryCreate({
          userId,
          publicKey: publicKeyBuf,
          bundle: preKeyBundle,
        });
        if (created) {
          // Sandbox-only: tell the dev validator about the new binding
          // so subsequent verifies (login, WS auth) recognize the user.
          // No-op in production where real Vouchflow tracks this.
          opts.onUserMinted?.(token, userId);
          return reply.code(201).send({ user_id: userId });
        }
      }

      request.log.error({ attempts: MAX_ID_ATTEMPTS }, 'exhausted id-generation attempts');
      return reply.code(503).send({ error: 'id_generation_failed' });
    },
  );
}
